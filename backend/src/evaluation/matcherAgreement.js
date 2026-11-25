/**
 * PHASE U — exhaustive agreement between the production matcher and an
 * independent reference implementation.
 *
 * ---------------------------------------------------------------------------
 * WHY EXHAUSTIVE RATHER THAN SAMPLED
 * ---------------------------------------------------------------------------
 * The interesting eligibility bugs live at boundaries: a user exactly at the
 * income ceiling, exactly at the minimum age, holding one of two required
 * category groups, sitting on the education rung the scheme demands. Random
 * sampling finds those only by luck, and a corpus hand-picked by the same
 * person who wrote the code tends to contain the cases they already thought
 * about.
 *
 * So the input space is bounded deliberately small and then enumerated in
 * full — every profile against every scheme, no sampling, no seed. The
 * attribute values are chosen to sit ON and immediately EITHER SIDE of every
 * threshold the scheme set uses.
 *
 * ---------------------------------------------------------------------------
 * WHAT DISAGREEMENT MEANS
 * ---------------------------------------------------------------------------
 * A disagreement does NOT automatically mean the matcher is wrong — it means
 * the two implementations read the specification differently, and one of them
 * has to be corrected. The report therefore prints the exact profile and rules
 * for each disagreement rather than just a count, because the point is for a
 * human to adjudicate.
 *
 * What it definitely means is that a claim of the form "the matcher is the
 * deterministic authority" is not currently supported, which is the thing
 * Phase U exists to check.
 */

const { evaluateEligibility } = require("../services/matcher");
const { referenceEligibility } = require("./eligibilityReference");

/**
 * Attribute values placed at and around every threshold the scheme set below
 * uses (age 18/25, income 200000, marks 60, the education ladder).
 *
 * `undefined` is included on purpose for every optional attribute: "the user
 * never filled this in" is the case the matcher's `strict` flag exists for,
 * and it is the one most likely to be transcribed differently by two
 * implementations.
 */
const PROFILE_AXES = {
  age: [undefined, 17, 18, 25, 26],
  annualIncome: [undefined, 199999, 200000, 200001],
  state: [undefined, "Kerala", "Bihar"],
  gender: [undefined, "Female", "Male"],
  occupation: [undefined, "Student", "Farmer"],
  education: [undefined, "10th Standard", "Graduate"],
  marksPercentage: [undefined, 59, 60],
  categories: [[], ["SC"], ["SC", "BPL"]],
};

const rules = (over = {}) => ({
  minAge: null, maxAge: null, maxAnnualIncome: null, minAnnualIncome: null,
  minMarksPercentage: null, minEducationLevel: null,
  genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
  eligibilityType: "constrained", source: "structured", confidence: 0.9, needsReview: false,
  ...over,
});

/**
 * Scheme shapes, one per rule the matcher implements plus the combinations
 * where two rules interact.
 *
 * `eligibilityType` is varied deliberately: the universal/constrained/unknown
 * branch is where the two implementations most plausibly diverge, and the
 * unknown branch has an `allowUnknown` opt-in that is easy to get backwards.
 */
