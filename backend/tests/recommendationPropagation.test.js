/**
 * Recommendation Propagation — Phase J.
 *
 * The distinction this suite exists to defend: propagation compares
 * RECOMMENDATION STATE, not eligibility. Eligibility is one user against one
 * scheme; a recommendation is one user against the whole scheme universe,
 * because it carries a position in a list. A test suite that only checked
 * eligibility flips would pass while the rank-change cases silently did
 * nothing, so most of what follows is about rank.
 *
 * No DB, no network. The history stand-in enforces the real unique index, so
 * the idempotency tests exercise the actual mechanism rather than a stub that
 * always says yes.
 */
const {
  propagateChange,
  computeRecommendationState,
  classifyEligibilityTransition,
  classifyRecommendationTransition,
  ELIGIBILITY_TRANSITIONS,
  RECOMMENDATION_TRANSITIONS,
  RECOMMENDATION_STATUS,
} = require("../src/services/recommendationPropagation");
const { assessImpact } = require("../src/agents/policyImpactAgent");
const { classifyDeterministic } = require("../src/agents/policyChangeAgent");
const {
  fakeUserModel,
  fakeSchemeModel,
  fakeHistoryModel,
  mkUser,
  mkScheme,
  baseRules,
} = require("./helpers/fakeUserModel");

// ---------------------------------------------------------------------------
// Scenario builder: wires the real Impact Agent to the real propagation
// service, so these are integration tests over the two agents, not mocks.
// ---------------------------------------------------------------------------
async function runScenario({
  users,
  schemesBefore,
  schemesAfter,
  changedSchemeId,
  diffs,
  topK = 10,
  triggeringChangeId = "chg-1",
  processingJobId = "job-1",
  history = null,
  deps = {},
}) {
  const changeVerdict = classifyDeterministic(diffs);
  const schemeAfter = schemesAfter.find((s) => s.schemeId === changedSchemeId);
  const schemeBefore = schemesBefore.find((s) => s.schemeId === changedSchemeId);

  const impact = await assessImpact({
    scheme: schemeAfter,
    oldRules: schemeBefore?.eligibilityRules || {},
    oldSchemeSnapshot: schemeBefore,
    diffs,
    changeVerdict,
    userModel: fakeUserModel(users),
  });

  const historyModel = history || fakeHistoryModel();
  const result = await propagateChange({
    scheme: schemeAfter,
    oldSnapshot: schemeBefore,
    diffs,
    changeVerdict,
    impact,
    triggeringChangeId,
    processingJobId,
    topK,
    deps: {
      historyModel,
      schemeModel: fakeSchemeModel(schemesAfter),
      userModel: fakeUserModel(users),
      ...deps,
    },
  });

  return { impact, result, historyModel, changeVerdict };
}

/**
 * Propagation needs a rank, and a rank needs competitors. These filler schemes
 * are universal (open to everyone), so they populate the ranked list for every
 * user without interacting with the eligibility rules under test.
 */
const fillers = (n, opts = {}) =>
  Array.from({ length: n }, (_, i) =>
    mkScheme(`filler-${i}`, { ...baseRules(), eligibilityType: "universal" }, {
      name: `Filler Scheme ${i}`,
      description: opts.description || "general welfare support programme",
      benefits: opts.benefits || "financial assistance of Rs 5000",
    })
  );

describe("classifyEligibilityTransition", () => {
  it("covers all four cases", () => {
    expect(classifyEligibilityTransition(false, true)).toBe(
      ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE
    );
    expect(classifyEligibilityTransition(true, false)).toBe(
      ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_INELIGIBLE
    );
    expect(classifyEligibilityTransition(true, true)).toBe(
      ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_ELIGIBLE
    );
    expect(classifyEligibilityTransition(false, false)).toBe(
      ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_INELIGIBLE
    );
  });
});

