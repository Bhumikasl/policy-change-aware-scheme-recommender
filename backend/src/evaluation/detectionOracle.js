/**
 * PHASE V — an INDEPENDENT materiality oracle for change detection.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION
 * ---------------------------------------------------------------------------
 * Every phase from Q onwards begins AFTER a change has been detected. Q asks
 * who a detected change affects, R what detecting it costs, S how late the
 * detection may be, T whether the resulting ranking is stable, U whether the
 * eligibility rules are read correctly.
 *
 * None of them asks whether the change was detected AT ALL.
 *
 * That matters more than it sounds, because a detection miss is silent by
 * construction. `reconcile()` returning NO_CHANGE writes no SchemeHistory row,
 * bumps no version and starts no pipeline — so there is nothing for any
 * downstream harness to be wrong about. Q, R, S, T and U all stay green while
 * the system quietly stops monitoring.
 *
 * ---------------------------------------------------------------------------
 * WHAT "MATERIAL" MEANS HERE, AND WHY IT IS DEFINED THIS WAY
 * ---------------------------------------------------------------------------
 * A change is MATERIAL when it changes what the system would tell at least one
 * real user about their own standing:
 *
 *     recommendedState(user, scheme) = eligible(user, scheme) AND schemeIsOpen
 *
 * Both halves are taken from the documented behaviour rather than from the
 * detector:
 *
 *   - `eligible` comes from `eligibilityReference.js`, the Phase U reference
 *     implementation. It does not import `services/matcher.js`, so the oracle
 *     shares no code with the production eligibility engine either.
 *
 *   - `schemeIsOpen` restates policyImpactAgent's documented rule that "a
 *     closed scheme is not something to keep recommending" — the matcher itself
 *     never reads `status`.
 *
 * This definition is deliberately NARROW. A benefit amount or a deadline can
 * move without flipping anybody's verdict, and those changes matter to users
 * too. They are reported as coverage, never as a soundness failure, because
 * folding them in would turn the oracle into an opinion about which fields are
 * interesting — which is precisely the judgement the detector already makes and
 * which this file exists to check independently.
 *
 * The asymmetry is the point. A verdict flip that goes undetected is a person
 * holding a recommendation the policy has already invalidated, with no bound on
 * how long (Phase S showed what that costs). A detected change that flips
 * nobody is a wasted cycle. Only the first is a defect.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT TELL YOU
 * ---------------------------------------------------------------------------
 * The population is enumerated and bounded. "No user in this population flips"
 * is not "no user could flip" — a MISSED verdict is therefore firm evidence of
 * a defect, while the absence of one is bounded reassurance, not proof.
 */

const { referenceEligibility } = require("./eligibilityReference");

/**
 * The profile axes the oracle enumerates.
 *
 * Values sit ON and immediately either side of the thresholds the base schemes
 * use, and `undefined` appears for every optional attribute because "the user
 * never filled this in" is the case the matcher's strict flag exists for.
 *
 * Bounded on purpose: this is a materiality oracle run once per mutation, not
 * an exhaustive agreement check. Phase U owns exhaustiveness.
 */
const PROFILE_AXES = Object.freeze({
  state: ["Kerala", undefined],
  gender: ["Female", "Male"],
  categories: [[], ["SC"]],
  occupation: ["Student", undefined],
  age: [17, 30, 61, undefined],
  annualIncome: [200000, 200001, undefined],
  education: ["10th Standard", "Graduate", undefined],
  marksPercentage: [59, 60],
});

/** Cartesian product of the axes. Deterministic order, no sampling. */
function enumeratePopulation(axes = PROFILE_AXES) {
  const names = Object.keys(axes);
  let out = [{}];
  for (const name of names) {
    const next = [];
    for (const partial of out) {
      for (const value of axes[name]) next.push({ ...partial, [name]: value });
    }
    out = next;
  }
  return out.map((profile, i) => ({ _id: `p${i}`, profile }));
}

/**
 * Restates policyImpactAgent's `isActive`, from its documented behaviour rather
 * than by importing it: an empty or missing status is treated as open, because
 * the normalizer defaults `status` to "Active" and a blank must not silently
 * revoke every scheme.
 */
function schemeIsOpen(scheme) {
  const s = String(scheme?.status ?? "active").toLowerCase();
  return s === "active" || s === "";
}

/**
 * What the system would tell ONE user about ONE scheme.
 *
 * Not `eligible` alone: a scheme that closed is not recommended even though
 * every eligibility rule still passes, and a detector that missed the closure
 * would be missing something users must be told.
 */
function recommendedState(user, scheme) {
  return referenceEligibility(user, scheme).eligible && schemeIsOpen(scheme);
}

/**
 * Is the difference between two versions of a scheme material?
 *
 * @param {Object} before  normalized scheme, previous version
 * @param {Object} after   normalized scheme, new version
 * @param {Array}  population  users from enumeratePopulation()
 * @returns {{material: boolean, flips: number, flipped: Array, sampleFlip: Object|null}}
 *
 * `flipped` carries the actual user objects, not just a count: they are the
 * ground truth for the candidate-set check in detectionCompleteness.js, which
 * asks whether the impact agent's query would have reached each of them.
 */
function assessMateriality(before, after, population) {
  const flipped = [];
  let sampleFlip = null;
  for (const user of population) {
    const wasRecommended = recommendedState(user, before);
    const isRecommended = recommendedState(user, after);
    if (wasRecommended === isRecommended) continue;
    flipped.push(user);
    if (!sampleFlip) {
      sampleFlip = { profile: user.profile, before: wasRecommended, after: isRecommended };
    }
  }
  return { material: flipped.length > 0, flips: flipped.length, flipped, sampleFlip };
}

module.exports = {
  PROFILE_AXES,
  enumeratePopulation,
  assessMateriality,
  recommendedState,
  schemeIsOpen,
};
