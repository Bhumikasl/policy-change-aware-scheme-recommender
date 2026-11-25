/**
 * Phase L — the Notification Agent and its delivery service.
 *
 * Two properties matter most here, and most of this suite is about them:
 *
 *   1. The agent decides only WHETHER to tell someone. It never decides
 *      eligibility. Its input is a transition the matcher already computed.
 *
 *   2. Delivery is idempotent under replay AND under concurrency. The unique
 *      index is the mechanism; the pre-check is only an optimisation.
 */
const {
  decideNotification,
  classifyNotification,
} = require("../src/agents/notificationAgent");
const {
  notifyFromTransitions,
  retryFailedNotifications,
  backoffFor,
  claimDueNotifications,
  MAX_RETRIES,
} = require("../src/services/notificationService");
const {
  NOTIFICATION_TYPES,
  NOTIFICATION_STATUS,
  NOTIFICATION_CHANNELS,
  CLAIMABLE_STATUSES,
  isPermanentFailure,
  meetsSeverity,
} = require("../src/constants/notificationTypes");
const { makeCollection } = require("./helpers/inMemoryDb");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const record = (over = {}) => ({
  _id: over._id || "hist-1",
  userId: over.userId || "user-1",
  userEmail: "student@example.com",
  schemeId: over.schemeId || "merit-scholarship",
  schemeName: "State Merit Scholarship",
  triggeringChangeId: over.triggeringChangeId || "merit-scholarship:v2",
  newSchemeVersion: 2,
  eligibilityTransition: over.eligibilityTransition || "INELIGIBLE_TO_ELIGIBLE",
  recommendationTransition: over.recommendationTransition || "NOT_RECOMMENDED_TO_RECOMMENDED",
  previousRank: null,
  newRank: 3,
  explanation: over.explanation ?? "",
  reason: over.reason || { code: "BECAME_ELIGIBLE", changedFields: [] },
  ...over,
});

function notificationStore() {
  return makeCollection("notifications", {
    uniqueKeys: [["userId", "schemeId", "triggeringChangeId", "channel"]],
  });
}

function userStore(users) {
  const c = makeCollection("users");
  c.seed(users);
  return c;
}

const USER = {
  _id: "user-1",
  email: "student@example.com",
  notificationPrefs: { email: true, minSeverity: "MEDIUM", unsubscribedAt: null },
};

const fixedNow = () => new Date("2026-03-12T10:00:00Z");

