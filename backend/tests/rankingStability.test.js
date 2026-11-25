/**
 * PHASE T — ranking order-invariance, and the defect it found.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * `rankCandidates` sorted on relevance, then eligibility score, and stopped.
 * Two schemes tying on both fell through to the order the array arrived in —
 * and `Array.prototype.sort` being stable means that is the CALLER's order,
 * which comes from an unsorted `Scheme.find()`. MongoDB guarantees nothing
 * about the order of an unsorted query, so the same two schemes could come back
 * a,b on one cycle and b,a on the next.
 *
 * The consequence was not a cosmetic reshuffle:
 *
 *     rank 1 -> 2
 *       -> classifyRecommendationTransition = RANK_DECREASED
 *       -> decideNotification               = shouldNotify: true
 *       -> "<Scheme> moved down your recommendations"
 *       -> plus a RecommendationHistory row asserting a movement
 *
 * A false notification AND a false entry in the audit trail this project treats
 * as evidence — for a change that never happened.
 *
 * ---------------------------------------------------------------------------
 * WHY EIGHTEEN RANKING TESTS MISSED IT
 * ---------------------------------------------------------------------------
 * Every one of them asserts one ranking against one expected order. They pass
 * whether or not the comparator resolves ties, because each only ever sees the
 * input in a single arrangement. Testing the PROPERTY — same set, any order,
 * same result — is what catches it, so that is what these do.
 */
const {
  checkOrderInvariance,
  tieGroups,
  totalOrderCheck,
  permute,
} = require("../src/evaluation/rankingStability");
const { rankCandidates, _clearIdfCache } = require("../src/services/relevanceRanker");
const { classifyRecommendationTransition } = require("../src/services/recommendationPropagation");
const { decideNotification } = require("../src/agents/notificationAgent");

const rules = (over = {}) => ({
  minAge: null, maxAge: null, maxAnnualIncome: null, minAnnualIncome: null,
  minMarksPercentage: null, minEducationLevel: null,
  genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
  eligibilityType: "universal", source: "structured", confidence: 0.9, needsReview: false,
  ...over,
});

/** Two of these are indistinguishable to every ranking signal. */
const scheme = (id, over = {}) => ({
  schemeId: id,
  name: "Support Scheme",
  description: "general welfare support",
  eligibility: "Open to all citizens of India.",
  benefits: "financial assistance of Rs 10000",
  documents: [], tags: ["Welfare"], status: "active", ministry: "M", state: "",
  category: ["Welfare"], lastDate: "", version: 2,
  eligibilityRules: rules(),
  ...over,
});

const candidate = (id, over = {}) => ({
  scheme: scheme(id, over),
  verdict: { eligible: true, score: 1, positiveMatches: [], failed: [] },
});

const user = {
  _id: "u1",
  profile: { age: 30, annualIncome: 100000, state: "Kerala", categories: [], documentsAvailable: [] },
};

const rankIds = (list) => {
  _clearIdfCache();
  return rankCandidates(list, user, {}).map((c) => c.scheme.schemeId);
};

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------
describe("T — the ranking is a function of the candidate SET, not its order", () => {
  it("gives identical output for the same schemes in a different input order", () => {
    // The exact reproduction. Before the final tie-break these two returned
    // reversed rankings, because the only thing separating them was the order
    // the array arrived in.
    const a = rankIds([candidate("scheme-a"), candidate("scheme-b")]);
    const b = rankIds([candidate("scheme-b"), candidate("scheme-a")]);
    expect(a).toEqual(b);
  });

  it("stays stable across many permutations of a larger tied pool", () => {
    const pool = ["s-01", "s-02", "s-03", "s-04", "s-05", "s-06"].map((id) => candidate(id));
    const out = checkOrderInvariance({
      rank: rankCandidates,
      candidates: pool,
      user,
      permutations: 30,
      clearCache: _clearIdfCache,
    });
    expect(out.status).toBe("STABLE");
    expect(out.disagreementCount).toBe(0);
  });

  it("resolves ties by a UNIQUE key, so the order is total", () => {
    const pool = ["s-03", "s-01", "s-02"].map((id) => candidate(id));
    _clearIdfCache();
    const ranked = rankCandidates(pool, user, {});
    expect(totalOrderCheck(ranked).isTotalOrder).toBe(true);
    // All three tie on every score, so the tie-break alone decides — and it
    // must decide the same way every time.
    expect(ranked.map((c) => c.scheme.schemeId)).toEqual(["s-01", "s-02", "s-03"]);
  });

  it("does NOT disturb candidates the scores already separate", () => {
    // The fix must be inert wherever the first two keys differ. A tie-break
    // that reordered genuinely-different candidates would be a worse bug than
    // the one it replaced.
    const strong = candidate("z-best", {
      description: "scholarship for students education tuition",
      tags: ["Scholarship", "Education", "Student"],
    });
    const weak = candidate("a-worst", { description: "unrelated", tags: [] });
    const studentUser = {
      _id: "u2",
      profile: { age: 20, annualIncome: 50000, state: "Kerala", occupation: "Student",
        education: "Graduate", categories: [], documentsAvailable: [] },
    };
    _clearIdfCache();
    const ranked = rankCandidates([weak, strong], studentUser, {});
    // Alphabetically "a-worst" precedes "z-best"; relevance must still win.
    expect(ranked[0].scheme.schemeId).toBe("z-best");
  });
});