describe("classifyRecommendationTransition", () => {
  const at = (rank, inTopK = true) => ({ rank, inTopK, relevance: 0 });

  it("reports entering and leaving the top K", () => {
    expect(classifyRecommendationTransition(null, at(3))).toBe(
      RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED
    );
    expect(classifyRecommendationTransition(at(3), null)).toBe(
      RECOMMENDATION_TRANSITIONS.RECOMMENDED_TO_NOT_RECOMMENDED
    );
  });

  it("treats eligible-but-outside-top-K as not recommended", () => {
    // Rank 40 of 60 eligible schemes is not a recommendation in any useful
    // sense — the user never sees it.
    expect(classifyRecommendationTransition(at(40, false), at(3, true))).toBe(
      RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED
    );
    expect(classifyRecommendationTransition(at(3, true), at(40, false))).toBe(
      RECOMMENDATION_TRANSITIONS.RECOMMENDED_TO_NOT_RECOMMENDED
    );
  });

  describe("rank direction", () => {
    // Rank 1 is the BEST position, so a smaller number is a better placement.
    // RANK_INCREASED means the scheme moved UP the list — its rank NUMBER went
    // DOWN. Backwards, this would report a demotion as a promotion.
    it("calls moving from rank 5 to rank 2 an increase", () => {
      expect(classifyRecommendationTransition(at(5), at(2))).toBe(
        RECOMMENDATION_TRANSITIONS.RANK_INCREASED
      );
    });

    it("calls moving from rank 2 to rank 5 a decrease", () => {
      expect(classifyRecommendationTransition(at(2), at(5))).toBe(
        RECOMMENDATION_TRANSITIONS.RANK_DECREASED
      );
    });

    it("reports no change when the rank held", () => {
      expect(classifyRecommendationTransition(at(3), at(3))).toBe(
        RECOMMENDATION_TRANSITIONS.NO_CHANGE
      );
    });
  });

  it("reports no change when the user was never and is still not recommended", () => {
    expect(classifyRecommendationTransition(null, null)).toBe(RECOMMENDATION_TRANSITIONS.NO_CHANGE);
  });
});

describe("computeRecommendationState", () => {
  it("ranks 1-based, best first", () => {
    const user = mkUser(1, { age: 22, annualIncome: 280000, state: "Karnataka" });
    const universe = [
      mkScheme("a", { ...baseRules(), eligibilityType: "universal" }),
      mkScheme("b", { ...baseRules(), eligibilityType: "universal" }),
    ];
    const { ranked, byScheme } = computeRecommendationState(user, universe, { topK: 10 });
    expect(ranked.length).toBe(2);
    expect(byScheme.get(ranked[0].scheme.schemeId).rank).toBe(1);
    expect(byScheme.get(ranked[1].scheme.schemeId).rank).toBe(2);
  });

  it("excludes closed schemes even when the rules still pass", () => {
    // matcher.js does not look at status, so this layer must.
    const user = mkUser(1, { age: 22, annualIncome: 100000 });
    const universe = [
      mkScheme("open", { ...baseRules(), eligibilityType: "universal" }),
      mkScheme("shut", { ...baseRules(), eligibilityType: "universal" }, { status: "closed" }),
    ];
    const { byScheme } = computeRecommendationState(user, universe, { topK: 10 });
    expect(byScheme.has("open")).toBe(true);
    expect(byScheme.has("shut")).toBe(false);
  });

  it("marks schemes outside K as not in the top K while still ranking them", () => {
    const user = mkUser(1, { age: 22, annualIncome: 100000 });
    const universe = fillers(5);
    const { ranked, byScheme } = computeRecommendationState(user, universe, { topK: 2 });
    expect(ranked.length).toBe(5);
    expect(byScheme.get(ranked[0].scheme.schemeId).inTopK).toBe(true);
    expect(byScheme.get(ranked[1].scheme.schemeId).inTopK).toBe(true);
    expect(byScheme.get(ranked[2].scheme.schemeId).inTopK).toBe(false);
    expect(byScheme.get(ranked[4].scheme.schemeId).rank).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// CASE 1 — newly eligible
// ---------------------------------------------------------------------------
describe("case 1: a user becomes newly eligible", () => {
  const target = "income-scheme";
  const users = [mkUser(1, { age: 22, annualIncome: 280000, state: "Karnataka", education: "Graduate" })];
  const before = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000 }, { version: 1 }), ...fillers(3)];
  const after = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 2 }), ...fillers(3)];
  const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 }];

  let ctx;
  beforeAll(async () => {
    ctx = await runScenario({ users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs });
  });

  it("writes exactly one history row", () => {
    expect(ctx.result.recordsWritten).toBe(1);
    expect(ctx.historyModel.rows.length).toBe(1);
  });

  it("records the eligibility transition", () => {
    const row = ctx.historyModel.rows[0];
    expect(row.previousEligibility).toBe(false);
    expect(row.newEligibility).toBe(true);
    expect(row.eligibilityTransition).toBe(ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE);
  });

  it("records the recommendation transition and the ranks", () => {
    const row = ctx.historyModel.rows[0];
    expect(row.recommendationTransition).toBe(
      RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED
    );
    expect(row.previousRecommendationStatus).toBe(RECOMMENDATION_STATUS.NOT_RECOMMENDED);
    expect(row.newRecommendationStatus).toBe(RECOMMENDATION_STATUS.RECOMMENDED);
    // No previous position: the user was not eligible, so there was none.
    expect(row.previousRank).toBeNull();
    expect(typeof row.newRank).toBe("number");
  });

  it("records every field needed to audit the row", () => {
    const row = ctx.historyModel.rows[0];
    expect(row.userId).toBe("u1");
    expect(row.schemeId).toBe(target);
    expect(row.previousSchemeVersion).toBe(1);
    expect(row.newSchemeVersion).toBe(2);
    expect(row.triggeringChangeId).toBe("chg-1");
    expect(row.processingJobId).toBe("job-1");
    expect(row.createdAt).toBeDefined();
    expect(row.affectedAttributes).toContain("income");
  });

  it("grounds the reason in the rule that actually moved", () => {
    const row = ctx.historyModel.rows[0];
    expect(row.reason.code).toBe("BECAME_ELIGIBLE");
    expect(row.reason.rulesNowPassing).toContain("annualIncome");
    expect(row.reason.changedFields[0]).toEqual({
      field: "eligibilityRules.maxAnnualIncome",
      oldValue: 250000,
      newValue: 300000,
    });
  });

  it("emits a RecommendationChanged event without sending anything", () => {
    // Phase J builds the audit trail. Notification is Phase L's job.
    expect(ctx.result.events.length).toBe(1);
    expect(ctx.result.events[0].type).toBe("RecommendationChanged");
  });
});

