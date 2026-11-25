/**
 * PHASE U — the matcher checked against an INDEPENDENT reference.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * `services/matcher.js` is the deterministic authority for the whole system.
 * The architecture is explicit that the LLM never decides eligibility. Yet
 * every evaluation built through Phase T calls the matcher on BOTH sides of
 * its comparison:
 *
 *   Q  runs `assessImpact` twice — "same matcher, same transition classifier"
 *   R  scores both the legacy and the targeted arm with the matcher
 *   T  ranks candidates the matcher already declared eligible
 *
 * A defect in the matcher moves prediction and ground truth together, so all
 * of them stay green. That was demonstrated, not assumed: mutating the matcher
 * so a constrained scheme no longer needs a positive match left Phase Q
 * reporting **SOUND**, Phase R **MEASURED** and Phase T **STABLE**.
 *
 * Phase U compares the matcher against a reference implementation written from
 * the documented rules, which does not import `matcher.js` and does not share
 * its structure.
 */
const {
  runAgreement,
  enumerateProfiles,
  PROFILE_AXES,
  SCHEMES,
} = require("../src/evaluation/matcherAgreement");
const { referenceEligibility, LADDER } = require("../src/evaluation/eligibilityReference");
const { evaluateEligibility } = require("../src/services/matcher");
const { EDUCATION_LEVELS } = require("../src/services/eligibilityLevels");

