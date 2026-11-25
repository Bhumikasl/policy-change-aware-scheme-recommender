/**
 * Unit tests for eligibilityUpdateService.js
 *
 * All 10 required test scenarios from the specification.
 *
 * No live MongoDB needed — all database models are injected as mocks.
 * The tests exercise the REAL evaluateEligibility() from matcher.js,
 * because that is the hard gate and must not be substituted.
 */

"use strict";

const {
  getNewlyEligibleForUser,
  hasEligibilityRuleChange,
  buildChangedRuleExplanations,
  buildNewlyEligibleExplanation,
  buildOldSchemeForEvaluation,
  buildTriggeringChangeId,
} = require("../src/services/eligibilityUpdateService");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — build minimal objects that satisfy evaluateEligibility()
// ─────────────────────────────────────────────────────────────────────────────

function makeUser(profile = {}) {
  return {
    _id: "user-id-123",
    email: "test@example.com",
    profile: {
      state: "Karnataka",
      gender: "Male",
      age: null,
      occupation: "",
      annualIncome: null,
      categories: [],
      education: "",
      course: "",
      marksPercentage: null,
      disability: null,
      singleGirlChild: null,
      ...profile,
    },
  };
}

function makeScheme(overrides = {}) {
  return {
    schemeId: "TEST_SCHEME_001",
    name: "Test Scheme",
    status: "Active",
    description: "A test scheme",
    eligibility: "Test eligibility",
    benefits: "Test benefits",
    applicationLink: "https://example.com",
    ministry: "Test Ministry",
    state: "All India",
    documents: [],
    eligibilityRules: {
      eligibilityType: "constrained",
      source: "structured",
      minAge: null,
      maxAge: null,
      minAnnualIncome: null,
      maxAnnualIncome: null,
      genders: [],
      states: [],
      categories: [],
      categoryGroups: [],
      occupations: [],
      applicantTypes: [],
      courses: [],
      minEducationLevel: null,
      maxEducationLevel: null,
      disabilityRequired: null,
      minDisabilityPercentage: null,
      singleGirlChildRequired: null,
      confidence: 0.9,
      needsReview: false,
    },
    ...overrides,
  };
}

function makeSchemeWithRules(rules = {}) {
  return makeScheme({
    eligibilityRules: {
      eligibilityType: "constrained",
      source: "structured",
      minAge: null,
      maxAge: null,
      minAnnualIncome: null,
      maxAnnualIncome: null,
      genders: [],
      states: [],
      categories: [],
      categoryGroups: [],
      occupations: [],
      applicantTypes: [],
      courses: [],
      minEducationLevel: null,
      maxEducationLevel: null,
      disabilityRequired: null,
      minDisabilityPercentage: null,
      singleGirlChildRequired: null,
      confidence: 0.9,
      needsReview: false,
      ...rules,
    },
  });
}

/**
 * Build mock injectable deps for getNewlyEligibleForUser.
 *
 * @param {Object} params
 * @param {Array}  params.historyEntries     — SchemeHistory.find() result
 * @param {Array}  params.prevHistoryEntries — SchemeHistory.findOne() results per version
 * @param {Array}  params.currentSchemes     — Scheme.find() result
 * @param {boolean} params.alreadyRecorded   — RecommendationHistory.findOne() result
 */