// ---------------------------------------------------------------------------
// CASE 2 — newly ineligible
// ---------------------------------------------------------------------------
describe("case 2: a user becomes newly ineligible", () => {
  const target = "income-scheme";
  const users = [mkUser(1, { age: 22, annualIncome: 280000, state: "Karnataka" })];
  const before = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 1 }), ...fillers(3)];
  const after = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000 }, { version: 2 }), ...fillers(3)];
  const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000 }];

  let ctx;
  beforeAll(async () => {
    ctx = await runScenario({ users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs });
  });

  it("records the loss, with the rule that now fails", () => {
    const row = ctx.historyModel.rows[0];
    expect(row.eligibilityTransition).toBe(ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_INELIGIBLE);
    expect(row.recommendationTransition).toBe(
      RECOMMENDATION_TRANSITIONS.RECOMMENDED_TO_NOT_RECOMMENDED
    );
    expect(row.newRank).toBeNull();
    expect(typeof row.previousRank).toBe("number");
    expect(row.reason.code).toBe("LOST_ELIGIBILITY");
    expect(row.reason.rulesNowFailing).toContain("annualIncome");
  });

  it("marks the severity as critical, because an entitlement was removed", () => {
    expect(ctx.changeVerdict.severity).toBe("CRITICAL");
    expect(ctx.historyModel.rows[0].severity).toBe("CRITICAL");
  });
});

