/**
 * relevanceRanker tests — pure, no DB, no network.
 *
 * These lock in the core claim: eligibility and relevance are different
 * questions. Two schemes can both be eligible while one is obviously the
 * better recommendation.
 */
const {
  rankCandidates,
  buildUserQuery,
  specificityScore,
  benefitScore,
  tokenize,
  _clearIdfCache,
} = require("../src/services/relevanceRanker");

beforeEach(() => _clearIdfCache());

const baseRules = {
  minAge: null, maxAge: null,
  minAnnualIncome: null, maxAnnualIncome: null,
  minMarksPercentage: null, minEducationLevel: null,
  genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
  source: "deterministic", eligibilityType: "constrained",
  confidence: 0.5, needsReview: false,
};

function scheme(over = {}) {
  const { rules, ...rest } = over;
  return {
    schemeId: over.schemeId || "s",
    name: "", description: "", eligibility: "", benefits: "",
    tags: [], category: [], documents: [], state: "All India", lastDate: "",
    eligibilityRules: { ...baseRules, ...(rules || {}) },
    ...rest,
  };
}

function candidate(s, positives = 1, docReady = { required: 0, have: 0, missing: [] }) {
  return {
    scheme: s,
    verdict: {
      eligible: true, score: positives, mode: "rules",
      eligibilityType: s.eligibilityRules.eligibilityType,
      matched: Array.from({ length: positives }, (_, i) => ({ rule: `r${i}`, reason: "ok" })),
      positiveMatches: Array.from({ length: positives }, (_, i) => ({ rule: `r${i}`, reason: "ok" })),
      failed: [], noConstraint: [],
    },
    documentReadiness: docReady,
  };
}

const student = {
  email: "u@x.com",
  profile: {
    state: "Karnataka", gender: "Female", age: 22, occupation: "Student",
    education: "Graduate", annualIncome: 150000, categories: ["OBC"],
    documentsAvailable: ["Aadhaar Card"],
  },
};

describe("tokenize", () => {
  test("drops stopwords and short tokens", () => {
    expect(tokenize("The scheme is for a student in India")).toEqual(["student"]);
  });
  test("splits on slashes and hyphens", () => {
    expect(tokenize("SC/ST post-matric")).toEqual(expect.arrayContaining(["post", "matric"]));
  });
});

describe("buildUserQuery", () => {
  test("includes direct profile facts at full weight", () => {
    const q = buildUserQuery(student);
    expect(q.get("karnataka")).toBe(1.0);
    expect(q.get("student")).toBe(1.0);
    expect(q.get("obc")).toBe(1.0);
  });
  test("expands occupation into intent vocabulary", () => {
    const q = buildUserQuery(student);
    expect(q.get("scholarship")).toBe(0.6);
    expect(q.get("education")).toBe(0.6);
  });
  test("explicit intent outweighs inferred terms", () => {
    const q = buildUserQuery(student, "looking for scholarship");
    expect(q.get("scholarship")).toBe(2.5);
  });
  test("female profile pulls in women-scheme vocabulary", () => {
    const q = buildUserQuery(student);
    expect(q.has("mahila")).toBe(true);
  });
});

describe("specificityScore", () => {
  test("counts declared constraints", () => {
    expect(specificityScore({ ...baseRules, minAge: 18, genders: ["Female"], states: ["Karnataka"] })).toBe(3);
  });
  test("universal scheme with no constraints scores 0", () => {
    expect(specificityScore(baseRules)).toBe(0);
  });
});

describe("benefitScore", () => {
  test("cash benefit scores positive", () => {
    expect(benefitScore({ name: "X", benefits: "₹50,000 per annum scholarship" })).toBeGreaterThan(0);
  });
  test("award with only a medal is demoted", () => {
    expect(benefitScore({ name: "National Award", benefits: "Certificate and memento" })).toBeLessThan(0);
  });
  test("award WITH cash is not demoted", () => {
    expect(benefitScore({ name: "National Award", benefits: "₹1,00,000 and a medal" })).toBeGreaterThan(0);
  });
});

