/**
 * Phase K — the Explanation Agent.
 *
 * The agent's one rule is that every fact in the output already exists in the
 * input. Most of this suite is about that rule holding under pressure: an LLM
 * that invents a figure, an LLM that is unavailable, a record with nothing in
 * it, a template that would print a number it cannot justify.
 *
 * The rest is about what the agent must NOT say — a user whose income moved
 * should not have their categories recited back at them.
 */
const {
  explainTransition,
  isGrounded,
  numeralsIn,
  buildGroundingNumbers,
  warrantsSynthesis,
} = require("../src/agents/explanationAgent");
const { describeChange, relevantFactors, rupees } = require("../src/services/explanationTemplates");

// ---------------------------------------------------------------------------
// Fixtures — the acceptance scenario
// ---------------------------------------------------------------------------
const INCOME_RECORD = {
  schemeId: "merit-scholarship",
  schemeName: "State Merit Scholarship",
  triggeringChangeId: "merit-scholarship:v2",
  previousSchemeVersion: 1,
  newSchemeVersion: 2,
  previousEligibility: false,
  newEligibility: true,
  eligibilityTransition: "INELIGIBLE_TO_ELIGIBLE",
  previousRecommendationStatus: "NOT_RECOMMENDED",
  newRecommendationStatus: "RECOMMENDED",
  recommendationTransition: "NOT_RECOMMENDED_TO_RECOMMENDED",
  previousRank: null,
  newRank: 3,
  topK: 10,
  reason: {
    code: "BECAME_ELIGIBLE",
    summary: "Now eligible: annualIncome",
    changedFields: [
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
    ],
    rulesNowPassing: ["annualIncome"],
    rulesNowFailing: [],
  },
};

const PROFILE = {
  age: 22,
  annualIncome: 280000,
  education: "Graduate",
  state: "Karnataka",
  occupation: "Student",
  gender: "Female",
  categories: ["OBC"],
  marksPercentage: 78,
};

const noLlm = { useLlm: false };

// ---------------------------------------------------------------------------
describe("rupees formatting", () => {
  it("uses lakh and crore, as the people this serves read money", () => {
    expect(rupees(250000)).toBe("₹2.5 lakh");
    expect(rupees(300000)).toBe("₹3 lakh");
    expect(rupees(10000000)).toBe("₹1 crore");
    expect(rupees(50000)).toBe("₹50,000");
  });

  it("returns null for a non-number rather than printing NaN", () => {
    expect(rupees(null)).toBeNull();
    expect(rupees("abc")).toBeNull();
  });
});

describe("describeChange", () => {
  it("names the direction of a numeric move", () => {
    expect(
      describeChange({ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 })
        .sentence
    ).toBe("The annual income limit increased from ₹2.5 lakh to ₹3 lakh.");
    expect(
      describeChange({ field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000 })
        .sentence
    ).toBe("The annual income limit decreased from ₹3 lakh to ₹2.5 lakh.");
  });

  it("reads a deadline correctly in both directions", () => {
    expect(
      describeChange({ field: "lastDate", oldValue: "2026-03-31", newValue: "2026-06-30" }).sentence
    ).toMatch(/extended/);
    expect(
      describeChange({ field: "lastDate", oldValue: "2026-06-30", newValue: "2026-03-31" }).sentence
    ).toMatch(/brought forward/);
  });

  it("returns null for a field it cannot phrase", () => {
    // Better to say nothing than to show a user "eligibilityRules.foo changed".
    expect(describeChange({ field: "someInternalField", oldValue: 1, newValue: 2 })).toBeNull();
  });
});