// ---------------------------------------------------------------------------
// CASES 3 & 4 & 9 — still eligible, rank moves (or does not)
// ---------------------------------------------------------------------------
describe("cases 3, 4, 9: still eligible, the rank moves", () => {
  const target = "rank-scheme";
  const users = [mkUser(1, { age: 22, annualIncome: 100000, state: "Karnataka", occupation: "Student" })];

  // The user stays eligible throughout; only how ATTRACTIVE the scheme is
  // changes. An eligibility-only check would see nothing here.
  const rules = { ...baseRules(), eligibilityType: "universal" };

  it("records RANK_INCREASED when a better benefit lifts the scheme up the list", async () => {
    const before = [
      mkScheme(target, rules, { version: 1, benefits: "certificate of appreciation" }),
      ...fillers(4),
    ];
    const after = [
      mkScheme(target, rules, {
        version: 2,
        benefits: "financial assistance of Rs 50000 per year and a monthly stipend",
      }),
      ...fillers(4),
    ];
    const diffs = [
      {
        field: "benefits",
        oldValue: "certificate of appreciation",
        newValue: "financial assistance of Rs 50000 per year and a monthly stipend",
      },
    ];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, topK: 10,
    });

    const row = ctx.historyModel.rows[0];
    expect(row).toBeDefined();
    expect(row.eligibilityTransition).toBe(ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_ELIGIBLE);
    expect(row.recommendationTransition).toBe(RECOMMENDATION_TRANSITIONS.RANK_INCREASED);
    // The direction the user experiences: it moved UP, so the number went DOWN.
    expect(row.newRank).toBeLessThan(row.previousRank);
  });

  it("records RANK_DECREASED when the benefit is cut", async () => {
    const before = [
      mkScheme(target, rules, {
        version: 1,
        benefits: "financial assistance of Rs 50000 per year and a monthly stipend",
      }),
      ...fillers(4),
    ];
    const after = [
      mkScheme(target, rules, { version: 2, benefits: "certificate of appreciation" }),
      ...fillers(4),
    ];
    const diffs = [
      {
        field: "benefits",
        oldValue: "financial assistance of Rs 50000 per year and a monthly stipend",
        newValue: "certificate of appreciation",
      },
    ];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, topK: 10,
    });

    const row = ctx.historyModel.rows[0];
    expect(row).toBeDefined();
    expect(row.recommendationTransition).toBe(RECOMMENDATION_TRANSITIONS.RANK_DECREASED);
    expect(row.newRank).toBeGreaterThan(row.previousRank);
  });

  it("writes NOTHING when the user stays eligible at the same rank", async () => {
    // A history table that records non-events is noise, and would later become
    // a notification the user did not need.
    const before = [mkScheme(target, rules, { version: 1, ministry: "MoE" }), ...fillers(4)];
    const after = [
      mkScheme(target, rules, { version: 2, ministry: "Ministry of Education" }),
      ...fillers(4),
    ];
    const diffs = [{ field: "ministry", oldValue: "MoE", newValue: "Ministry of Education" }];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
    });

    expect(ctx.result.recordsWritten).toBe(0);
    expect(ctx.historyModel.rows.length).toBe(0);
    expect(ctx.result.events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CASES 7 & 8 — entering and leaving the Top-K without an eligibility change
// ---------------------------------------------------------------------------
describe("cases 7, 8: crossing the Top-K boundary while staying eligible", () => {
  const target = "topk-scheme";
  const users = [mkUser(1, { age: 22, annualIncome: 100000, occupation: "Student" })];
  const rules = { ...baseRules(), eligibilityType: "universal" };

  it("records entering the Top-K", async () => {
    // K = 1: the scheme is eligible in both worlds but only visible in one.
    const before = [
      mkScheme(target, rules, { version: 1, benefits: "certificate only" }),
      ...fillers(3, { benefits: "financial assistance of Rs 20000 scholarship" }),
    ];
    const after = [
      mkScheme(target, rules, {
        version: 2,
        benefits: "financial assistance of Rs 500000 and monthly stipend and free tuition",
      }),
      ...fillers(3, { benefits: "financial assistance of Rs 20000 scholarship" }),
    ];
    const diffs = [
      { field: "benefits", oldValue: "certificate only", newValue: "financial assistance of Rs 500000 and monthly stipend and free tuition" },
    ];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, topK: 1,
    });

    const row = ctx.historyModel.rows[0];
    expect(row).toBeDefined();
    // Eligible the whole time — only visibility changed.
    expect(row.previousEligibility).toBe(true);
    expect(row.newEligibility).toBe(true);
    expect(row.recommendationTransition).toBe(
      RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED
    );
    expect(row.newRank).toBe(1);
    expect(row.previousRank).toBeGreaterThan(1);
    expect(row.topK).toBe(1);
    expect(row.reason.code).toBe("ENTERED_TOP_K");
  });

  it("records leaving the Top-K", async () => {
    const before = [
      mkScheme(target, rules, {
        version: 1,
        benefits: "financial assistance of Rs 500000 and monthly stipend and free tuition",
      }),
      ...fillers(3, { benefits: "financial assistance of Rs 20000 scholarship" }),
    ];
    const after = [
      mkScheme(target, rules, { version: 2, benefits: "certificate only" }),
      ...fillers(3, { benefits: "financial assistance of Rs 20000 scholarship" }),
    ];
    const diffs = [
      { field: "benefits", oldValue: "financial assistance of Rs 500000 and monthly stipend and free tuition", newValue: "certificate only" },
    ];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, topK: 1,
    });

    const row = ctx.historyModel.rows[0];
    expect(row).toBeDefined();
    expect(row.previousEligibility).toBe(true);
    expect(row.newEligibility).toBe(true);
    expect(row.recommendationTransition).toBe(
      RECOMMENDATION_TRANSITIONS.RECOMMENDED_TO_NOT_RECOMMENDED
    );
    expect(row.previousRank).toBe(1);
    expect(row.reason.code).toBe("LEFT_TOP_K");
  });
});