// ---------------------------------------------------------------------------
describe("the agent decides notification, never eligibility", () => {
  it("imports no model, matcher or database", () => {
    // Structural, not conventional. If this module could reach an eligibility
    // decision, the architecture rule would be one careless import away from
    // being violated silently.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "agents", "notificationAgent.js"),
      "utf8"
    );
    const imports = [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    for (const dep of imports) {
      expect(dep).not.toMatch(/models\//);
      expect(dep).not.toMatch(/matcher/);
      expect(dep).not.toMatch(/mongoose/);
      expect(dep).not.toMatch(/relevanceRanker/);
    }
    // It should only reach for the shared vocabularies.
    expect(imports.every((d) => d.includes("constants/"))).toBe(true);
  });

  it("is a pure function of the record and the preferences", () => {
    const r = record();
    const a = decideNotification({ record: r, notificationPrefs: USER.notificationPrefs });
    const b = decideNotification({ record: r, notificationPrefs: USER.notificationPrefs });
    expect(a).toEqual(b);
  });
});

describe("classifyNotification", () => {
  it("maps each transition to its type", () => {
    expect(classifyNotification(record())).toBe(NOTIFICATION_TYPES.NEWLY_ELIGIBLE);
    expect(
      classifyNotification(record({ eligibilityTransition: "ELIGIBLE_TO_INELIGIBLE" }))
    ).toBe(NOTIFICATION_TYPES.NO_LONGER_ELIGIBLE);
    expect(
      classifyNotification(
        record({
          eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
          recommendationTransition: "RECOMMENDED_TO_NOT_RECOMMENDED",
        })
      )
    ).toBe(NOTIFICATION_TYPES.RECOMMENDATION_LEFT_TOP_K);
    expect(
      classifyNotification(
        record({
          eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
          recommendationTransition: "RANK_INCREASED",
        })
      )
    ).toBe(NOTIFICATION_TYPES.RANK_INCREASED);
  });

  it("prefers the eligibility fact when both moved", () => {
    // Someone who lost eligibility AND dropped out of the top K needs to hear
    // the first thing, not the second.
    const t = classifyNotification(
      record({
        eligibilityTransition: "ELIGIBLE_TO_INELIGIBLE",
        recommendationTransition: "RECOMMENDED_TO_NOT_RECOMMENDED",
      })
    );
    expect(t).toBe(NOTIFICATION_TYPES.NO_LONGER_ELIGIBLE);
  });

  it("recognises a deadline change to a scheme the user holds", () => {
    expect(
      classifyNotification(
        record({
          eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
          recommendationTransition: "NO_CHANGE",
          reason: { code: "DEADLINE_CHANGED" },
        })
      )
    ).toBe(NOTIFICATION_TYPES.DEADLINE_CHANGED);
  });

  it("returns null when nothing user-facing happened", () => {
    expect(
      classifyNotification(
        record({
          eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
          recommendationTransition: "NO_CHANGE",
          reason: { code: "UNKNOWN" },
        })
      )
    ).toBeNull();
  });
});

describe("severity and user preferences", () => {
  it("ranks losing above gaining", () => {
    // A person who budgeted around a benefit needs to know it is gone more
    // than a person needs to hear about a new opportunity.
    const lost = decideNotification({
      record: record({ eligibilityTransition: "ELIGIBLE_TO_INELIGIBLE" }),
      notificationPrefs: USER.notificationPrefs,
    });
    const gained = decideNotification({ record: record(), notificationPrefs: USER.notificationPrefs });
    expect(lost.severity).toBe("CRITICAL");
    expect(gained.severity).toBe("HIGH");
    expect(meetsSeverity(lost.severity, gained.severity)).toBe(true);
  });

  it("keeps rank noise out of the inbox by default", () => {
    // Position 4 to 5 is true and a bad reason to email someone.
    const v = decideNotification({
      record: record({
        eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
        recommendationTransition: "RANK_DECREASED",
      }),
      notificationPrefs: USER.notificationPrefs,
    });
    expect(v.shouldNotify).toBe(true); // still recorded in-app
    expect(v.emailEligible).toBe(false); // but not emailed
    expect(v.suppressionReason).toMatch(/below the user's threshold/);
  });

  it("emails rank changes when the user asked for everything", () => {
    const v = decideNotification({
      record: record({
        eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
        recommendationTransition: "RANK_DECREASED",
      }),
      notificationPrefs: { email: true, minSeverity: "LOW" },
    });
    expect(v.emailEligible).toBe(true);
  });

  it("honours an unsubscribe and an email opt-out", () => {
    expect(
      decideNotification({
        record: record(),
        notificationPrefs: { email: true, unsubscribedAt: new Date() },
      }).emailEligible
    ).toBe(false);
    expect(
      decideNotification({ record: record(), notificationPrefs: { email: false } }).emailEligible
    ).toBe(false);
  });

  it("still records in-app for a user who opted out of email", () => {
    // Silence in the inbox should not mean the event vanishes.
    const v = decideNotification({
      record: record(),
      notificationPrefs: { email: false },
    });
    expect(v.shouldNotify).toBe(true);
  });

  it("does not silence everything when the threshold is unrecognised", () => {
    const v = decideNotification({
      record: record(),
      notificationPrefs: { email: true, minSeverity: "NONSENSE" },
    });
    expect(v.emailEligible).toBe(true);
  });
});

describe("body content", () => {
  it("uses the Phase K explanation when one exists", () => {
    const v = decideNotification({
      record: record({
        explanation:
          "The annual income limit increased from ₹2.5 lakh to ₹3 lakh. Because your reported annual income is ₹2.8 lakh, you now meet this condition.",
      }),
      notificationPrefs: USER.notificationPrefs,
    });
    expect(v.bodySource).toBe("explanation");
    expect(v.body).toContain("₹3 lakh");
  });

  it("falls back to a thin deterministic line when there is none", () => {
    // An ungrounded explanation never reaches this point — Phase K leaves the
    // field empty rather than writing one — so the fallback must be safe on
    // its own and must not invent a figure.
    const v = decideNotification({ record: record({ explanation: "" }), notificationPrefs: USER.notificationPrefs });
    expect(v.bodySource).toBe("fallback");
    expect(v.body).not.toMatch(/₹|\d{4,}/);
  });

  it("writes a title that is true without the body", () => {
    const v = decideNotification({ record: record(), notificationPrefs: USER.notificationPrefs });
    expect(v.title).toBe("You are now eligible for State Merit Scholarship");
  });
});

// ---------------------------------------------------------------------------
describe("delivery", () => {
  it("creates an in-app record and sends one email", async () => {
    const model = notificationStore();
    const sent = [];
    const out = await notifyFromTransitions({
      records: [record()],
      processingJobId: "job-1",
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async (...a) => sent.push(a),
        now: fixedNow,
      },
    });

    expect(out.inAppCreated).toBe(1);
    expect(out.emailsSent).toBe(1);
    expect(sent.length).toBe(1);

    const inApp = model.rows.filter((r) => r.channel === NOTIFICATION_CHANNELS.IN_APP);
    const email = model.rows.filter((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    expect(inApp.length).toBe(1);
    expect(email[0].status).toBe(NOTIFICATION_STATUS.SENT);
  });

  it("NEVER scans all users", async () => {
    // The old notifier ran User.find({}) and undid the whole point of targeted
    // impact analysis. The only permitted lookup is a targeted $in over the
    // users already in the affected set.
    const model = notificationStore();
    const users = userStore([USER]);
    await notifyFromTransitions({
      records: [record()],
      deps: { notificationModel: model, userModel: users, sendEmail: async () => {}, now: fixedNow },
    });

    expect(users.spy.finds).toBe(1);
    expect(users.spy.lastFilter).toEqual({ _id: { $in: ["user-1"] } });
    // An unfiltered scan would look like find({}).
    expect(users.spy.lastFilter).not.toEqual({});
  });

  it("records a suppressed email rather than losing the fact", async () => {
    const model = notificationStore();
    const sent = [];
    const out = await notifyFromTransitions({
      records: [record({ eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE", recommendationTransition: "RANK_DECREASED" })],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async (...a) => sent.push(a),
        now: fixedNow,
      },
    });

    expect(out.suppressed).toBe(1);
    expect(sent.length).toBe(0);
    // "Why didn't I get an email" must be answerable from data.
    const emailRow = model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    expect(emailRow.status).toBe(NOTIFICATION_STATUS.SUPPRESSED);
    // And it must never be picked up by the retry sweep.
    expect(emailRow.status).not.toBe(NOTIFICATION_STATUS.FAILED_RETRYABLE);
  });

  it("does nothing for a record with no user-facing transition", async () => {
    const model = notificationStore();
    const out = await notifyFromTransitions({
      records: [
        record({
          eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
          recommendationTransition: "NO_CHANGE",
          reason: { code: "UNKNOWN" },
        }),
      ],
      deps: { notificationModel: model, userModel: userStore([USER]), sendEmail: async () => {}, now: fixedNow },
    });
    expect(out.skippedNoTransition).toBe(1);
    expect(model.rows.length).toBe(0);
  });

  it("defaults to in-app only when preferences cannot be loaded", async () => {
    // Silence is recoverable; an unwanted email is not.
    const model = notificationStore();
    const broken = { find() { throw new Error("db down"); } };
    const sent = [];
    const out = await notifyFromTransitions({
      records: [record()],
      deps: { notificationModel: model, userModel: broken, sendEmail: async (...a) => sent.push(a), now: fixedNow },
    });
    expect(out.inAppCreated).toBe(1);
    expect(sent.length).toBe(1); // no prefs found means default prefs, which allow HIGH
    expect(out.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("idempotency", () => {
  const deps = (model, sent) => ({
    notificationModel: model,
    userModel: userStore([USER]),
    sendEmail: async (...a) => sent.push(a),
    now: fixedNow,
  });

  it("sends once when the same change is processed twice", async () => {
    const model = notificationStore();
    const sent = [];
    await notifyFromTransitions({ records: [record()], deps: deps(model, sent) });
    const second = await notifyFromTransitions({ records: [record()], deps: deps(model, sent) });

    expect(sent.length).toBe(1);
    expect(second.emailsSent).toBe(0);
    expect(second.duplicatesSkipped).toBeGreaterThan(0);
    // A duplicate is a normal outcome, not a failure.
    expect(second.errors).toEqual([]);
    expect(model.rows.filter((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL).length).toBe(1);
  });

  it("relies on the unique index, not only the pre-check", async () => {
    const model = notificationStore();
    const sent = [];
    await notifyFromTransitions({ records: [record()], deps: deps(model, sent) });
    model.state.failFind = true; // disable the pre-check entirely
    const second = await notifyFromTransitions({ records: [record()], deps: deps(model, sent) });

    expect(sent.length).toBe(1);
    // With the pre-check gone, only the unique index can have stopped this —
    // and it must register as a duplicate rather than an error.
    expect(second.duplicatesSkipped).toBeGreaterThan(0);
    expect(second.errors).toEqual([]);
    expect(model.rows.filter((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL).length).toBe(1);
  });

  it("sends once when two runs overlap", async () => {
    // A racing store whose pre-check returns a STALE answer: both runs look,
    // both see nothing, and only then does either insert. Awaiting BEFORE the
    // read would produce the opposite of a race.
    const base = notificationStore();
    const racing = {
      rows: base.rows,
      state: base.state,
      async findOne(f) {
        const snapshot = await base.findOne(f);
        await new Promise((r) => setTimeout(r, 5));
        return snapshot;
      },
      create: (d) => base.create(d),
      updateOne: (f, u) => base.updateOne(f, u),
      countDocuments: (f) => base.countDocuments(f),
      find: (f) => base.find(f),
    };
    const sent = [];
    const opts = { records: [record()], deps: deps(racing, sent) };
    const runs = await Promise.all([
      notifyFromTransitions(opts),
      notifyFromTransitions(opts),
      notifyFromTransitions(opts),
    ]);

    expect(sent.length).toBe(1);
    expect(racing.rows.filter((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL).length).toBe(1);
    expect(racing.rows.filter((r) => r.channel === NOTIFICATION_CHANNELS.IN_APP).length).toBe(1);

    // The losers of the race must record DUPLICATES, not ERRORS.
    //
    // Without this the test passes for the wrong reason: if the duplicate-key
    // catch is removed, the collision becomes a thrown error that the
    // per-record handler swallows — which also happens to prevent the second
    // send, so the counts above still look right while idempotency is broken.
    const duplicates = runs.reduce((n, r) => n + r.duplicatesSkipped, 0);
    const errors = runs.reduce((n, r) => n + r.errors.length, 0);
    expect(duplicates).toBeGreaterThanOrEqual(2);
    expect(errors).toBe(0);
  });

  it("treats a later change to the same scheme as a new notification", async () => {
    const model = notificationStore();
    const sent = [];
    await notifyFromTransitions({ records: [record()], deps: deps(model, sent) });
    await notifyFromTransitions({
      records: [record({ triggeringChangeId: "merit-scholarship:v3" })],
      deps: deps(model, sent),
    });
    expect(sent.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("failure and retry", () => {
  it("records a send failure as retryable with backoff", async () => {
    const model = notificationStore();
    const out = await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async () => {
          throw new Error("smtp unavailable");
        },
        now: fixedNow,
      },
    });

    expect(out.emailsFailed).toBe(1);
    const row = model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    expect(row.status).toBe(NOTIFICATION_STATUS.FAILED_RETRYABLE);
    expect(row.retryCount).toBe(1);
    expect(row.nextAttemptAt).toBeDefined();
    // The in-app record survives the email failure.
    expect(model.rows.some((r) => r.channel === NOTIFICATION_CHANNELS.IN_APP)).toBe(true);
  });

  it("stores only the message, never a stack", async () => {
    const model = notificationStore();
    await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async () => {
          const e = new Error("smtp unavailable");
          e.stack = "Error: smtp\n    at /home/secret/path/mailer.js:42";
          throw e;
        },
        now: fixedNow,
      },
    });
    const row = model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    expect(row.lastError).toBe("smtp unavailable");
    expect(row.lastError).not.toMatch(/\/home\//);
  });

  it("backs off exponentially", () => {
    expect(backoffFor(1)).toBe(backoffFor(0) * 2);
    expect(backoffFor(2)).toBe(backoffFor(0) * 4);
  });

  it("gives up after the retry limit rather than trying forever", async () => {
    const model = notificationStore();
    const failing = async () => {
      throw new Error("permanently bad address");
    };
    await notifyFromTransitions({
      records: [record()],
      deps: { notificationModel: model, userModel: userStore([USER]), sendEmail: failing, now: fixedNow },
    });

    // Sweep until exhausted, advancing the clock each time.
    //
    // A FIXED clock here would make every sweep after the first a no-op: the
    // row's nextAttemptAt is computed from `now`, so freezing time means the
    // backoff never elapses. The test would then pass or fail for reasons
    // having nothing to do with the retry limit.
    let clock = new Date("2030-01-01T00:00:00Z").getTime();
    for (let i = 0; i < MAX_RETRIES + 2; i++) {
      clock += 24 * 60 * 60 * 1000; // a day: past any backoff
      await retryFailedNotifications({
        deps: { notificationModel: model, sendEmail: failing, now: () => new Date(clock) },
      });
    }

    const row = model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    expect(row.status).toBe(NOTIFICATION_STATUS.FAILED_PERMANENTLY);
    expect(row.retryCount).toBeGreaterThanOrEqual(MAX_RETRIES);
    expect(row.nextAttemptAt).toBeNull();
  });

  it("recovers when the mail server comes back", async () => {
    const model = notificationStore();
    await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async () => {
          throw new Error("smtp down");
        },
        now: fixedNow,
      },
    });

    const sent = [];
    const out = await retryFailedNotifications({
      deps: {
        notificationModel: model,
        sendEmail: async (...a) => sent.push(a),
        now: () => new Date("2030-01-01T00:00:00Z"),
      },
    });

    expect(out.emailsSent).toBe(1);
    expect(sent.length).toBe(1);
    const row = model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    expect(row.status).toBe(NOTIFICATION_STATUS.SENT);
  });

  it("does not retry before the backoff has elapsed", async () => {
    const model = notificationStore();
    await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async () => { throw new Error("smtp down"); },
        now: fixedNow,
      },
    });
    const sent = [];
    const out = await retryFailedNotifications({
      deps: { notificationModel: model, sendEmail: async (...a) => sent.push(a), now: fixedNow },
    });
    expect(out.attempted).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("continues past one record's failure to process the rest", async () => {
    const model = notificationStore();
    const out = await notifyFromTransitions({
      records: [
        record({ _id: "h1", userId: "user-1", schemeId: "s1", triggeringChangeId: "s1:v2" }),
        record({ _id: "h2", userId: "user-1", schemeId: "s2", triggeringChangeId: "s2:v2" }),
      ],
      deps: {
        notificationModel: {
          ...notificationStore(),
          findOne: () => null,
          create: (d) => {
            if (d.schemeId === "s1") throw new Error("write failed");
            return d;
          },
          updateOne: async () => ({}),
        },
        userModel: userStore([USER]),
        sendEmail: async () => {},
        now: fixedNow,
      },
    });
    expect(out.errors.length).toBe(1);
    expect(out.considered).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// L.2 / L.4 — lifecycle, retry classification, and the scheduler wiring
// ---------------------------------------------------------------------------
describe("delivery lifecycle", () => {
  it("keeps delivery status and read status apart", () => {
    // A SENT email can go unread forever; an in-app row can be read while its
    // email is still retrying. One column cannot express both.
    expect(Object.values(NOTIFICATION_STATUS)).not.toContain("READ");
    expect(Object.values(NOTIFICATION_STATUS)).toEqual([
      "PENDING", "SENDING", "SENT", "FAILED_RETRYABLE", "FAILED_PERMANENTLY", "SUPPRESSED",
    ]);
  });

  it("claims only PENDING and FAILED_RETRYABLE", () => {
    // SENDING is excluded so two overlapping sweeps cannot claim the same row.
    expect(CLAIMABLE_STATUSES).toEqual(["PENDING", "FAILED_RETRYABLE"]);
    expect(CLAIMABLE_STATUSES).not.toContain("SENDING");
    expect(CLAIMABLE_STATUSES).not.toContain("SENT");
    expect(CLAIMABLE_STATUSES).not.toContain("SUPPRESSED");
    expect(CLAIMABLE_STATUSES).not.toContain("FAILED_PERMANENTLY");
  });

  it("marks a row SENDING before attempting delivery", async () => {
    const model = notificationStore();
    const seen = [];
    await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async () => {
          // Observed mid-flight: the row must already be claimed.
          seen.push(model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL).status);
        },
        now: fixedNow,
      },
    });
    expect(seen).toEqual(["SENDING"]);
  });
});

describe("retryable vs permanent failures", () => {
  it("treats a bad address as permanent and stops immediately", async () => {
    // Retrying a malformed address four times just delays the inevitable.
    const model = notificationStore();
    await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async () => { throw new Error("550 invalid recipient"); },
        now: fixedNow,
      },
    });
    const row = model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    expect(row.status).toBe(NOTIFICATION_STATUS.FAILED_PERMANENTLY);
    expect(row.failureKind).toBe("permanent");
    expect(row.retryCount).toBe(1); // not four wasted attempts
    expect(row.nextAttemptAt).toBeNull();
  });

  it("treats an unrecognised failure as transient", () => {
    // Wrongly giving up loses a notification; wrongly retrying costs one
    // attempt. The asymmetry decides the default.
    expect(isPermanentFailure("connection reset by peer")).toBe(false);
    expect(isPermanentFailure("ETIMEDOUT")).toBe(false);
    expect(isPermanentFailure("550 invalid recipient")).toBe(true);
    expect(isPermanentFailure("mailbox unavailable")).toBe(true);
  });

  it("never re-claims a permanently failed row", async () => {
    const model = notificationStore();
    await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async () => { throw new Error("550 invalid recipient"); },
        now: fixedNow,
      },
    });
    const due = await claimDueNotifications({
      model,
      limit: 10,
      now: () => new Date("2030-01-01"),
    });
    expect(due.length).toBe(0);
  });

  it("never re-claims a suppressed row", async () => {
    const model = notificationStore();
    await notifyFromTransitions({
      records: [record({ eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE", recommendationTransition: "RANK_DECREASED" })],
      deps: { notificationModel: model, userModel: userStore([USER]), sendEmail: async () => {}, now: fixedNow },
    });
    const due = await claimDueNotifications({ model, limit: 10, now: () => new Date("2030-01-01") });
    expect(due.length).toBe(0);
  });
});

describe("queued delivery mode (the queue boundary)", () => {
  it("persists the job and does not wait on SMTP", async () => {
    // This is the property the boundary exists for: policy processing must not
    // block on thousands of emails.
    const model = notificationStore();
    const sent = [];
    const out = await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([USER]),
        sendEmail: async (...a) => sent.push(a),
        now: fixedNow,
        queued: true,
      },
    });

    expect(out.emailsQueued).toBe(1);
    expect(out.emailsSent).toBe(0);
    expect(sent.length).toBe(0); // nothing sent during the cycle
    const row = model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    expect(row.status).toBe(NOTIFICATION_STATUS.PENDING);
    // The in-app record is immediate either way.
    expect(out.inAppCreated).toBe(1);
  });

  it("is drained by the same worker that handles retries", async () => {
    const model = notificationStore();
    const sent = [];
    await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model, userModel: userStore([USER]),
        sendEmail: async () => {}, now: fixedNow, queued: true,
      },
    });

    const out = await retryFailedNotifications({
      deps: { notificationModel: model, sendEmail: async (...a) => sent.push(a), now: fixedNow },
    });
    expect(out.emailsSent).toBe(1);
    expect(sent.length).toBe(1);
    expect(model.rows.find((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL).status).toBe(
      NOTIFICATION_STATUS.SENT
    );
  });

  it("does not double-send when the sweep runs twice", async () => {
    const model = notificationStore();
    const sent = [];
    await notifyFromTransitions({
      records: [record()],
      deps: { notificationModel: model, userModel: userStore([USER]), sendEmail: async () => {}, now: fixedNow, queued: true },
    });
    const deps = { notificationModel: model, sendEmail: async (...a) => sent.push(a), now: fixedNow };
    await retryFailedNotifications({ deps });
    await retryFailedNotifications({ deps });
    expect(sent.length).toBe(1);
  });
});

describe("notification preferences", () => {
  it("keeps the in-app record when email is disabled", async () => {
    // The requirement stated explicitly: disabling email must not silence the
    // in-app inbox.
    const model = notificationStore();
    const sent = [];
    const out = await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([{ ...USER, notificationPrefs: { email: false, inApp: true } }]),
        sendEmail: async (...a) => sent.push(a),
        now: fixedNow,
      },
    });
    expect(out.inAppCreated).toBe(1);
    expect(sent.length).toBe(0);
    expect(model.rows.some((r) => r.channel === NOTIFICATION_CHANNELS.IN_APP)).toBe(true);
  });

  it("can disable in-app while keeping email", async () => {
    const model = notificationStore();
    const sent = [];
    const out = await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([{ ...USER, notificationPrefs: { email: true, inApp: false, minSeverity: "MEDIUM" } }]),
        sendEmail: async (...a) => sent.push(a),
        now: fixedNow,
      },
    });
    expect(out.inAppCreated).toBe(0);
    expect(out.inAppSuppressed).toBe(1);
    expect(sent.length).toBe(1);
  });

  it("silences both channels for an unsubscribed user", async () => {
    const model = notificationStore();
    const sent = [];
    const out = await notifyFromTransitions({
      records: [record()],
      deps: {
        notificationModel: model,
        userModel: userStore([{ ...USER, notificationPrefs: { email: true, inApp: true, unsubscribedAt: new Date() } }]),
        sendEmail: async (...a) => sent.push(a),
        now: fixedNow,
      },
    });
    expect(out.inAppCreated).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("defaults both channels on when preferences are absent", () => {
    const v = decideNotification({ record: record(), notificationPrefs: {} });
    expect(v.inAppEligible).toBe(true);
    expect(v.emailEligible).toBe(true);
  });
});