describe("rankCandidates — the core claim", () => {
  test("a topically-relevant scheme outranks a generic one the user also qualifies for", () => {
    const scholarship = scheme({
      schemeId: "scholarship",
      name: "Post Matric Scholarship for OBC Students",
      description: "Financial assistance for OBC students pursuing higher education.",
      eligibility: "OBC students studying at post-matriculation level.",
      benefits: "₹50,000 per annum towards tuition.",
      tags: ["Scholarship", "Student", "OBC"],
      rules: { occupations: ["Student"], categories: ["OBC"], categoryGroups: [["OBC"]], confidence: 0.8 },
    });
    const savings = scheme({
      schemeId: "savings",
      name: "Post Office Savings Account",
      description: "Encourages people to save money safely.",
      eligibility: "Any resident citizen of India above 10 years.",
      benefits: "4% interest.",
      tags: ["Banking"],
      rules: { minAge: 10, confidence: 0.25 },
    });

    const ranked = rankCandidates([candidate(savings, 1), candidate(scholarship, 2)], student);
    expect(ranked[0].scheme.schemeId).toBe("scholarship");
    expect(ranked[0].relevance).toBeGreaterThan(ranked[1].relevance);
  });

  test("universal schemes rank below targeted ones", () => {
    const targeted = scheme({
      schemeId: "targeted",
      name: "Karnataka OBC Student Aid",
      eligibility: "OBC students resident in Karnataka.",
      benefits: "₹20,000 grant",
      tags: ["Student", "OBC"],
      rules: { states: ["Karnataka"], occupations: ["Student"], confidence: 0.8 },
    });
    const universal = scheme({
      schemeId: "universal",
      name: "Padma Awards",
      eligibility: "Open to all citizens.",
      benefits: "Medal and certificate",
      rules: { eligibilityType: "universal", confidence: 0.2 },
    });

    const ranked = rankCandidates([candidate(universal, 1), candidate(targeted, 3)], student);
    expect(ranked[0].scheme.schemeId).toBe("targeted");
  });

  test("free-text intent reorders the results", () => {
    const loan = scheme({
      schemeId: "loan",
      name: "Mudra Loan for Small Business",
      description: "Credit for micro enterprises and entrepreneurs.",
      eligibility: "Any small business owner.",
      benefits: "Loan up to ₹10 lakh",
      tags: ["Loan", "Business"],
      rules: { confidence: 0.6 },
    });
    const scholarship = scheme({
      schemeId: "scholarship",
      name: "Merit Scholarship for Graduates",
      description: "Scholarship for graduate students.",
      eligibility: "Graduate students.",
      benefits: "₹30,000 per year",
      tags: ["Scholarship", "Student"],
      rules: { occupations: ["Student"], confidence: 0.6 },
    });
    const pool = [candidate(loan, 1), candidate(scholarship, 1)];

    // Default (Student profile) → scholarship wins on expansion terms.
    expect(rankCandidates(pool, student)[0].scheme.schemeId).toBe("scholarship");

    // Explicit intent for a loan flips it — intent terms weigh 2x.
    _clearIdfCache();
    const withIntent = rankCandidates(pool, student, { intent: "I need a business loan for my enterprise" });
    expect(withIntent[0].scheme.schemeId).toBe("loan");
  });

  test("document readiness lifts an otherwise equal scheme", () => {
    const common = {
      name: "State Aid Scheme", description: "Assistance", eligibility: "Residents",
      benefits: "₹10,000", tags: [], rules: { states: ["Karnataka"], confidence: 0.5 },
    };
    const ready = scheme({ ...common, schemeId: "ready", documents: ["Aadhaar Card"] });
    const notReady = scheme({ ...common, schemeId: "notready", documents: ["Domicile Certificate"] });

    const ranked = rankCandidates(
      [
        candidate(notReady, 1, { required: 1, have: 0, missing: ["Domicile Certificate"] }),
        candidate(ready, 1, { required: 1, have: 1, missing: [] }),
      ],
      student
    );
    expect(ranked[0].scheme.schemeId).toBe("ready");
  });

  test("returns a breakdown for every signal", () => {
    const s = scheme({ schemeId: "x", name: "Student Scholarship", benefits: "₹1,000" });
    const [top] = rankCandidates([candidate(s, 1)], student);
    expect(top.relevanceBreakdown).toEqual(
      expect.objectContaining({
        lexical: expect.any(Number),
        specificity: expect.any(Number),
        benefit: expect.any(Number),
        documents: expect.any(Number),
        confidence: expect.any(Number),
      })
    );
  });

  test("empty candidate list returns empty", () => {
    expect(rankCandidates([], student)).toEqual([]);
  });

  test("ranking is stable — same input, same order", () => {
    const a = scheme({ schemeId: "a", name: "Student Scholarship Alpha", benefits: "₹1,000" });
    const b = scheme({ schemeId: "b", name: "Farmer Subsidy Beta", benefits: "₹2,000" });
    const pool = [candidate(a, 1), candidate(b, 1)];
    const first = rankCandidates(pool, student).map((c) => c.scheme.schemeId);
    _clearIdfCache();
    const second = rankCandidates(pool, student).map((c) => c.scheme.schemeId);
    expect(first).toEqual(second);
  });
});