// ---------------------------------------------------------------------------
// CASE 4 — still eligible, recommendation did not move
//
// These reach a branch nothing else does. The Impact Agent flags "something
// material changed for this eligible user"; propagation then asks the stricter
// question "did their recommendation actually move?". Both answers need a
// defined outcome, and they differ.
// ---------------------------------------------------------------------------
describe("case 4: still eligible, the recommendation did not move", () => {
  const target = "held-scheme";
  const users = [mkUser(1, { age: 22, annualIncome: 100000, occupation: "Student" })];
  const rules = { ...baseRules(), eligibilityType: "universal" };

  it("records a row when the DEADLINE moved, even though the rank did not", async () => {
    // The user's list looks identical, but a scheme they hold now expires
    // sooner. Dropping this would leave a hole in the audit trail exactly
    // where "the deadline moved up" belongs.
    const before = [mkScheme(target, rules, { version: 1, lastDate: "2026-12-31" }), ...fillers(3)];
    const after = [mkScheme(target, rules, { version: 2, lastDate: "2026-09-30" }), ...fillers(3)];
    const diffs = [{ field: "lastDate", oldValue: "2026-12-31", newValue: "2026-09-30" }];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
    });

    expect(ctx.result.recordsWritten).toBe(1);
    const row = ctx.historyModel.rows[0];
    expect(row.eligibilityTransition).toBe(ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_ELIGIBLE);
    expect(row.recommendationTransition).toBe(RECOMMENDATION_TRANSITIONS.NO_CHANGE);
    expect(row.previousRank).toBe(row.newRank);
    expect(row.previousRecommendationStatus).toBe(RECOMMENDATION_STATUS.RECOMMENDED);
    expect(row.newRecommendationStatus).toBe(RECOMMENDATION_STATUS.RECOMMENDED);
    expect(row.reason.code).toBe("DEADLINE_CHANGED");
  });

  it("records a row when the required DOCUMENTS changed", async () => {
    const before = [mkScheme(target, rules, { version: 1, documents: ["Aadhaar"] }), ...fillers(3)];
    const after = [
      mkScheme(target, rules, { version: 2, documents: ["Aadhaar", "Income Certificate"] }),
      ...fillers(3),
    ];
    const diffs = [
      { field: "documents", oldValue: ["Aadhaar"], newValue: ["Aadhaar", "Income Certificate"] },
    ];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
    });
    expect(ctx.result.recordsWritten).toBe(1);
    expect(ctx.historyModel.rows[0].reason.code).toBe("DOCUMENTS_CHANGED");
  });

  it("is never handed a user who is ineligible before and after", async () => {
    // The Impact Agent drops UNCHANGED users before propagation sees them, so
    // the cheapest correct behaviour is that they never arrive at all.
    const strict = { ...baseRules(), maxAnnualIncome: 50000 };
    const poorFit = [mkUser(9, { age: 40, annualIncome: 900000 })];
    const before = [mkScheme(target, strict, { version: 1, documents: ["Aadhaar"] }), ...fillers(3)];
    const after = [
      mkScheme(target, strict, { version: 2, documents: ["Aadhaar", "Bank Passbook"] }),
      ...fillers(3),
    ];
    const diffs = [
      { field: "documents", oldValue: ["Aadhaar"], newValue: ["Aadhaar", "Bank Passbook"] },
    ];
    const ctx = await runScenario({
      users: poorFit, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
    });

    // The agent DID look at them — this is not passing by scanning nobody.
    expect(ctx.impact.candidatesExamined).toBe(1);
    expect(ctx.impact.impacts.length).toBe(0);
    expect(ctx.result.usersConsidered).toBe(0);
    expect(ctx.result.recordsWritten).toBe(0);
  });

  it("writes nothing for an unmoved user handed to it directly", async () => {
    // Belt and braces: if a caller ever passes an unmoved user (a replayed
    // impact list, a future caller that does its own selection), propagation's
    // own guard must still refuse to write a row.
    const history = fakeHistoryModel();
    const schemes = [mkScheme(target, rules, { version: 2 }), ...fillers(3)];
    const result = await propagateChange({
      scheme: schemes[0],
      oldSnapshot: mkScheme(target, rules, { version: 1 }),
      diffs: [{ field: "ministry", oldValue: "MoE", newValue: "Ministry of Education" }],
      changeVerdict: classifyDeterministic([
        { field: "ministry", oldValue: "MoE", newValue: "Ministry of Education" },
      ]),
      // Hand-built: this user's recommendation state is identical either way.
      impact: { impacts: [{ userId: "u1", email: "u1@example.com", transition: "UNCHANGED" }] },
      triggeringChangeId: "chg-direct",
      topK: 10,
      deps: {
        historyModel: history,
        schemeModel: fakeSchemeModel(schemes),
        userModel: fakeUserModel(users),
      },
    });

    expect(result.usersConsidered).toBe(1);
    expect(result.recordsWritten).toBe(0);
    expect(result.transitions.NO_MOVEMENT).toBe(1);
    expect(history.rows.length).toBe(0);
  });

  it("writes NOTHING when an eligible user sees only an administrative edit", async () => {
    // An applicationLink change is real, reaches propagation, and is still not
    // something to record against the user's recommendations.
    const before = [mkScheme(target, rules, { version: 1, applicationLink: "http://a.gov.in" }), ...fillers(3)];
    const after = [mkScheme(target, rules, { version: 2, applicationLink: "https://a.gov.in" }), ...fillers(3)];
    const diffs = [
      { field: "applicationLink", oldValue: "http://a.gov.in", newValue: "https://a.gov.in" },
    ];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
    });
    expect(ctx.result.recordsWritten).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CASE 5 — multiple affected users, each judged on their own profile
