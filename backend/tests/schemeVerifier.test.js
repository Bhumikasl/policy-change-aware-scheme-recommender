/**
 * schemeVerifier tests — mock the llmClient so tests never touch the network.
 */
jest.mock("../src/services/llmClient", () => ({
  generateStructured: jest.fn(),
  _resetDisabled: jest.fn(),
}));

const { generateStructured } = require("../src/services/llmClient");
const { verifyEligibility, decideRecommendation, userProfileHash, cacheKey, _clearCache } = require("../src/services/schemeVerifier");

const scheme = (overrides = {}) => ({
  schemeId: "s1", name: "PM-KISAN",
  description: "Support for small farmers.",
  eligibility: "Small and marginal farmers in India.",
  benefits: "Rs 6000/year.",
  documents: ["Aadhaar Card"],
  contentHash: "abc123",
  ...overrides,
});
const user = (p = {}) => ({ email: "u@x.com", profile: { categories: [], documentsAvailable: [], ...p } });

beforeEach(() => {
  _clearCache();
  generateStructured.mockReset();
});

describe("cacheKey / userProfileHash", () => {
  test("same profile + same scheme → same key", () => {
    expect(cacheKey(user({ age: 25 }), scheme())).toBe(cacheKey(user({ age: 25 }), scheme()));
  });
  test("category order does not affect hash", () => {
    expect(userProfileHash(user({ categories: ["SC", "BPL"] })))
      .toBe(userProfileHash(user({ categories: ["BPL", "SC"] })));
  });
  test("different profile → different key", () => {
    expect(cacheKey(user({ age: 25 }), scheme())).not.toBe(cacheKey(user({ age: 30 }), scheme()));
  });
});

describe("verifyEligibility — LLM mocked", () => {
  test("returns null when llmClient returns null", async () => {
    generateStructured.mockResolvedValueOnce(null);
    expect(await verifyEligibility(user(), scheme())).toBeNull();
  });
  test("verified=true path", async () => {
    generateStructured.mockResolvedValueOnce({
      verified: true, confidence: 0.85,
      matchedCriteria: ["Is a farmer"], failedCriteria: [], missingInformation: [],
      reasoning: "Profile satisfies every criterion.",
    });
    const r = await verifyEligibility(user({ occupation: "Farmer" }), scheme());
    expect(r.verified).toBe(true);
    expect(r.matchedCriteria).toContain("Is a farmer");
    expect(r.cached).toBe(false);
  });
  test("second call hits cache — no second LLM call", async () => {
    generateStructured.mockResolvedValueOnce({
      verified: true, confidence: 0.9,
      matchedCriteria: [], failedCriteria: [], missingInformation: [], reasoning: "",
    });
    await verifyEligibility(user(), scheme());
    const r2 = await verifyEligibility(user(), scheme());
    expect(r2.cached).toBe(true);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });
  test("passes provider-appropriate opts to llmClient", async () => {
    process.env.LLM_PROVIDER = "groq";
    process.env.GROQ_MODEL = "llama-3.1-8b-instant";
    generateStructured.mockResolvedValueOnce({ verified: true, confidence: 0.9, matchedCriteria: [], failedCriteria: [], missingInformation: [], reasoning: "" });
    await verifyEligibility(user(), scheme());
    const call = generateStructured.mock.calls[0];
    expect(call[3].model).toBe("llama-3.1-8b-instant");
    expect(call[3].geminiSchema).toBeUndefined();
    delete process.env.LLM_PROVIDER;
    delete process.env.GROQ_MODEL;
  });
});

describe("decideRecommendation", () => {
  const eligibleRules = { eligible: true, mode: "rules", score: 3, matched: [], failed: [], noConstraint: [] };
  const rejectedRules = { eligible: false, mode: "rules", score: -100, matched: [], failed: [{ rule: "age" }], noConstraint: [] };
  const okVerdict = { verified: true, confidence: 0.9, matchedCriteria: ["A"], failedCriteria: [], missingInformation: [], reasoning: "ok" };
  const missVerdict = { verified: false, confidence: 0.4, matchedCriteria: [], failedCriteria: [], missingInformation: ["Domicile certificate"], reasoning: "need doc" };
  const vetoVerdict = { verified: false, confidence: 0.8, matchedCriteria: [], failedCriteria: ["wrong occupation"], missingInformation: [], reasoning: "no" };

  test("rules reject → recommend=false whatever the verifier says", () => {
    expect(decideRecommendation(rejectedRules, okVerdict).recommend).toBe(false);
  });
  test("rules pass + verifier unavailable → rules-only", () => {
    expect(decideRecommendation(eligibleRules, null).stage).toBe("rules-only");
  });
  test("rules pass + verifier confirms → rules+llm", () => {
    expect(decideRecommendation(eligibleRules, okVerdict).stage).toBe("rules+llm");
  });
  test("rules pass + verifier says missing info only → recommend=true, needsMoreInfo=true", () => {
    const d = decideRecommendation(eligibleRules, missVerdict);
    expect(d.recommend).toBe(true);
    expect(d.needsMoreInfo).toBe(true);
  });
  test("rules pass + verifier finds failing criterion → recommend=false (veto)", () => {
    const d = decideRecommendation(eligibleRules, vetoVerdict);
    expect(d.recommend).toBe(false);
    expect(d.stage).toBe("verifier-veto");
    expect(d.disagreement).toBe(true);
  });
});