describe("relevantFactors", () => {
  it("includes only attributes the moved rules concern", () => {
    const factors = relevantFactors({ rulesNowPassing: ["annualIncome"], profile: PROFILE });
    expect(factors.map((f) => f.attribute)).toEqual(["annualIncome"]);
  });

  it("does not leak unrelated attributes", () => {
    // An income change is no reason to restate someone's caste categories,
    // gender or age back to them.
    const factors = relevantFactors({ rulesNowPassing: ["annualIncome"], profile: PROFILE });
    const leaked = JSON.stringify(factors);
    expect(leaked).not.toContain("OBC");
    expect(leaked).not.toContain("Female");
    expect(leaked).not.toContain("Karnataka");
  });

  it("skips an attribute the user has not provided", () => {
    expect(relevantFactors({ rulesNowPassing: ["annualIncome"], profile: {} })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the acceptance explanation", () => {
  let out;
  beforeAll(async () => {
    out = await explainTransition({ record: INCOME_RECORD, profile: PROFILE, ...noLlm });
  });

  it("states the policy change, the user attribute, and the consequence", () => {
    expect(out.summary).toContain("₹2.5 lakh");
    expect(out.summary).toContain("₹3 lakh");
    expect(out.summary).toContain("₹2.8 lakh");
    expect(out.summary).toMatch(/now meet this condition/);
  });

  it("keeps the three parts separable, not just run together in prose", () => {
    expect(out.changedConditions[0].field).toBe("eligibilityRules.maxAnnualIncome");
    expect(out.userRelevantFactors[0].attribute).toBe("annualIncome");
    expect(out.eligibilityReason).toBeTruthy();
    expect(out.recommendationReason).toMatch(/added to your recommendations/);
  });

  it("needs no LLM to produce it", () => {
    expect(out.method).toBe("template");
    expect(out.confidence).toBeGreaterThan(0.9);
    expect(out.sufficientEvidence).toBe(true);
  });

  it("cites what it rests on", () => {
    const schemeSource = out.groundingSources.find((g) => g.type === "schemeField");
    expect(schemeSource.oldValue).toBe(250000);
    expect(schemeSource.newValue).toBe(300000);
    expect(schemeSource.schemeVersions).toEqual([1, 2]);
    const userSource = out.groundingSources.find((g) => g.type === "userProfile");
    expect(userSource.attribute).toBe("annualIncome");
  });

  it("mentions no attribute the change did not touch", () => {
    for (const leak of ["OBC", "Karnataka", "Female", "Student", "78"]) {
      expect(out.summary).not.toContain(leak);
    }
  });
});

// ---------------------------------------------------------------------------
describe("grounding check", () => {
  it("finds every numeral in a sentence", () => {
    expect([...numeralsIn("from ₹2.5 lakh to ₹3 lakh at position 3")]).toEqual([2.5, 3, 3]
      .filter((v, i, a) => a.indexOf(v) === i));
  });

  it("accepts a sentence whose numbers all come from the record", () => {
    const g = buildGroundingNumbers({
      changedFields: INCOME_RECORD.reason.changedFields,
      factors: [{ value: 280000 }],
      newRank: 3,
    });
    expect(isGrounded("The limit rose from ₹2.5 lakh to ₹3 lakh.", g).grounded).toBe(true);
  });

  it("rejects a sentence containing a number the record does not have", () => {
    // This is the hallucination shape: fluent, plausible, and wrong.
    const g = buildGroundingNumbers({
      changedFields: INCOME_RECORD.reason.changedFields,
      factors: [{ value: 280000 }],
    });
    const check = isGrounded("The limit rose from ₹2.5 lakh to ₹3.5 lakh.", g);
    expect(check.grounded).toBe(false);
    expect(check.unexplained).toContain(3.5);
  });

  it("does not flag a year as ungrounded", () => {
    // A formatted date legitimately contains 2026 when the stored value is
    // "2026-12-31"; the date is grounded by the field it came from.
    const g = buildGroundingNumbers({
      changedFields: [{ field: "lastDate", oldValue: "2026-03-31", newValue: "2026-06-30" }],
    });
    expect(isGrounded("The deadline moved to 30 June 2026.", g).grounded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("insufficient evidence", () => {
  it("refuses to explain an eligibility flip with no field behind it", async () => {
    // "Your eligibility changed" with no cause is not an explanation; it is a
    // confident-sounding blank.
    const out = await explainTransition({
      record: { ...INCOME_RECORD, reason: { code: "BECAME_ELIGIBLE", changedFields: [], rulesNowPassing: [] } },
      profile: PROFILE,
      ...noLlm,
    });
    expect(out.sufficientEvidence).toBe(false);
    expect(out.confidence).toBe(0);
    expect(out.summary).toMatch(/not contain enough detail/);
  });

  it("says so rather than guessing when nothing is phrasable", async () => {
    const out = await explainTransition({
      record: {
        ...INCOME_RECORD,
        eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
        recommendationTransition: "NO_CHANGE",
        reason: { code: "UNKNOWN", changedFields: [{ field: "internalThing", oldValue: 1, newValue: 2 }] },
      },
      profile: PROFILE,
      ...noLlm,
    });
    expect(out.sufficientEvidence).toBe(false);
  });

  it("never invents a threshold to fill the gap", async () => {
    const out = await explainTransition({
      record: { ...INCOME_RECORD, reason: { code: "BECAME_ELIGIBLE", changedFields: [] } },
      profile: PROFILE,
      ...noLlm,
    });
    // No rupee figure at all, rather than a plausible one.
    expect(out.summary).not.toMatch(/₹/);
  });
});

// ---------------------------------------------------------------------------
describe("LLM synthesis", () => {
  const multiRecord = {
    ...INCOME_RECORD,
    reason: {
      code: "BECAME_ELIGIBLE",
      changedFields: [
        { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
        { field: "eligibilityRules.maxAge", oldValue: 21, newValue: 25 },
      ],
      rulesNowPassing: ["annualIncome", "age"],
      rulesNowFailing: [],
    },
  };

  it("is not attempted for a single simple change", () => {
    // One threshold has exactly one correct sentence. A model call would be
    // slower, cost quota, vary between runs, and could get it wrong.
    expect(
      warrantsSynthesis({ changes: [{ field: "a" }], factors: [{ attribute: "annualIncome" }] })
    ).toBe(false);
  });

  it("is attempted when several conditions moved at once", () => {
    expect(warrantsSynthesis({ changes: [{ field: "a" }, { field: "b" }], factors: [] })).toBe(true);
  });

  it("uses a grounded LLM sentence when one is produced", async () => {
    const llm = async () => ({
      summary:
        "The income limit rose from ₹2.5 lakh to ₹3 lakh and the age limit from 21 to 25. With your income of ₹2.8 lakh and age 22, you now qualify.",
      confidence: 0.9,
    });
    const out = await explainTransition({ record: multiRecord, profile: PROFILE, useLlm: true, llm });
    expect(out.method).toBe("template+llm");
    expect(out.summary).toMatch(/you now qualify/);
  });

  it("REJECTS an LLM sentence containing an invented figure", async () => {
    // The record says ₹3 lakh. A fluent wrong number is worse than a plain
    // right one, so the template stands.
    const llm = async () => ({
      summary: "The income limit rose from ₹2.5 lakh to ₹3.5 lakh, so you now qualify.",
      confidence: 0.95,
    });
    const out = await explainTransition({ record: multiRecord, profile: PROFILE, useLlm: true, llm });
    expect(out.llmRejected).toBe(true);
    expect(out.llmRejectionReason).toBe("ungrounded numerals");
    expect(out.method).toBe("template");
    expect(out.summary).not.toContain("3.5");
  });

  it("rejects a low-confidence sentence", async () => {
    const llm = async () => ({ summary: "Something changed, possibly.", confidence: 0.1 });
    const out = await explainTransition({ record: multiRecord, profile: PROFILE, useLlm: true, llm });
    expect(out.llmRejected).toBe(true);
    expect(out.method).toBe("template");
  });

  it("keeps the template when the LLM throws", async () => {
    // An outage must never cost the user their explanation.
    const llm = async () => {
      throw new Error("429 rate limited");
    };
    const out = await explainTransition({ record: multiRecord, profile: PROFILE, useLlm: true, llm });
    expect(out.sufficientEvidence).toBe(true);
    expect(out.summary).toContain("₹3 lakh");
    expect(out.llmRejectionReason).toBe("llm unavailable");
  });

  it("keeps the template when the LLM returns nothing", async () => {
    const out = await explainTransition({
      record: multiRecord, profile: PROFILE, useLlm: true, llm: async () => null,
    });
    expect(out.method).toBe("template");
    expect(out.sufficientEvidence).toBe(true);
  });

  it("never lets a synthesised sentence outrank a rendered fact", async () => {
    const llm = async () => ({ summary: "The income limit rose from ₹2.5 lakh to ₹3 lakh.", confidence: 1 });
    const out = await explainTransition({ record: multiRecord, profile: PROFILE, useLlm: true, llm });
    expect(out.confidence).toBeLessThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------
describe("other transitions", () => {
  it("explains a loss of eligibility", async () => {
    const out = await explainTransition({
      record: {
        ...INCOME_RECORD,
        eligibilityTransition: "ELIGIBLE_TO_INELIGIBLE",
        recommendationTransition: "RECOMMENDED_TO_NOT_RECOMMENDED",
        previousRank: 3,
        newRank: null,
        reason: {
          code: "LOST_ELIGIBILITY",
          changedFields: [
            { field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000 },
          ],
          rulesNowPassing: [],
          rulesNowFailing: ["annualIncome"],
        },
      },
      profile: PROFILE,
      ...noLlm,
    });
    expect(out.summary).toMatch(/decreased/);
    expect(out.summary).toMatch(/no longer meet this condition/);
    expect(out.summary).toMatch(/removed from your recommendations/);
  });

  it("explains a rank move in the direction the user experiences it", async () => {
    // Rank 5 -> 2 is moving UP, even though the number went down.
    const out = await explainTransition({
      record: {
        ...INCOME_RECORD,
        eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
        recommendationTransition: "RANK_INCREASED",
        previousRank: 5,
        newRank: 2,
        reason: {
          code: "RANK_IMPROVED",
          changedFields: [{ field: "benefits", oldValue: "certificate", newValue: "₹50,000 grant" }],
          rulesNowPassing: [],
          rulesNowFailing: [],
        },
      },
      profile: PROFILE,
      ...noLlm,
    });
    expect(out.summary).toMatch(/moved up your list, from position 5 to 2/);
  });

  it("explains a deadline change to someone whose eligibility did not move", async () => {
    const out = await explainTransition({
      record: {
        ...INCOME_RECORD,
        eligibilityTransition: "ELIGIBLE_TO_ELIGIBLE",
        recommendationTransition: "NO_CHANGE",
        previousRank: 3,
        newRank: 3,
        reason: {
          code: "DEADLINE_CHANGED",
          changedFields: [{ field: "lastDate", oldValue: "2026-12-31", newValue: "2026-09-30" }],
          rulesNowPassing: [],
          rulesNowFailing: [],
        },
      },
      profile: PROFILE,
      ...noLlm,
    });
    expect(out.sufficientEvidence).toBe(true);
    expect(out.summary).toMatch(/brought forward/);
    expect(out.summary).toMatch(/eligibility is unchanged/);
  });
});