const SCHEMES = [
  { id: "unconstrained-universal", eligibilityRules: rules({ eligibilityType: "universal" }) },
  { id: "unconstrained-constrained", eligibilityRules: rules({}) },
  { id: "unknown-type", eligibilityRules: rules({ eligibilityType: "unknown" }) },
  // An unknown-type scheme that a user CAN satisfy on the rules alone.
  //
  // Without this, removing the `unknown` guard entirely was invisible: the
  // bare unknown scheme above has no rules, so with the guard gone production
  // fell through to the constrained branch, found no positive match, and
  // returned ineligible anyway — agreeing with the reference for the wrong
  // reason. Mutation U-M4 SURVIVED until this case existed.
  //
  // With satisfiable rules attached, the guard is the ONLY thing keeping the
  // verdict false, so removing it produces a real disagreement.
  { id: "unknown-type-satisfiable", eligibilityRules: rules({ eligibilityType: "unknown", states: ["Kerala"], minAge: 18 }) },
  { id: "age-band", eligibilityRules: rules({ minAge: 18, maxAge: 25 }) },
  { id: "age-floor-only", eligibilityRules: rules({ minAge: 18 }) },
  { id: "income-ceiling", eligibilityRules: rules({ maxAnnualIncome: 200000 }) },
  { id: "income-floor", eligibilityRules: rules({ minAnnualIncome: 200000 }) },
  { id: "state-list", eligibilityRules: rules({ states: ["Kerala"] }) },
  { id: "gender-list", eligibilityRules: rules({ genders: ["Female"] }) },
  { id: "occupation-list", eligibilityRules: rules({ occupations: ["Student"] }) },
  { id: "education-floor", eligibilityRules: rules({ minEducationLevel: "Graduate" }) },
  { id: "education-unmappable", eligibilityRules: rules({ minEducationLevel: "Senior Secondary" }) },
  { id: "marks-floor", eligibilityRules: rules({ minMarksPercentage: 60 }) },
  { id: "categories-flat", eligibilityRules: rules({ categories: ["SC"] }) },
  { id: "categories-flat-and", eligibilityRules: rules({ categories: ["SC", "BPL"] }) },
  { id: "category-groups-or", eligibilityRules: rules({ categoryGroups: [["SC", "ST"]] }) },
  { id: "category-groups-and-of-or", eligibilityRules: rules({ categoryGroups: [["SC", "ST"], ["BPL"]] }) },
  { id: "woman-bridge", eligibilityRules: rules({ categoryGroups: [["Woman"]] }) },
  { id: "age-and-income", eligibilityRules: rules({ minAge: 18, maxAnnualIncome: 200000 }) },
  { id: "universal-with-a-rule", eligibilityRules: rules({ eligibilityType: "universal", maxAge: 25 }) },
];

/** Every combination of the axes above. Cartesian product, not a sample. */
function enumerateProfiles(axes = PROFILE_AXES) {
  const keys = Object.keys(axes);
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const partial of out) {
      for (const v of axes[k]) next.push({ ...partial, [k]: v });
    }
    out = next;
  }
  return out;
}

/**
 * Run every profile against every scheme through both implementations.
 *
 * Only the BOOLEAN verdict is compared. The two implementations deliberately
 * produce different reason vocabularies and different intermediate shapes —
 * requiring those to match would be requiring a transcription, which is the
 * opposite of independence. `eligible` is the value the whole system acts on.
 */
function runAgreement({ profiles = null, schemes = SCHEMES, allowUnknown = false } = {}) {
  const population = profiles || enumerateProfiles();
  const disagreements = [];
  let compared = 0;
  let bothEligible = 0;
  let bothIneligible = 0;

  for (const profile of population) {
    const user = { _id: "u", profile };
    for (const scheme of schemes) {
      compared += 1;
      const prod = evaluateEligibility(user, scheme, { allowUnknown });
      const ref = referenceEligibility(user, scheme, { allowUnknown });

      if (!!prod.eligible !== !!ref.eligible) {
        disagreements.push({
          schemeId: scheme.id,
          profile,
          production: !!prod.eligible,
          reference: !!ref.eligible,
          productionFailed: (prod.failed || []).map((f) => f.rule),
          referenceFailed: ref.failed,
        });
      } else if (prod.eligible) bothEligible += 1;
      else bothIneligible += 1;
    }
  }

  return {
    status: disagreements.length === 0 ? "AGREE" : "DISAGREE",
    compared,
    profiles: population.length,
    schemes: schemes.length,
    disagreements,
    disagreementCount: disagreements.length,
    // Reported because an "AGREE" over a space where NOBODY is ever eligible
    // is vacuous: two implementations that both always say false agree
    // perfectly and demonstrate nothing.
    bothEligible,
    bothIneligible,
    agreementRate: compared > 0 ? Number(((compared - disagreements.length) / compared).toFixed(6)) : null,
  };
}

module.exports = { runAgreement, enumerateProfiles, PROFILE_AXES, SCHEMES };