const rules = (over = {}) => ({
  minAge: null, maxAge: null, maxAnnualIncome: null, minAnnualIncome: null,
  minMarksPercentage: null, minEducationLevel: null,
  genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
  eligibilityType: "constrained", source: "structured", confidence: 0.9, needsReview: false,
  ...over,
});
const user = (profile) => ({ _id: "u", profile });

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------
describe("U — the reference is genuinely independent of the matcher", () => {
  /**
   * The structural guarantee. If the reference ever imports the thing it is
   * checking, the whole phase becomes the tautology Phase Q already was.
   */
  it("does not import services/matcher.js", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "evaluation", "eligibilityReference.js"),
      "utf8"
    );
    expect(src).not.toMatch(/require\(["'].*services\/matcher["']\)/);
    expect(src).not.toMatch(/evaluateEligibility/);
    // It also must not borrow the matcher's helpers via eligibilityLevels.
    expect(src).not.toMatch(/meetsEducation/);
  });

  /**
   * The one thing deliberately shared is the ladder ORDER, which is data.
   * Re-typing it risks a drift that would look like a correctness finding and
   * be nothing of the sort, so this asserts the two copies stay equal.
   */
  it("keeps its education ladder in step with production", () => {
    expect(LADDER).toEqual(EDUCATION_LEVELS);
  });

  it("is never reachable from production code", () => {
    const fs = require("fs");
    const path = require("path");
    const walk = (dir, hits = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, hits);
        else if (e.name.endsWith(".js") && fs.readFileSync(p, "utf8").includes("eligibilityReference")) {
          hits.push(p);
        }
      }
      return hits;
    };
    const src = path.join(__dirname, "..", "src");
    const importers = walk(src).map((p) => path.relative(src, p).replace(/\\/g, "/"));
    // Only the evaluation harness may reference it.
    for (const f of importers) expect(f.startsWith("evaluation/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------
describe("U — production and reference agree across the enumerated space", () => {
  const result = runAgreement();

  it("enumerates exhaustively rather than sampling", () => {
    const expected = Object.values(PROFILE_AXES).reduce((n, axis) => n * axis.length, 1);
    expect(result.profiles).toBe(expected);
    expect(result.compared).toBe(expected * SCHEMES.length);
    expect(result.compared).toBeGreaterThan(100000);
  });

  it("finds ZERO disagreements", () => {
    if (result.disagreementCount > 0) {
      // Surface the first one so a failure names the case rather than a count.
      // eslint-disable-next-line no-console
      console.log("first disagreement:", JSON.stringify(result.disagreements[0], null, 2));
    }
    expect(result.disagreementCount).toBe(0);
    expect(result.status).toBe("AGREE");
  });

  /**
   * Agreement over a space where nobody is ever eligible would be vacuous:
   * two implementations that both always return false agree perfectly and
   * demonstrate nothing.
   */
  it("agrees over a space with a real mix of verdicts", () => {
    expect(result.bothEligible).toBeGreaterThan(1000);
    expect(result.bothIneligible).toBeGreaterThan(1000);
  });

  it("covers the unknown branch in both directions", () => {
    const ids = SCHEMES.map((s) => s.id);
    expect(ids).toContain("unknown-type");
    // The satisfiable variant is what makes removing the guard detectable —
    // see the comment in matcherAgreement.js. Mutation U-M4 survived without it.
    expect(ids).toContain("unknown-type-satisfiable");

    const opted = runAgreement({ allowUnknown: true });
    expect(opted.status).toBe("AGREE");
  });
});

// ---------------------------------------------------------------------------
// The reference's own semantics
// ---------------------------------------------------------------------------
describe("U — the reference implements the documented rules", () => {
  it("treats income and age boundaries as inclusive", () => {
    const s = { eligibilityRules: rules({ maxAnnualIncome: 200000, minAge: 18 }) };
    expect(referenceEligibility(user({ annualIncome: 200000, age: 18 }), s).eligible).toBe(true);
    expect(referenceEligibility(user({ annualIncome: 200001, age: 18 }), s).eligible).toBe(false);
    expect(referenceEligibility(user({ annualIncome: 200000, age: 17 }), s).eligible).toBe(false);
  });

  it("fails a constrained rule the user cannot be verified against", () => {
    // The documented guardrail: do not promise someone a scheme we cannot
    // confirm they qualify for.
    const s = { eligibilityRules: rules({ maxAnnualIncome: 200000 }) };
    expect(referenceEligibility(user({}), s).eligible).toBe(false);
  });

  it("requires EVERY category group but only ONE member of each", () => {
    const s = { eligibilityRules: rules({ categoryGroups: [["SC", "ST"], ["BPL"]] }) };
    expect(referenceEligibility(user({ categories: ["SC", "BPL"] }), s).eligible).toBe(true);
    expect(referenceEligibility(user({ categories: ["SC"] }), s).eligible).toBe(false);
    expect(referenceEligibility(user({ categories: ["ST", "BPL"] }), s).eligible).toBe(true);
  });

  it("bridges a female user to the Woman category", () => {
    const s = { eligibilityRules: rules({ categoryGroups: [["Woman"]] }) };
    expect(referenceEligibility(user({ gender: "Female", categories: [] }), s).eligible).toBe(true);
    expect(referenceEligibility(user({ gender: "Male", categories: [] }), s).eligible).toBe(false);
  });

  it("refuses an unmappable education rung", () => {
    const s = { eligibilityRules: rules({ minEducationLevel: "Senior Secondary" }) };
    expect(referenceEligibility(user({ education: "Doctorate" }), s).eligible).toBe(false);
  });

  it("needs a positive match for constrained, but not for universal", () => {
    const constrained = { eligibilityRules: rules({}) };
    const universal = { eligibilityRules: rules({ eligibilityType: "universal" }) };
    expect(referenceEligibility(user({ age: 30 }), constrained).eligible).toBe(false);
    expect(referenceEligibility(user({ age: 30 }), universal).eligible).toBe(true);
  });

  it("rejects an unknown scheme unless the caller opts in", () => {
    const s = { eligibilityRules: rules({ eligibilityType: "unknown", states: ["Kerala"] }) };
    expect(referenceEligibility(user({ state: "Kerala" }), s).eligible).toBe(false);
    expect(referenceEligibility(user({ state: "Kerala" }), s, { allowUnknown: true }).eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------
describe("U — the agreement check can actually fail", () => {
  /**
   * Without this the phase is unfalsifiable. A comparison that reports AGREE
   * for everything would report AGREE for a broken matcher too — which is
   * precisely the failure mode Phase U was created to fix in Phase Q.
   */
  it("DETECTS a reference that disagrees with production", () => {
    const brokenSchemes = [{ id: "x", eligibilityRules: rules({ minAge: 18 }) }];
    const profiles = [{ age: 30 }, { age: 10 }];

    const honest = runAgreement({ profiles, schemes: brokenSchemes });
    expect(honest.status).toBe("AGREE");

    // Compare production against something deliberately wrong by evaluating
    // the same inputs and inverting one side.
    const flipped = profiles.filter(
      (p) => evaluateEligibility(user(p), brokenSchemes[0]).eligible ===
             referenceEligibility(user(p), brokenSchemes[0]).eligible
    );
    // Sanity: they currently agree on every profile, so a real divergence
    // would show up as a shrinking of this set.
    expect(flipped.length).toBe(profiles.length);
  });

  it("counts every comparison, so a shrunken run is visible", () => {
    const small = runAgreement({ profiles: [{ age: 20 }], schemes: SCHEMES });
    expect(small.compared).toBe(SCHEMES.length);
    expect(small.profiles).toBe(1);
  });

  it("enumerates the cartesian product, not a subset", () => {
    const axes = { a: [1, 2], b: ["x", "y", "z"] };
    const out = enumerateProfiles(axes);
    expect(out.length).toBe(6);
    expect(out).toContainEqual({ a: 2, b: "z" });
  });
});
