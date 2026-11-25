/**
 * PHASE U — an INDEPENDENT reference implementation of the eligibility rules.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `services/matcher.js` is the deterministic authority for the entire system.
 * The architecture is explicit that the LLM never decides eligibility — the
 * matcher does, and everything downstream (impact analysis, propagation,
 * history, notifications, the chat verdict block) is a consequence of what it
 * returns.
 *
 * Nothing independently checks it.
 *
 * Every evaluation built so far calls the matcher on BOTH sides of its
 * comparison:
 *
 *   Q  runs `assessImpact` twice — "same matcher, same transition classifier"
 *   R  scores both the legacy and targeted arms with the matcher
 *   S  is schedule arithmetic and never evaluates eligibility
 *   T  ranks candidates the matcher already declared eligible
 *
 * So a defect in the matcher is invisible to all of them: it moves prediction
 * and ground truth together. That was verified, not assumed — two mutations of
 * `matcher.js` (a constrained scheme no longer needing a positive match; a
 * universal scheme ignoring failed rules) left Q **SOUND**, R **MEASURED** and
 * T **STABLE**, with one unit test failing out of 869.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS INDEPENDENT
 * ---------------------------------------------------------------------------
 * This file does NOT import `services/matcher.js`, and it does not import its
 * helpers. It is written from the matcher's documented specification — the
 * three-branch design in its header block, the per-rule semantics in its
 * comments, and the education ladder — and re-derives the verdict from scratch.
 *
 * It is deliberately written in a different SHAPE too: a list of independent
 * rule predicates reduced at the end, rather than a single procedural pass.
 * Two implementations that share a structure tend to share a bug; the point
 * here is to disagree when one of them is wrong.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING IT SHARES, AND WHY
 * ---------------------------------------------------------------------------
 * The education ladder ORDER (`Below 10th < 10th Standard < ...`) is data, not
 * logic. Re-typing it here would risk the two copies drifting into a
 * disagreement that says nothing about correctness. So the ladder is declared
 * here explicitly and a Phase U test asserts it equals the production one —
 * drift is caught, while the COMPARISON logic stays independent.
 *
 * This is a reference implementation, not a replacement. It is never called by
 * production code.
 */

/**
 * The education ladder, lowest to highest.
 *
 * Declared here rather than imported so that this file states its own
 * assumption. `tests/matcherAgreement.test.js` asserts it matches
 * `services/eligibilityLevels.js`, so a change to production ordering fails
 * loudly instead of silently making the two agree.
 */
const LADDER = [
  "Below 10th",
  "10th Standard",
  "12th Standard",
  "Diploma",
  "Undergraduate",
  "Graduate",
  "Post Graduate",
  "Doctorate",
];

const EDU_ALIASES = {
  "below 10th": "Below 10th",
  "10th": "10th Standard",
  "10th standard": "10th Standard",
  "matric": "10th Standard",
  "12th": "12th Standard",
  "12th standard": "12th Standard",
  "intermediate": "12th Standard",
  "diploma": "Diploma",
  "undergraduate": "Undergraduate",
  "ug": "Undergraduate",
  "b.tech": "Undergraduate",
  "graduate": "Graduate",
  "graduation": "Graduate",
  "degree": "Graduate",
  "bachelors": "Graduate",
  "post graduate": "Post Graduate",
  "postgraduate": "Post Graduate",
  "pg": "Post Graduate",
  "doctorate": "Doctorate",
  "phd": "Doctorate",
};

const rankOf = (level) => {
  if (!level) return null;
  const s = String(level).trim();
  let i = LADDER.indexOf(s);
  if (i !== -1) return i;
  const mapped = EDU_ALIASES[s.toLowerCase()];
  return mapped ? LADDER.indexOf(mapped) : null;
};

const lower = (v) => String(v ?? "").toLowerCase();
const lowerSet = (arr) => new Set((arr || []).filter(Boolean).map(lower));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** A rule outcome. Exactly one of these three, per rule, per user. */
const PASS = "pass";
const FAIL = "fail";
const ABSENT = "absent"; // the scheme places no constraint on this attribute

