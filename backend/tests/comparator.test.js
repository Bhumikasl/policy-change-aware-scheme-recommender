/**
 * Comparator tests. Focus on the pure diffFields function — reconcile()
 * needs Mongoose so we don't cover it in unit tests (the API/e2e test
 * suite exercises reconcile indirectly).
 */
const { diffFields } = require("../src/services/comparator");
const { normalize } = require("../src/normalizer/normalizer");

function raw(overrides = {}) {
  return {
    schemeId: "test",
    name: "Kisan Yojana",
    description: "Support for farmers",
    eligibility: "Farmers below 60",
    eligibilityRules: { minAge: null, maxAge: 60, genders: [], categories: [], occupations: ["Farmer"], states: [], source: "structured", eligibilityType: "constrained", confidence: 0.6, needsReview: false },
    benefits: "Rs 6000 per year",
    documents: ["Aadhaar Card"],
    lastDate: "2026-12-31",
    applicationLink: "https://example.gov.in",
    ministry: "Agriculture",
    state: "All India",
    category: ["Farmer"],
    tags: ["Farmer"],
    status: "Active",
    ...overrides,
  };
}

describe("comparator.diffFields", () => {
  test("identical docs → no diff", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw(), "myScheme");
    expect(diffFields(a, b)).toEqual([]);
  });
  test("description change is diffed", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ description: "Updated blurb" }), "myScheme");
    expect(diffFields(a, b).map((d) => d.field)).toContain("description");
  });
  test("eligibility text change diffed", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ eligibility: "Farmers below 65" }), "myScheme");
    expect(diffFields(a, b).map((d) => d.field)).toContain("eligibility");
  });
  test("eligibilityRules.maxAge change diffed as sub-field", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ eligibilityRules: { ...raw().eligibilityRules, maxAge: 65 } }), "myScheme");
    const fields = diffFields(a, b).map((d) => d.field);
    expect(fields).toContain("eligibilityRules.maxAge");
  });
  test("only metadata changed (confidence) → no diff", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ eligibilityRules: { ...raw().eligibilityRules, confidence: 0.99 } }), "myScheme");
    expect(diffFields(a, b)).toEqual([]);
  });
  test("benefits change diffed", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ benefits: "Rs 12000 per year" }), "myScheme");
    expect(diffFields(a, b).map((d) => d.field)).toContain("benefits");
  });
  test("lastDate change diffed", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ lastDate: "2027-06-30" }), "myScheme");
    expect(diffFields(a, b).map((d) => d.field)).toContain("lastDate");
  });
  test("multiple fields changed", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ description: "new", benefits: "new", lastDate: "2027-01-01" }), "myScheme");
    const fields = diffFields(a, b).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["description", "benefits", "lastDate"]));
  });
});

describe("normalize contentHash", () => {
  test("same input → same hash (metadata does not affect hash)", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ eligibilityRules: { ...raw().eligibilityRules, confidence: 0.99, extractedAt: new Date() } }), "myScheme");
    expect(a.contentHash).toBe(b.contentHash);
  });
  test("different eligibility rules → different hash", () => {
    const a = normalize(raw(), "myScheme");
    const b = normalize(raw({ eligibilityRules: { ...raw().eligibilityRules, maxAge: 70 } }), "myScheme");
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