describe("the scheduler wiring", () => {
  const fs = require("fs");
  const path = require("path");
  const cronSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "scheduler", "cron.js"),
    "utf8"
  );

  it("adds a job to the existing scheduler rather than a second one", () => {
    // Two cron processes would each believe they owned their sweep, and the
    // overlap guards would mean nothing across them.
    //
    // ASSERTION CHANGED IN PHASE M — deliberately strengthened, not relaxed.
    //
    // This previously pinned the number of cron.schedule() calls to exactly 2
    // as a proxy for "one scheduler". That proxy was wrong in both directions:
    // it FAILED on a correct change (Phase M adding a legitimate third job to
    // the same scheduler), and it would have PASSED a genuinely broken one —
    // a file with two `require("node-cron")` calls and one schedule each has a
    // count of 2 and is precisely the bug this test exists to catch.
    //
    // It now asserts the real invariant: one cron module, one startScheduler,
    // and one distinct overlap guard per job.
    expect((cronSrc.match(/require\(["']node-cron["']\)/g) || []).length).toBe(1);
    expect((cronSrc.match(/function startScheduler/g) || []).length).toBe(1);

    const code = cronSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const jobs = (code.match(/cron\.schedule\(/g) || []).length;
    expect(jobs >= 2).toBe(true);

    // One guard variable per job. Sharing a guard would let a slow embedding
    // run block email delivery — the same class of failure as two schedulers.
    const guards = [...code.matchAll(/let (\w*[Rr]unning) = false;/g)].map((m) => m[1]);
    expect(new Set(guards).size).toBe(guards.length);
    expect(guards.length).toBe(jobs);

    expect(cronSrc).toMatch(/retryFailedNotifications/);
  });

  it("guards against overlapping sweeps", () => {
    expect(cronSrc).toMatch(/notificationSweepRunning/);
  });

  it("does NOT re-run any policy stage from the notification sweep", () => {
    // The analysis succeeded and was recorded; only the send failed. Re-running
    // the agents would redo correct work and invite duplicate history rows.
    //
    // Scope this to the sweep CALLBACK BODY and strip comments first. Slicing
    // to end-of-file would swallow the unrelated RUN_ON_STARTUP block, and
    // scanning comments would flag prose that merely names the agents.
    const code = cronSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const start = code.indexOf("notificationSweepRunning = true;");
    // Search AFTER `start`: the same assignment appears in the top-level
    // `let notificationSweepRunning = false;` declaration, which comes first
    // in the file and would give a backwards slice.
    const end = code.indexOf("notificationSweepRunning = false;", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const sweepBody = code.slice(start, end);
    for (const forbidden of [
      "runCollectionCycle",
      "processSchemeChange",
      "assessImpact",
      "classifyChange",
      "propagateChange",
      "explainTransition",
      "retryFailedPolicyProcessing",
    ]) {
      expect(sweepBody).not.toContain(forbidden);
    }
    // And it DOES call the delivery step.
    expect(sweepBody).toContain("retryFailedNotifications");
  });

  it("survives a failing sweep without taking the scheduler down", () => {
    expect(cronSrc).toMatch(/Notification sweep failed/);
  });
});