/**
 * Each rule is an independent predicate over (profile, rules).
 *
 * Written as a table on purpose. The production matcher is one long
 * procedural function; expressing the same specification as separate
 * predicates means a transcription slip in one does not mirror a logic slip in
 * the other.
 *
 * `strict` is the matcher's documented flag: when the scheme constrains an
 * attribute the user has not supplied, strict counts it as a FAILURE ("we
 * cannot verify the user qualifies") rather than as absent.
 */
const RULES = {
  state(p, r, strict, scheme) {
    const states = (r.states || []).length > 0
      ? r.states
      : (scheme?.state && scheme.state !== "All India" ? [scheme.state] : []);
    if (states.length === 0) return ABSENT;
    const user = lower(p.state);
    if (user && lowerSet(states).has(user)) return PASS;
    if (!user && !strict) return ABSENT;
    return FAIL;
  },

  gender(p, r, strict) {
    if ((r.genders || []).length === 0) return ABSENT;
    const user = lower(p.gender);
    if (user && lowerSet(r.genders).has(user)) return PASS;
    if (!user && !strict) return ABSENT;
    return FAIL;
  },

  /**
   * AND-of-OR, plus the female -> "woman" bridge.
   *
   * `categoryGroups` is a list of OR-groups and EVERY group must be satisfied.
   * A flat `categories` list is AND-of-singletons — each entry is its own
   * one-element group, so the user must hold all of them.
   */
  category(p, r) {
    const groups =
      (r.categoryGroups || []).length > 0
        ? r.categoryGroups
        : (r.categories || []).map((c) => [c]);
    if (groups.length === 0) return ABSENT;

    const held = lowerSet(p.categories);
    if (lower(p.gender) === "female") held.add("woman");

    const everyGroupMet = groups.every((group) =>
      (group || []).some((c) => held.has(lower(c)))
    );
    return everyGroupMet ? PASS : FAIL;
  },

  occupation(p, r, strict) {
    if ((r.occupations || []).length === 0) return ABSENT;
    const user = lower(p.occupation);
    if (user && lowerSet(r.occupations).has(user)) return PASS;
    if (!user && !strict) return ABSENT;
    return FAIL;
  },

  applicantType(p, r, strict) {
    const types = (r.applicantTypes || []).map((t) => String(t).toUpperCase());
    if (types.length === 0) return ABSENT;
    const typeSet = new Set(types);
    const userOcc = lower(p.occupation);
    if (typeSet.has("INSTITUTION") || typeSet.has("NGO_SHG")) return FAIL;
    if (typeSet.has("ENTERPRISE") && userOcc !== "entrepreneur" && userOcc !== "self-employed") return FAIL;
    if (typeSet.has("FACULTY_RESEARCHER") && userOcc !== "faculty" && userOcc !== "scientist" && userOcc !== "researcher") return FAIL;
    if (typeSet.has("FARMER") && userOcc !== "farmer" && userOcc) return FAIL;
    if (typeSet.has("STUDENT") && userOcc !== "student" && userOcc) return FAIL;
    return PASS;
  },

  age(p, r, strict) {
    const constrained = r.minAge != null || r.maxAge != null;
    if (!constrained) return ABSENT;
    if (!isNum(p.age)) return strict ? FAIL : ABSENT;
    if (r.minAge != null && p.age < r.minAge) return FAIL;
    if (r.maxAge != null && p.age > r.maxAge) return FAIL;
    return PASS;
  },

  annualIncome(p, r, strict) {
    const constrained = r.maxAnnualIncome != null || r.minAnnualIncome != null;
    if (!constrained) return ABSENT;
    if (!isNum(p.annualIncome)) return strict ? FAIL : ABSENT;
    // Boundaries are INCLUSIVE: a user exactly at the ceiling still qualifies.
    if (r.maxAnnualIncome != null && p.annualIncome > r.maxAnnualIncome) return FAIL;
    if (r.minAnnualIncome != null && p.annualIncome < r.minAnnualIncome) return FAIL;
    return PASS;
  },

  education(p, r, strict) {
    if (r.minEducationLevel == null || r.minEducationLevel === "") return ABSENT;
    const required = rankOf(r.minEducationLevel);
    const held = rankOf(p.education);
    // An unmappable level cannot be satisfied — the documented conservative
    // reading is "a rule we cannot map is not one we can say the user meets".
    if (required === null) return FAIL;
    if (held === null) return strict ? FAIL : ABSENT;
    return held >= required ? PASS : FAIL;
  },

  maxEducation(p, r, strict) {
    if (r.maxEducationLevel == null || r.maxEducationLevel === "") return ABSENT;
    const ceiling = rankOf(r.maxEducationLevel);
    const held = rankOf(p.education);
    if (ceiling === null) return FAIL;
    if (held === null) return strict ? FAIL : ABSENT;
    return held <= ceiling ? PASS : FAIL;
  },

  course(p, r, strict) {
    if ((r.courses || []).length === 0) return ABSENT;
    const userCourse = lower(p.course);
    if (!userCourse) return strict ? FAIL : ABSENT;
    const set = lowerSet(r.courses);
    return set.has(userCourse) ? PASS : FAIL;
  },

  disability(p, r, strict) {
    const hasDisabilityRule = r.disabilityRequired === true || r.minDisabilityPercentage != null;
    if (!hasDisabilityRule) return ABSENT;
    if (p.disability === null || p.disability === undefined) return strict ? FAIL : ABSENT;
    if (p.disability === false) return FAIL;
    if (r.minDisabilityPercentage != null) {
      if (!isNum(p.disabilityPercentage)) return strict ? FAIL : ABSENT;
      return p.disabilityPercentage >= r.minDisabilityPercentage ? PASS : FAIL;
    }
    return PASS;
  },

  singleGirlChild(p, r, strict) {
    if (r.singleGirlChildRequired !== true) return ABSENT;
    if (p.singleGirlChild === null || p.singleGirlChild === undefined) return strict ? FAIL : ABSENT;
    return p.singleGirlChild === true ? PASS : FAIL;
  },

  marksPercentage(p, r, strict) {
    if (r.minMarksPercentage == null) return ABSENT;
    if (!isNum(p.marksPercentage)) return strict ? FAIL : ABSENT;
    return p.marksPercentage >= r.minMarksPercentage ? PASS : FAIL;
  },
};