function makeDeps({
  historyEntries = [],
  prevHistoryMap = {}, // { "schemeId:version": snapshot }
  currentSchemes = [],
  alreadyRecorded = false,
} = {}) {
  const SchemeHistoryModel = {
    find: () => ({
      sort: () => ({
        lean: async () => historyEntries,
      }),
    }),
    findOne: async ({ schemeId, version }) => {
      const key = `${schemeId}:${version}`;
      const snapshot = prevHistoryMap[key];
      if (snapshot === undefined) return null;
      return { snapshot };
    },
  };

  const SchemeModel = {
    find: () => ({
      lean: async () => currentSchemes,
    }),
  };

  const RecommendationHistoryModel = {
    findOne: async () => (alreadyRecorded ? { _id: "existing" } : null),
  };

  return { SchemeHistoryModel, SchemeModel, RecommendationHistoryModel };
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIT TESTS: hasEligibilityRuleChange
// ─────────────────────────────────────────────────────────────────────────────

describe("hasEligibilityRuleChange()", () => {
  test("returns true when diffs contain an eligibility rule field", () => {
    const diffs = [
      { field: "eligibilityRules.minAge", oldValue: null, newValue: 25 },
    ];
    expect(hasEligibilityRuleChange(diffs)).toBe(true);
  });

  test("returns false when diffs only contain description/name changes", () => {
    const diffs = [
      { field: "description", oldValue: "old", newValue: "new" },
      { field: "name", oldValue: "Old Name", newValue: "New Name" },
    ];
    expect(hasEligibilityRuleChange(diffs)).toBe(false);
  });

  test("returns false for empty diffs", () => {
    expect(hasEligibilityRuleChange([])).toBe(false);
    expect(hasEligibilityRuleChange(null)).toBe(false);
  });

  test("returns true when mixed diffs include at least one rule field", () => {
    const diffs = [
      { field: "description", oldValue: "old", newValue: "new" },
      { field: "eligibilityRules.maxAnnualIncome", oldValue: null, newValue: 500000 },
    ];
    expect(hasEligibilityRuleChange(diffs)).toBe(true);
  });

  // TEST 6: Only scheme description/keywords changed — no eligibility notification
  test("TEST 6 — only description/benefits/tags changed: returns false", () => {
    const diffs = [
      { field: "description", oldValue: "Old desc", newValue: "New desc" },
      { field: "benefits", oldValue: "Old benefit", newValue: "New benefit" },
      { field: "tags", oldValue: ["welfare"], newValue: ["welfare", "education"] },
    ];
    expect(hasEligibilityRuleChange(diffs)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION TESTS: getNewlyEligibleForUser — the 10 required scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("getNewlyEligibleForUser() — 10 required scenarios", () => {
  // ─── TEST 1 ───────────────────────────────────────────────────────────────
  test("TEST 1 — old age=unrestricted, new age=25-45, user age=30 → NEWLY_ELIGIBLE", async () => {
    const user = makeUser({ age: 30 });
    const schemeId = "SCHEME_AGE_TEST";

    // Old rules: eligibilityType unknown — matcher excludes unknown schemes by
    // default (allowUnknown: false), so previousStatus = NOT_ELIGIBLE.
    const oldRules = {
      eligibilityType: "unknown",
      minAge: null,
      maxAge: null,
      source: "unparsed",
      confidence: 0,
      genders: [], states: [], categories: [], categoryGroups: [],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    // New rules: 25 ≤ age ≤ 45
    const newRules = {
      ...oldRules,
      eligibilityType: "constrained",
      minAge: 25,
      maxAge: 45,
    };

    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });
    const oldSnapshot = { eligibilityRules: oldRules };

    const historyEntry = {
      schemeId,
      version: 2,
      eventType: "UPDATED",
      createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.minAge", oldValue: null, newValue: 25 },
        { field: "eligibilityRules.maxAge", oldValue: null, newValue: 45 },
        { field: "eligibilityRules.eligibilityType", oldValue: "universal", newValue: "constrained" },
      ],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:1`]: oldSnapshot },
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    expect(result.newlyEligible.length).toBe(1);
    expect(result.newlyEligible[0].schemeId).toBe(schemeId);
    expect(result.newlyEligible[0].type).toBe("NEWLY_ELIGIBLE");
    expect(result.newlyEligible[0].previousStatus).toBe("NOT_ELIGIBLE");
    expect(result.newlyEligible[0].currentStatus).toBe("ELIGIBLE");
    expect(result.eligibilityUpdated.length).toBe(0);
  });

  // ─── TEST 2 ───────────────────────────────────────────────────────────────
  test("TEST 2 — old age=unrestricted, new age=25-45, user age=20 → NOT_ELIGIBLE, not shown", async () => {
    const user = makeUser({ age: 20 });
    const schemeId = "SCHEME_AGE_TEST_2";

    const oldRules = {
      eligibilityType: "universal",
      minAge: null, maxAge: null,
      source: "structured", confidence: 0.9,
      genders: [], states: [], categories: [], categoryGroups: [],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    const newRules = { ...oldRules, eligibilityType: "constrained", minAge: 25, maxAge: 45 };

    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.minAge", oldValue: null, newValue: 25 },
        { field: "eligibilityRules.maxAge", oldValue: null, newValue: 45 },
      ],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:1`]: { eligibilityRules: oldRules } },
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // Age 20 < minAge 25 → NOT_ELIGIBLE under new rules → must not appear
    expect(result.newlyEligible.length).toBe(0);
    expect(result.eligibilityUpdated.length).toBe(0);
  });

  // ─── TEST 3 ───────────────────────────────────────────────────────────────
  test("TEST 3 — both old and new rules make user eligible → NOT 'newly eligible'", async () => {
    const user = makeUser({ age: 30 });
    const schemeId = "SCHEME_ALWAYS_ELIGIBLE";

    // Both old AND new: eligible (constrained, age 25-50 — user 30 passes both)
    const oldRules = {
      eligibilityType: "constrained", minAge: 25, maxAge: 50,
      source: "structured", confidence: 0.9,
      genders: [], states: [], categories: [], categoryGroups: [],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    const newRules = { ...oldRules, maxAnnualIncome: 600000 }; // income ceiling added
    // User has no income set → NEEDS_MORE_INFORMATION for new rule with income
    // Actually let's make it simpler: just change maxAge from 50 to 45 (user 30 still passes)
    const newRulesPassing = { ...oldRules, maxAge: 45 };

    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRulesPassing });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.maxAge", oldValue: 50, newValue: 45 },
      ],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:1`]: { eligibilityRules: oldRules } },
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // Was eligible before (age 30, maxAge 50) AND still eligible (age 30, maxAge 45)
    // → NOT "newly eligible" → appears in eligibilityUpdated (not newlyEligible)
    expect(result.newlyEligible.length).toBe(0);
    expect(result.eligibilityUpdated.length).toBe(1);
    expect(result.eligibilityUpdated[0].type).toBe("ELIGIBILITY_UPDATED");
  });

  // ─── TEST 4 ───────────────────────────────────────────────────────────────
  test("TEST 4 — new rule has mandatory condition user fails → NOT_ELIGIBLE, not shown", async () => {
    const user = makeUser({ age: 30, gender: "Male" });
    const schemeId = "SCHEME_GENDER_RESTRICTED";

    // Old: no gender restriction (universal)
    const oldRules = {
      eligibilityType: "universal",
      minAge: null, maxAge: null, genders: [],
      source: "structured", confidence: 0.9,
      states: [], categories: [], categoryGroups: [],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    // New: restricted to Female only — male user fails
    const newRules = {
      ...oldRules,
      eligibilityType: "constrained",
      genders: ["Female"],
    };

    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      diffs: [{ field: "eligibilityRules.genders", oldValue: [], newValue: ["Female"] }],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:1`]: { eligibilityRules: oldRules } },
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // Male user fails the new Female-only gender rule → NOT_ELIGIBLE
    expect(result.newlyEligible.length).toBe(0);
    expect(result.eligibilityUpdated.length).toBe(0);
  });

  // ─── TEST 5 ───────────────────────────────────────────────────────────────
  test("TEST 5 — new rule needs info user hasn't provided → NEEDS_MORE_INFORMATION → not eligible", async () => {
    const user = makeUser({ age: null }); // age not provided
    const schemeId = "SCHEME_NEEDS_AGE";

    const oldRules = {
      eligibilityType: "universal",
      minAge: null, maxAge: null,
      source: "structured", confidence: 0.9,
      genders: [], states: [], categories: [], categoryGroups: [],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    // New: age 25-45 — user hasn't provided age → NEEDS_MORE_INFORMATION
    const newRules = {
      ...oldRules,
      eligibilityType: "constrained",
      minAge: 25,
      maxAge: 45,
    };

    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.minAge", oldValue: null, newValue: 25 },
        { field: "eligibilityRules.maxAge", oldValue: null, newValue: 45 },
      ],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:1`]: { eligibilityRules: oldRules } },
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // Age not provided → strict mode → NEEDS_MORE_INFORMATION → not eligible
    expect(result.newlyEligible.length).toBe(0);
    expect(result.eligibilityUpdated.length).toBe(0);
  });

  // ─── TEST 6 ───────────────────────────────────────────────────────────────
  test("TEST 6 — only description/benefits/embedding changed → no eligibility update", async () => {
    const user = makeUser({ age: 30 });
    const schemeId = "SCHEME_DESC_ONLY";

    const currentScheme = makeScheme({ schemeId });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      // Only non-rule fields changed
      diffs: [
        { field: "description", oldValue: "Old description", newValue: "New description" },
        { field: "benefits", oldValue: "Old benefit", newValue: "New benefit" },
      ],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: {},
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // No eligibility-rule diffs → hasEligibilityRuleChange returns false →
    // this entry is filtered out before any eligibility evaluation
    expect(result.newlyEligible.length).toBe(0);
    expect(result.eligibilityUpdated.length).toBe(0);
    expect(result.totalChecked).toBe(0); // filtered before checking
  });

  // ─── TEST 7 ───────────────────────────────────────────────────────────────
  test("TEST 7 — two users with different profiles → different newly-eligible results", async () => {
    const schemeId = "SCHEME_AGE_BRACKET";

    const oldRules = {
      eligibilityType: "unknown",
      minAge: null, maxAge: null,
      source: "unparsed", confidence: 0,
      genders: [], states: [], categories: [], categoryGroups: [],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    const newRules = {
      ...oldRules,
      eligibilityType: "constrained",
      minAge: 25,
      maxAge: 45,
    };
    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.minAge", oldValue: null, newValue: 25 },
        { field: "eligibilityRules.maxAge", oldValue: null, newValue: 45 },
      ],
      snapshot: currentScheme,
    };
    const prevHistoryMap = { [`${schemeId}:1`]: { eligibilityRules: oldRules } };
    const currentSchemes = [currentScheme];

    // User A: age 30 — passes new age rule → NEWLY_ELIGIBLE
    const userA = makeUser({ age: 30 });
    const depsA = makeDeps({ historyEntries: [historyEntry], prevHistoryMap, currentSchemes, alreadyRecorded: false });
    const resultA = await getNewlyEligibleForUser({ user: userA, limit: 10, deps: depsA });
    expect(resultA.newlyEligible.length).toBe(1);
    expect(resultA.newlyEligible[0].type).toBe("NEWLY_ELIGIBLE");

    // User B: age 55 — fails new maxAge 45 → NOT_ELIGIBLE → not shown
    const userB = makeUser({ age: 55 });
    const depsB = makeDeps({ historyEntries: [historyEntry], prevHistoryMap, currentSchemes, alreadyRecorded: false });
    const resultB = await getNewlyEligibleForUser({ user: userB, limit: 10, deps: depsB });
    expect(resultB.newlyEligible.length).toBe(0);
  });

  // ─── TEST 8 ───────────────────────────────────────────────────────────────
  test("TEST 8 — multiple mandatory conditions, one fails → NOT_ELIGIBLE, not shown", async () => {
    const user = makeUser({
      age: 30,
      gender: "Male",
      categories: [], // no SC/ST/OBC
    });
    const schemeId = "SCHEME_MULTI_COND";

    const oldRules = {
      eligibilityType: "universal",
      minAge: null, maxAge: null, genders: [],
      source: "structured", confidence: 0.9,
      states: [], categories: [], categoryGroups: [],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    // New rules: age 25-45 (user passes) BUT categories SC/ST/OBC required (user fails)
    const newRules = {
      ...oldRules,
      eligibilityType: "constrained",
      minAge: 25,
      maxAge: 45,
      categoryGroups: [["SC", "ST", "OBC"]],
    };

    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.minAge", oldValue: null, newValue: 25 },
        { field: "eligibilityRules.maxAge", oldValue: null, newValue: 45 },
        { field: "eligibilityRules.categoryGroups", oldValue: [], newValue: [["SC", "ST", "OBC"]] },
      ],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:1`]: { eligibilityRules: oldRules } },
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // Age 30 passes, but category (SC/ST/OBC) fails → NOT_ELIGIBLE overall
    // One hard failure beats every positive match
    expect(result.newlyEligible.length).toBe(0);
    expect(result.eligibilityUpdated.length).toBe(0);
  });

  // ─── TEST 9 ───────────────────────────────────────────────────────────────
  test("TEST 9 — scheme semantically similar to profile but mandatory rule fails → NOT_ELIGIBLE", async () => {
    // Simulates: user is a student, scheme is about student scholarships (semantic match)
    // but scheme requires Female gender — male user fails
    const user = makeUser({
      age: 22,
      gender: "Male",
      occupation: "student",
    });
    const schemeId = "SCHEME_WOMEN_SCHOLAR";

    const oldRules = {
      eligibilityType: "universal",
      minAge: null, maxAge: null, genders: [],
      source: "structured", confidence: 0.9,
      states: [], categories: [], categoryGroups: [],
      occupations: ["student"], applicantTypes: ["STUDENT"], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    // New rules: add Female-only restriction
    const newRules = {
      ...oldRules,
      eligibilityType: "constrained",
      genders: ["Female"],
    };

    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.genders", oldValue: [], newValue: ["Female"] },
      ],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:1`]: { eligibilityRules: oldRules } },
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // Male user fails Female gender rule regardless of semantic similarity to scholarship
    expect(result.newlyEligible.length).toBe(0);
    expect(result.eligibilityUpdated.length).toBe(0);
  });

  // ─── TEST 10 ───────────────────────────────────────────────────────────────
  test("TEST 10 — all mandatory conditions pass after update, was not eligible before → NEWLY_ELIGIBLE", async () => {
    const user = makeUser({
      age: 30,
      gender: "Female",
      annualIncome: 250000,
      categories: ["SC"],
      state: "Karnataka",
    });
    const schemeId = "SCHEME_FULL_MATCH";

    // Old: restricted to SC Males in Karnataka — user (female SC) was not eligible
    const oldRules = {
      eligibilityType: "constrained",
      minAge: null, maxAge: null,
      genders: ["Male"], // user is Female → fails
      states: ["Karnataka"],
      categories: [], categoryGroups: [["SC"]],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      maxAnnualIncome: 300000,
      minAnnualIncome: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
      source: "structured", confidence: 0.9,
    };
    // New: open to all genders — user now passes all conditions
    const newRules = {
      ...oldRules,
      genders: [], // no gender restriction now
    };

    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });

    const historyEntry = {
      schemeId, version: 3, eventType: "UPDATED", createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.genders", oldValue: ["Male"], newValue: [] },
      ],
      snapshot: currentScheme,
    };

    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:2`]: { eligibilityRules: oldRules } },
      currentSchemes: [currentScheme],
      alreadyRecorded: false,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // All conditions now pass:
    //   - state: Karnataka ✓
    //   - gender: no restriction ✓
    //   - category: SC ✓
    //   - income: 250000 < 300000 ✓
    // Was NOT eligible before (failed Male gender rule)
    expect(result.newlyEligible.length).toBe(1);
    expect(result.newlyEligible[0].type).toBe("NEWLY_ELIGIBLE");
    expect(result.newlyEligible[0].previousStatus).toBe("NOT_ELIGIBLE");
    expect(result.newlyEligible[0].currentStatus).toBe("ELIGIBLE");
  });

  // ─── DEDUPLICATION TEST ───────────────────────────────────────────────────
  test("DEDUP — already recorded in RecommendationHistory → not returned again", async () => {
    const user = makeUser({ age: 30 });
    const schemeId = "SCHEME_DEDUP";

    const oldRules = {
      eligibilityType: "universal", minAge: null, maxAge: null,
      source: "structured", confidence: 0.9,
      genders: [], states: [], categories: [], categoryGroups: [],
      occupations: [], applicantTypes: [], courses: [],
      minEducationLevel: null, maxEducationLevel: null,
      disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null, needsReview: false,
    };
    const newRules = { ...oldRules, eligibilityType: "constrained", minAge: 25, maxAge: 45 };
    const currentScheme = makeScheme({ schemeId, eligibilityRules: newRules });

    const historyEntry = {
      schemeId, version: 2, eventType: "UPDATED", createdAt: new Date(),
      diffs: [
        { field: "eligibilityRules.minAge", oldValue: null, newValue: 25 },
        { field: "eligibilityRules.maxAge", oldValue: null, newValue: 45 },
      ],
      snapshot: currentScheme,
    };

    // alreadyRecorded = true → propagation pipeline already handled this
    const deps = makeDeps({
      historyEntries: [historyEntry],
      prevHistoryMap: { [`${schemeId}:1`]: { eligibilityRules: oldRules } },
      currentSchemes: [currentScheme],
      alreadyRecorded: true,
    });

    const result = await getNewlyEligibleForUser({ user, limit: 10, deps });

    // The transition was already recorded → must not resurface it
    expect(result.newlyEligible.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIT TESTS: buildOldSchemeForEvaluation
// ─────────────────────────────────────────────────────────────────────────────

describe("buildOldSchemeForEvaluation()", () => {
  test("merges current scheme non-rule fields with snapshot eligibilityRules", () => {
    const currentScheme = makeScheme({ status: "Active", name: "Current Name" });
    const oldSnapshot = {
      eligibilityRules: { eligibilityType: "universal", minAge: null },
    };
    const result = buildOldSchemeForEvaluation(currentScheme, oldSnapshot);
    expect(result.status).toBe("Active");
    expect(result.name).toBe("Current Name");
    expect(result.eligibilityRules.eligibilityType).toBe("universal");
    expect(result.eligibilityRules.minAge).toBeNull();
  });

  test("falls back to empty rules when snapshot is null", () => {
    const currentScheme = makeScheme();
    const result = buildOldSchemeForEvaluation(currentScheme, null);
    expect(result.eligibilityRules).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIT TESTS: buildTriggeringChangeId
// ─────────────────────────────────────────────────────────────────────────────

describe("buildTriggeringChangeId()", () => {
  test("produces the expected key format", () => {
    expect(buildTriggeringChangeId("SCH_001", 3)).toBe("SCH_001:v3");
    expect(buildTriggeringChangeId("myScheme:XYZ", 1)).toBe("myScheme:XYZ:v1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIT TESTS: buildNewlyEligibleExplanation
// ─────────────────────────────────────────────────────────────────────────────

describe("buildNewlyEligibleExplanation()", () => {
  test("generates age range sentence when user age is available", () => {
    const diffs = [
      { field: "eligibilityRules.minAge", oldValue: null, newValue: 25 },
      { field: "eligibilityRules.maxAge", oldValue: null, newValue: 45 },
    ];
    const profile = { age: 30 };
    const text = buildNewlyEligibleExplanation(diffs, profile, "Test Scheme");
    expect(text).toMatch(/30/);      // user's age
    expect(text).toMatch(/25[–-]45/); // range
  });

  test("falls back to generic message when no specific template matches", () => {
    const diffs = [
      { field: "eligibilityRules.courses", oldValue: [], newValue: ["Engineering"] },
    ];
    const profile = { age: 22, course: "Engineering" };
    const text = buildNewlyEligibleExplanation(diffs, profile, "Engineering Scholarship");
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});
