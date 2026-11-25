/**
 * Hybrid extractor tests — mock the LLM to make deterministic-vs-LLM
 * merge behavior fully unit-testable, no network.
 */
jest.mock("../src/services/eligibilityExtractor", () => ({
  extractEligibility: jest.fn(),
}));
const { extractEligibility: mockLlm } = require("../src/services/eligibilityExtractor");
const { extractHybrid, merge, classifyEligibilityType } = require("../src/services/hybridExtractor");

beforeEach(() => mockLlm.mockReset());

describe("merge — deterministic wins on numeric conflict", () => {
  test("keeps deterministic value when LLM disagrees", () => {
    const det = { minAge: 18, maxAge: 40, minAnnualIncome: null, maxAnnualIncome: 200000, minMarksPercentage: null, minEducationLevel: null, genders: [], categories: [], occupations: [], states: [] };
    const llm = { minAge: 21, maxAge: 40, minAnnualIncome: null, maxAnnualIncome: 500000, minMarksPercentage: null, minEducationLevel: null, genders: [], categories: [], occupations: [], states: [] };
    const { merged, provenance, conflicts } = merge(det, llm);
    expect(merged.minAge).toBe(18); // deterministic wins
    expect(merged.maxAnnualIncome).toBe(200000);
    expect(provenance.minAge).toBe("deterministic");
    expect(conflicts.length).toBeGreaterThan(0);
  });
  test("fills gap from LLM when deterministic has null", () => {
    const det = { minAge: null, maxAge: null, minAnnualIncome: null, maxAnnualIncome: null, minMarksPercentage: null, minEducationLevel: null, genders: [], categories: [], occupations: [], states: [] };
    const llm = { minAge: 21, maxAge: 40, minAnnualIncome: null, maxAnnualIncome: 500000, minMarksPercentage: null, minEducationLevel: null, genders: ["Female"], categories: [], occupations: [], states: [] };
    const { merged, provenance } = merge(det, llm);
    expect(merged.minAge).toBe(21);
    expect(merged.genders).toEqual(["Female"]);
    expect(provenance.minAge).toBe("llm");
  });
});

describe("merge — array intersection", () => {
  test("intersection kept when both agree on at least one", () => {
    const det = { genders: ["Female"], categories: ["SC", "ST"], occupations: [], states: [] };
    const llm = { genders: ["Female"], categories: ["ST", "OBC"], occupations: [], states: [] };
    const { merged } = merge(det, llm);
    expect(merged.categories).toEqual(["ST"]);
    expect(merged.genders).toEqual(["Female"]);
  });
});

describe("classifyEligibilityType", () => {
  test("any signal → constrained", () => {
    expect(classifyEligibilityType({ minAge: 18, states: [] }, "constrained", false)).toBe("constrained");
  });
  test("no signals + universal wording → universal", () => {
    expect(classifyEligibilityType({ minAge: null, maxAge: null, genders: [], categories: [], occupations: [], states: [], minEducationLevel: null, minAnnualIncome: null, maxAnnualIncome: null, minMarksPercentage: null }, "universal", false)).toBe("universal");
  });
  test("no signals + unknown wording → unknown", () => {
    expect(classifyEligibilityType({ minAge: null, maxAge: null, genders: [], categories: [], occupations: [], states: [], minEducationLevel: null, minAnnualIncome: null, maxAnnualIncome: null, minMarksPercentage: null }, "unknown", false)).toBe("unknown");
  });
});

describe("extractHybrid — end-to-end with mocked LLM", () => {
  test("deterministic only — LLM disabled", async () => {
    const r = await extractHybrid("Women farmers in Karnataka aged 21-50 with annual income up to 3 lakh", { useLlm: false });
    expect(r.eligibilityType).toBe("constrained");
    expect(r.minAge).toBe(21);
    expect(r.maxAge).toBe(50);
    expect(r.maxAnnualIncome).toBe(300000);
    expect(r.states).toContain("Karnataka");
    expect(r.needsReview).toBe(false);
  });
  test("LLM fills a gap when deterministic misses education", async () => {
    mockLlm.mockResolvedValueOnce({
      minAge: null, maxAge: null, minAnnualIncome: null, maxAnnualIncome: null,
      minMarksPercentage: 60, minEducationLevel: "Graduate",
      genders: [], categories: [], occupations: [], states: [], confidence: 0.6,
    });
    const r = await extractHybrid("Scholarship for graduates scoring at least 60 percent aggregate", { useLlm: true });
    expect(r.minEducationLevel).toBe("Graduate");
    expect(r.minMarksPercentage).toBe(60);
  });
  test("LLM disagreement flags conflict & lowers confidence", async () => {
    mockLlm.mockResolvedValueOnce({
      minAge: 30, maxAge: 40, minAnnualIncome: null, maxAnnualIncome: null,
      minMarksPercentage: null, minEducationLevel: null,
      genders: [], categories: [], occupations: [], states: [], confidence: 0.6,
    });
    const r = await extractHybrid("Age 18 to 40 years", { useLlm: true });
    expect(r.minAge).toBe(18); // deterministic wins
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.needsReview).toBe(true);
  });
  test("universal fallback when no signals and LLM returns none either", async () => {
    mockLlm.mockResolvedValueOnce({
      minAge: null, maxAge: null, minAnnualIncome: null, maxAnnualIncome: null,
      minMarksPercentage: null, minEducationLevel: null,
      genders: [], categories: [], occupations: [], states: [], confidence: 0.4,
    });
    const r = await extractHybrid("This scheme is open to all Indian citizens.", { useLlm: true });
    expect(r.eligibilityType).toBe("universal");
  });
  test("LLM throws → deterministic still runs", async () => {
    mockLlm.mockRejectedValueOnce(new Error("boom"));
    const r = await extractHybrid("Age 18 to 40 years, SC candidates", { useLlm: true });
    expect(r.minAge).toBe(18);
    expect(r.eligibilityType).toBe("constrained");
  });
});