/**
 * The reference verdict.
 *
 * The three-branch design, restated from the matcher's header:
 *
 *   unknown     — not eligible unless the caller opts in.
 *   universal   — eligible when nothing FAILS.
 *   constrained — eligible when nothing FAILS **and** at least one rule PASSES.
 *
 * A single failure beats every positive signal: eligibility is a hard gate,
 * not a score.
 */
function referenceEligibility(user, scheme, { allowUnknown = false } = {}) {
  const rules = scheme?.eligibilityRules || {};
  const profile = user?.profile || {};
  const type = rules.eligibilityType || "unknown";

  if (type === "unknown" && !allowUnknown) {
    return { eligible: false, eligibilityType: type, passed: [], failed: ["eligibilityType"], reason: "unknown" };
  }

  // Documented: strict=true for BOTH universal and constrained, so the
  // missing-attribute guardrail applies either way.
  const strict = true;

  const passed = [];
  const failed = [];
  for (const [name, predicate] of Object.entries(RULES)) {
    const outcome = predicate(profile, rules, strict, scheme);
    if (outcome === PASS) passed.push(name);
    else if (outcome === FAIL) failed.push(name);
  }

  let eligible;
  if (type === "universal") eligible = failed.length === 0;
  else eligible = failed.length === 0 && passed.length >= 1;

  return { eligible, eligibilityType: type, passed, failed, reason: eligible ? "all rules satisfied" : "at least one rule unsatisfied" };
}

module.exports = { referenceEligibility, RULES, LADDER, PASS, FAIL, ABSENT };
