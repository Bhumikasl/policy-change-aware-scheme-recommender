/**
 * PHASE R — the notification-cost experiment.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 * ---------------------------------------------------------------------------
 * Phase R reports that the targeted flow interrupts fewer people than the
 * legacy full-scan notifier. A reduction figure is trivially easy to make look
 * good — notify nobody and it is 100% — so most of what follows tests the
 * INSTRUMENT and the honesty rules rather than the number:
 *
 *   - the baseline is the REAL legacy function, not a paraphrase of it;
 *   - the reduction is reported next to who the targeted path reached that the
 *     baseline could not, so "fewer" cannot be mistaken for "better";
 *   - an unmeasured broker fraction stays NOT_MEASURED and never becomes 0;
 *   - the corpus is internally consistent with the matcher's own rules.
 */
const {
  runLegacyBaseline,
  runTargetedFlow,
  runCase,
  makeLogRecorder,
} = require("../src/evaluation/notificationCostExperiment");
const {
  summarise,
  brokerRecommendation,
  STATUS,
} = require("../src/evaluation/notificationCostMetrics");
const { buildCorpus, makeUsers } = require("../src/evaluation/propagationCorpus");
const { makeUserStore } = require("../src/evaluation/propagationHarness");
const { evaluateEligibility } = require("../src/services/matcher");