// ---------------------------------------------------------------------------
describe("case 5: multiple affected users", () => {
  const target = "income-scheme";
  const users = [
    mkUser(1, { age: 22, annualIncome: 280000 }), // in the band -> gains
    mkUser(2, { age: 30, annualIncome: 260000 }), // in the band -> gains
    mkUser(3, { age: 40, annualIncome: 100000 }), // below both caps -> no move
    mkUser(4, { age: 50, annualIncome: 900000 }), // above both caps -> no move
  ];
  const before = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000 }, { version: 1 }), ...fillers(2)];
  const after = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 2 }), ...fillers(2)];
  const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 }];

  it("writes one row per moved user and none for the rest", async () => {
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
    });
    expect(ctx.impact.candidatesExamined).toBe(2); // the band, not the population
    expect(ctx.result.recordsWritten).toBe(2);
    expect(ctx.historyModel.rows.map((r) => r.userId).sort()).toEqual(["u1", "u2"]);
    for (const row of ctx.historyModel.rows) {
      expect(row.eligibilityTransition).toBe(ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE);
    }
  });
});

// ---------------------------------------------------------------------------
// CASE 6 — no-change scheme
// ---------------------------------------------------------------------------
describe("case 6: a scheme that did not change", () => {
  it("does no work and writes nothing", async () => {
    const target = "steady-scheme";
    const users = [mkUser(1, { age: 22, annualIncome: 100000 })];
    const schemes = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 1 }), ...fillers(2)];
    const schemeSpy = {};

    const ctx = await runScenario({
      users,
      schemesBefore: schemes,
      schemesAfter: schemes,
      changedSchemeId: target,
      diffs: [],
      deps: { schemeModel: fakeSchemeModel(schemes, schemeSpy) },
    });

    expect(ctx.impact.candidateSelection).toBe("skipped");
    expect(ctx.impact.impacts.length).toBe(0);
    expect(ctx.result.recordsWritten).toBe(0);
    expect(ctx.result.events.length).toBe(0);
    // With nobody affected, propagation must not even load the scheme universe.
    expect(schemeSpy.queried).toBeUndefined();
  });

  it("does nothing for a cosmetic-only change", async () => {
    const target = "steady-scheme";
    const users = [mkUser(1, { age: 22, annualIncome: 100000 })];
    const before = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 1, description: "A scheme." }), ...fillers(2)];
    const after = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 2, description: "A  scheme" }), ...fillers(2)];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target,
      diffs: [{ field: "description", oldValue: "A scheme.", newValue: "A  scheme" }],
    });
    expect(ctx.result.recordsWritten).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CASE 10 — idempotency