// ---------------------------------------------------------------------------
// Why it mattered
// ---------------------------------------------------------------------------
describe("T — an unstable rank becomes a false notification", () => {
  /**
   * Documents the blast radius as executable fact rather than prose. If a rank
   * ever moves without cause, this is precisely what the user receives.
   */
  it("turns a one-position move into a 'moved down' email", () => {
    const transition = classifyRecommendationTransition(
      { inTopK: true, rank: 1 },
      { inTopK: true, rank: 2 }
    );
    expect(transition).toBe("RANK_DECREASED");

    const decision = decideNotification({
      record: {
        schemeId: "s", schemeName: "Support Scheme",
        eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
        recommendationTransition: transition,
        reason: { code: "", changedFields: [] },
      },
      notificationPrefs: {},
    });

    expect(decision.shouldNotify).toBe(true);
    expect(decision.title).toMatch(/moved down/i);
  });
});

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------
describe("T — the stability instrument", () => {
  it("DETECTS an unstable comparator", () => {
    // Without this the whole phase is unfalsifiable: an instrument that reports
    // STABLE for everything would report STABLE for the original defect too.
    const unstable = (list) => [...list]; // returns input order verbatim
    const out = checkOrderInvariance({
      rank: unstable,
      candidates: ["a", "b", "c", "d"].map((id) => ({ schemeId: id })),
      user,
      permutations: 20,
    });
    expect(out.status).toBe("UNSTABLE");
    expect(out.disagreementCount).toBeGreaterThan(0);
    expect(out.disagreements[0].firstDivergenceAt).toBeGreaterThanOrEqual(0);
  });

  it("reports NOT_MEASURED for a list too short to reorder", () => {
    // One candidate cannot demonstrate order-invariance. Calling that STABLE
    // would pad a run with cases that tested nothing.
    const out = checkOrderInvariance({
      rank: rankCandidates, candidates: [candidate("only")], user, permutations: 10,
    });
    expect(out.status).toBe("NOT_MEASURED");
    expect(out.permutations).toBe(0);
  });

  it("permutes deterministically, so a result can be reproduced", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(permute(items, 42)).toEqual(permute(items, 42));
    expect(permute(items, 42)).not.toEqual(permute(items, 43));
    // And it is a permutation, not a resample.
    expect([...permute(items, 7)].sort((a, b) => a - b)).toEqual(items);
  });

  it("counts tie groups, so a vacuous pass is visible", () => {
    // STABLE over a pool with no ties proves nothing about the tie-break. The
    // report prints this alongside the verdict for exactly that reason.
    const tied = tieGroups([
      { relevance: 1, verdict: { score: 1 } },
      { relevance: 1, verdict: { score: 1 } },
      { relevance: 2, verdict: { score: 1 } },
    ]);
    expect(tied.tieGroups).toBe(1);
    expect(tied.largestGroup).toBe(2);

    const distinct = tieGroups([
      { relevance: 3, verdict: { score: 1 } },
      { relevance: 2, verdict: { score: 1 } },
    ]);
    expect(distinct.tieGroups).toBe(0);
    expect(distinct.largestGroup).toBe(0);
  });

  it("flags a comparator whose tie-break key is not unique", () => {
    const dupes = totalOrderCheck([{ schemeId: "x" }, { schemeId: "x" }]);
    expect(dupes.isTotalOrder).toBe(false);
    expect(dupes.duplicateKeys).toContain("x");
  });
});