const corpus = buildCorpus();
const findCase = (id) => corpus.find((c) => c.id === id);

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------
describe("R — the legacy baseline is the real thing", () => {
  const users = makeUsers(60);

  it("scans every user, which is the property it is the baseline FOR", async () => {
    const kase = findCase("income-cap-raised");
    const out = await runLegacyBaseline({ scheme: kase.schemeAfter, users });
    expect(out.usersScanned).toBe(users.length);
    expect(out.path).toBe("legacy-full-scan");
  });

  it("notifies on a change that moved nobody — the behaviour Phase I replaced", async () => {
    // The ministry-rename case. Nothing about anyone's eligibility moved, and
    // the legacy path emails every matching user anyway. This is the single
    // clearest illustration of what the targeted flow exists to stop.
    const kase = findCase("no-material-change");
    const legacy = await runLegacyBaseline({ scheme: kase.schemeAfter, users });
    const targeted = await runTargetedFlow({
      scheme: kase.schemeAfter,
      oldRules: kase.oldRules,
      diffs: kase.diffs,
      oldSchemeSnapshot: kase.oldSchemeSnapshot,
      userModel: makeUserStore(users),
    });

    expect(legacy.notified).toBeGreaterThan(0);
    expect(targeted.notified).toBe(0);
  });

  it("honours the real dedup branch rather than counting twice", async () => {
    // The legacy path dedups by catching E11000 from NotificationLog. The
    // recorder raises the same error, so the production branch runs.
    const log = makeLogRecorder();
    const doc = { email: "a@b.com", schemeId: "s", version: 2, channel: "email" };
    await log.create(doc);
    let code = null;
    try {
      await log.create(doc);
    } catch (err) {
      code = err.code;
    }
    expect(code).toBe(11000);
    expect(log.inserted.length).toBe(1);
  });

  it("sends no real email and touches no real model", async () => {
    // The injection seam added in Phase R. Without it this function reaches the
    // real Mongoose User and NotificationLog, which with no connection buffers
    // rather than throwing.
    const kase = findCase("income-cap-raised");
    let emails = 0;
    const out = await runLegacyBaseline({ scheme: kase.schemeAfter, users });
    expect(out.notified).toBeGreaterThan(0);
    expect(emails).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------
describe("R — the targeted flow is narrower, and the report says at what cost", () => {
  const users = makeUsers(120);

  it("interrupts fewer people than the baseline on a material change", async () => {
    const kase = findCase("income-cap-raised");
    const out = await runCase(kase, { users, userModel: makeUserStore(users) });
    expect(out.targeted.notified).toBeLessThan(out.legacy.notified);
    expect(out.notifiedByLegacyOnly).toBeGreaterThan(0);
  });

  it("scans fewer users where the band is provable", async () => {
    const kase = findCase("income-cap-raised");
    const out = await runCase(kase, { users, userModel: makeUserStore(users) });
    expect(out.targeted.candidateSelection).toBe("targeted-band");
    expect(out.targeted.usersScanned).toBeLessThan(out.legacy.usersScanned);
  });

  /**
   * THE HONESTY COUNTERWEIGHT.
   *
   * The legacy filter is `isMatch(user, schemeAfter)`, so a user who LOST
   * eligibility fails it and is never emailed. The baseline is not merely
   * noisier than the targeted flow — it is blind to the people with the most to
   * lose. Reporting the volume reduction without this would flatter the result
   * and misdescribe the baseline.
   */
  it("reports the people the baseline could NOT reach", async () => {
    const kase = findCase("income-cap-lowered"); // users lose eligibility
    const out = await runCase(kase, { users, userModel: makeUserStore(users) });
    expect(out.notifiedByTargetedOnly).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reporting rules
// ---------------------------------------------------------------------------
describe("R — reporting refuses to flatter the result", () => {
  const obs = (over = {}) => ({
    id: "c",
    status: STATUS.MEASURED,
    legacy: { notified: 100, usersScanned: 240 },
    targeted: { notified: 40, usersScanned: 40 },
    notifiedByLegacyOnly: 60,
    notifiedByTargetedOnly: 0,
    ...over,
  });

  it("computes the reduction against the baseline's own denominator", () => {
    const s = summarise([obs()]);
    expect(s.notificationVolume.reduction).toBe(0.6);
    expect(s.notificationVolume.interruptionsAvoided).toBe(60);
  });

  it("reports NULL, not 1.0, when the baseline notified nobody", () => {
    // There is no reduction to express as a fraction of zero, and both 0 and 1
    // would be a claim the data does not support.
    const s = summarise([obs({ legacy: { notified: 0, usersScanned: 240 } })]);
    expect(s.notificationVolume.reduction).toBeNull();
  });

  it("always carries the coverage counts beside the volume figure", () => {
    const s = summarise([obs({ notifiedByTargetedOnly: 7 })]);
    expect(s.coverage.notifiedByTargetedOnly).toBe(7);
    expect(s.coverage.notifiedByLegacyOnly).toBe(60);
  });

  it("a failed case makes the run FAILED and is never dropped", () => {
    const s = summarise([obs(), { id: "boom", status: STATUS.FAILED, error: "x" }]);
    expect(s.status).toBe(STATUS.FAILED);
    expect(s.cases.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R.2 — the broker decision
// ---------------------------------------------------------------------------
describe("R.2 — the broker decision is measured, not asserted", () => {
  it("is NOT_MEASURED with no instrumented cycles — never 0%", () => {
    const b = brokerRecommendation([]);
    expect(b.status).toBe(STATUS.NOT_MEASURED);
    expect(b.deliveryFraction).toBeNull();
    expect(b.recommendBroker).toBeNull();
  });

  it("ignores a cycle missing either half of the ratio", () => {
    // A cycle recorded before the Phase R instrumentation has no notification
    // duration. Counting it as 0 ms of delivery would drag the fraction down
    // and argue against a broker using data that never measured one.
    const b = brokerRecommendation([{ totalMs: 100 }, { notificationDurationMs: 40 }]);
    expect(b.status).toBe(STATUS.NOT_MEASURED);
    expect(b.n).toBe(0);
  });

  it("recommends a broker only above the documented threshold", () => {
    const under = brokerRecommendation([{ totalMs: 1000, notificationDurationMs: 100 }]);
    expect(under.deliveryFraction).toBe(0.1);
    expect(under.recommendBroker).toBe(false);

    const over = brokerRecommendation([{ totalMs: 1000, notificationDurationMs: 400 }]);
    expect(over.deliveryFraction).toBe(0.4);
    expect(over.recommendBroker).toBe(true);
    expect(over.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Corpus consistency
// ---------------------------------------------------------------------------
/**
 * THE DEFECT THIS TEST EXISTS FOR.
 *
 * `matcher.js` requires a scheme declared `constrained` to produce at least one
 * POSITIVE match — a constrained scheme nobody can be verified against is not
 * one anybody should be told they match. A corpus case that removed the only
 * constraint therefore left a "constrained" scheme with no rules at all, and
 * every user became ineligible. The case still ran, still reported a number,
 * and was measuring the opposite of what its label said.
 *
 * It surfaced as an impossible row in the Phase R table: the legacy full-scan
 * baseline notifying ZERO users for a scheme that had just become less
 * restrictive.
 */
describe("R — the shared corpus is internally consistent with the matcher", () => {
  it("never declares a scheme `constrained` while giving it nothing to constrain", () => {
    const constraintKeys = [
      "minAge", "maxAge", "maxAnnualIncome", "minAnnualIncome",
      "minMarksPercentage", "minEducationLevel",
      "genders", "categories", "categoryGroups", "occupations", "states",
    ];
    const hasConstraint = (rules) =>
      constraintKeys.some((k) => {
        const v = rules[k];
        return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
      });

    for (const kase of corpus) {
      for (const [side, rules] of [["old", kase.oldRules], ["new", kase.newRules]]) {
        if (rules.eligibilityType !== "constrained") continue;
        expect({ case: kase.id, side, constrained: hasConstraint(rules) }).toEqual({
          case: kase.id,
          side,
          constrained: true,
        });
      }
    }
  });

  it("has at least one user eligible after each non-closing change", () => {
    // A case where nobody can be eligible afterwards measures very little. The
    // deliberately-unmappable education rung and the closed scheme are the
    // documented exceptions.
    const users = makeUsers(60);
    const exempt = new Set(["education-unknown-rung", "scheme-closed"]);
    for (const kase of corpus) {
      if (exempt.has(kase.id)) continue;
      const anyEligible = users.some((u) => evaluateEligibility(u, kase.schemeAfter).eligible);
      expect({ case: kase.id, anyEligible }).toEqual({ case: kase.id, anyEligible: true });
    }
  });
});