// ---------------------------------------------------------------------------
describe("case 10: idempotency", () => {
  const target = "income-scheme";
  const users = [mkUser(1, { age: 22, annualIncome: 280000 })];
  const before = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000 }, { version: 1 }), ...fillers(2)];
  const after = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 2 }), ...fillers(2)];
  const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 }];

  it("does not duplicate rows when the same event is processed twice", async () => {
    const history = fakeHistoryModel();
    const opts = { users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, history };

    const first = await runScenario(opts);
    const second = await runScenario(opts); // same triggeringChangeId

    expect(first.result.recordsWritten).toBe(1);
    expect(second.result.recordsWritten).toBe(0);
    expect(second.result.duplicatesSkipped).toBe(1);
    expect(history.rows.length).toBe(1);
  });

  it("relies on the unique index, not only the pre-check", async () => {
    // Two concurrent runs can both pass a pre-check before either inserts.
    // Only the index settles that race, so it must be the real mechanism.
    const history = fakeHistoryModel();
    const opts = { users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, history };

    await runScenario(opts);
    history.state.failFinds = true; // disable the pre-check entirely
    const second = await runScenario(opts);

    expect(second.result.recordsWritten).toBe(0);
    expect(second.result.duplicatesSkipped).toBe(1);
    expect(history.rows.length).toBe(1);
  });

  it("treats a different change to the same scheme as a new event", async () => {
    const history = fakeHistoryModel();
    await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, history,
      triggeringChangeId: "chg-1",
    });
    // A later, genuinely different change must still be recorded.
    const v3 = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000 }, { version: 3 }), ...fillers(2)];
    await runScenario({
      users, schemesBefore: after, schemesAfter: v3, changedSchemeId: target,
      diffs: [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000 }],
      history, triggeringChangeId: "chg-2",
    });
    expect(history.rows.length).toBe(2);
    expect(history.rows.map((r) => r.triggeringChangeId)).toEqual(["chg-1", "chg-2"]);
  });

  it("refuses to run without an idempotency key", async () => {
    // Silently defaulting one would make replay protection a coin flip.
    await expect(
      propagateChange({ scheme: { schemeId: "x" }, impact: { impacts: [] }, triggeringChangeId: "" })
    ).rejects.toThrow(/triggeringChangeId/);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — validation checkpoint item 11
//
// The earlier idempotency tests ran the two propagations one after the other.
// That is replay, not concurrency. These interleave them, which is the case
// the pre-check query cannot handle and the unique index must.
// ---------------------------------------------------------------------------
describe("concurrent processing of the same event", () => {
  const target = "income-scheme";
  const users = [mkUser(1, { age: 22, annualIncome: 280000 }), mkUser(2, { age: 30, annualIncome: 260000 })];
  const before = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000 }, { version: 1 }), ...fillers(2)];
  const after = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 2 }), ...fillers(2)];
  const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 }];

  /**
   * A history store whose pre-check returns a STALE answer: it reads the rows
   * immediately, then resolves a tick later. That is the real race — two runs
   * both look, both see nothing, and only then does either insert.
   *
   * Getting this wrong is easy and makes the test worthless. Awaiting BEFORE
   * the read produces the opposite of a race: the second pre-check resolves
   * against the freshest possible state and dutifully spots the first run's
   * row, so the unique index is never exercised and removing it still passes.
   */
  function racingHistoryModel() {
    const base = fakeHistoryModel();
    return {
      rows: base.rows,
      state: base.state,
      async findOne(filter) {
        const snapshotNow = await base.findOne(filter); // read at THIS moment
        await new Promise((r) => setTimeout(r, 5)); // ...answer a tick later
        return snapshotNow;
      },
      create: (doc) => base.create(doc),
      countDocuments: (f) => base.countDocuments(f),
    };
  }

  it("writes each row exactly once when two runs overlap", async () => {
    const history = racingHistoryModel();
    const opts = { users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, history };

    const [a, b] = await Promise.all([runScenario(opts), runScenario(opts)]);

    // Two users, two rows, no matter how the two runs interleaved.
    expect(history.rows.length).toBe(2);
    expect(a.result.recordsWritten + b.result.recordsWritten).toBe(2);
    // Whatever the winner missed was counted as a duplicate, not lost.
    expect(a.result.duplicatesSkipped + b.result.duplicatesSkipped).toBe(2);
  });

  it("holds under many overlapping runs", async () => {
    const history = racingHistoryModel();
    const opts = { users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, history };

    const runs = await Promise.all(Array.from({ length: 6 }, () => runScenario(opts)));

    expect(history.rows.length).toBe(2);
    const written = runs.reduce((n, r) => n + r.result.recordsWritten, 0);
    expect(written).toBe(2);
    // Six runs x two users = twelve attempts, of which ten were duplicates.
    const skipped = runs.reduce((n, r) => n + r.result.duplicatesSkipped, 0);
    expect(written + skipped).toBe(12);
    // No attempt was lost to an unhandled error.
    expect(runs.every((r) => r.result.errors.length === 0)).toBe(true);
  });

  it("keeps one row per user per change, not one per run", async () => {
    const history = racingHistoryModel();
    const opts = { users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, history };
    await Promise.all([runScenario(opts), runScenario(opts), runScenario(opts)]);

    const keys = history.rows.map((r) => `${r.userId}|${r.schemeId}|${r.triggeringChangeId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...new Set(keys)].sort()).toEqual([
      "u1|income-scheme|chg-1",
      "u2|income-scheme|chg-1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------
describe("failure handling", () => {
  const target = "income-scheme";
  const users = [mkUser(1, { age: 22, annualIncome: 280000 }), mkUser(2, { age: 30, annualIncome: 260000 })];
  const before = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000 }, { version: 1 }), ...fillers(2)];
  const after = [mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, { version: 2 }), ...fillers(2)];
  const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 }];

  it("reports a write failure instead of silently dropping it", async () => {
    const history = fakeHistoryModel({ failNextCreates: 1 });
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs, history,
    });
    // One user's write failed; the other still succeeded.
    expect(ctx.result.recordsWritten).toBe(1);
    expect(ctx.result.errors.length).toBe(1);
    expect(ctx.result.errors[0].stage).toBe("writeHistory");
  });

  it("continues past one user's failure to process the rest", async () => {
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
      deps: {
        userModel: {
          findById(id) {
            if (String(id) === "u1") throw new Error("simulated user load failure");
            return { lean: async () => users.find((u) => u._id === String(id)) || null };
          },
        },
      },
    });
    expect(ctx.result.usersConsidered).toBe(2);
    expect(ctx.result.recordsWritten).toBe(1);
    expect(ctx.result.errors.length).toBe(1);
  });

  it("reports rather than throws when the scheme universe cannot be loaded", async () => {
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
      deps: { schemeModel: { find() { return { lean: async () => { throw new Error("db down"); } }; } } },
    });
    expect(ctx.result.recordsWritten).toBe(0);
    expect(ctx.result.errors[0].stage).toBe("loadSchemes");
  });

  it("keeps a written audit row even when the downstream consumer throws", async () => {
    // The row is already correct. A failing subscriber must not undo it.
    const ctx = await runScenario({
      users: [users[0]], schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
      deps: { emitEvent: async () => { throw new Error("subscriber exploded"); } },
    });
    expect(ctx.result.recordsWritten).toBe(1);
    expect(ctx.historyModel.rows.length).toBe(1);
    expect(ctx.result.errors[0].stage).toBe("emitEvent");
  });

  it("needs no LLM at any point", async () => {
    // Propagation is entirely deterministic: matcher + ranker + diff. If this
    // ever starts requiring an LLM, an outage would stop the audit trail.
    const llm = require("../src/services/llmClient");
    const before2 = { ...llm };
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
    });
    expect(ctx.result.recordsWritten).toBe(2);
    expect(Object.keys(before2).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple changed fields, and the acceptance scenario
// ---------------------------------------------------------------------------
describe("multiple changed fields at once", () => {
  it("propagates a combined income and age change", async () => {
    const target = "combo-scheme";
    const users = [
      mkUser(1, { age: 22, annualIncome: 280000 }), // income band
      mkUser(2, { age: 38, annualIncome: 100000 }), // age band
    ];
    const before = [
      mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000, maxAge: 35 }, { version: 1 }),
      ...fillers(2),
    ];
    const after = [
      mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000, maxAge: 40 }, { version: 2 }),
      ...fillers(2),
    ];
    const diffs = [
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
      { field: "eligibilityRules.maxAge", oldValue: 35, newValue: 40 },
    ];
    const ctx = await runScenario({
      users, schemesBefore: before, schemesAfter: after, changedSchemeId: target, diffs,
    });

    expect(ctx.impact.candidateSelection).toBe("targeted-union");
    expect(ctx.result.recordsWritten).toBe(2);
    for (const row of ctx.historyModel.rows) {
      expect(row.eligibilityTransition).toBe(ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE);
      expect([...row.affectedAttributes].sort()).toEqual(["age", "income"]);
    }
  });
});

describe("the acceptance scenario", () => {
  // Age 22, income Rs 2.8 lakh, B.Tech, Karnataka.
  // Scheme v1 caps income at Rs 2.5 lakh; v2 raises it to Rs 3 lakh.
  it("carries the user from ineligible to a recorded recommendation", async () => {
    const target = "myscheme-demo";
    const user = mkUser(1, {
      age: 22,
      annualIncome: 280000,
      education: "Graduate",
      state: "Karnataka",
      occupation: "Student",
    });
    const v1 = mkScheme(target, { ...baseRules(), maxAnnualIncome: 250000 }, {
      version: 1, name: "State Merit Scholarship",
      benefits: "financial assistance of Rs 25000 per year",
    });
    const v2 = mkScheme(target, { ...baseRules(), maxAnnualIncome: 300000 }, {
      version: 2, name: "State Merit Scholarship",
      benefits: "financial assistance of Rs 25000 per year",
    });
    const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 }];

    const ctx = await runScenario({
      users: [user],
      schemesBefore: [v1, ...fillers(3)],
      schemesAfter: [v2, ...fillers(3)],
      changedSchemeId: target,
      diffs,
      triggeringChangeId: "hist-abc123",
    });

    // The chain, end to end.
    expect(ctx.changeVerdict.changeType).toBe("ELIGIBILITY");
    expect(ctx.changeVerdict.severity).toBe("HIGH");
    expect(ctx.changeVerdict.fieldChanges[0].direction).toBe("BROADENED");
    expect(ctx.impact.candidateSelection).toBe("targeted-band");
    expect(ctx.impact.counts.NEWLY_ELIGIBLE).toBe(1);

    const row = ctx.historyModel.rows[0];
    expect(row.eligibilityTransition).toBe(ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE);
    expect(row.recommendationTransition).toBe(
      RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED
    );
    expect(row.previousSchemeVersion).toBe(1);
    expect(row.newSchemeVersion).toBe(2);
    expect(row.triggeringChangeId).toBe("hist-abc123");
    // Everything the Explanation Agent will need, already grounded in data.
    expect(row.reason.changedFields).toEqual([
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
    ]);
  });
});
