/**
 * Pure eligibility matcher. NO database, NO email, NO logger — takes a
 * user object and a scheme object, returns a verdict. Easy to unit-test.
 *
 * Three-branch design driven by scheme.eligibilityRules.eligibilityType:
 *
 *   universal   — the scheme is open to everyone in the jurisdiction.
 *                 A user matches if:
 *                   - they satisfy any state constraints on the scheme, AND
 *                   - they don't fail any restrictive rule (in practice a
 *                     universal scheme has none, but if a later re-extract
 *                     adds one, that failure counts).
 *                 The state constraint counts as a positive signal so we
 *                 don't emit a "no signals" verdict.
 *
 *   constrained — legacy strict logic: at least one positive match AND no
 *                  failures. This is what the "650 matches" fix produced,
 *                  and it stays for schemes that really do have criteria.
 *
 *   unknown     — the scheme's rules could not be extracted. Not matched
 *                  by default. Callers can pass { allowUnknown: true } to
 *                  include them (e.g. an admin "review queue" view).
 *
 * Any single failure — user's age outside a specified range, user in a
 * wrong state — always beats every positive signal. Eligibility is a hard
 * gate, not a fuzzy score.
 */

const { meetsEducation, withinMaxEducation } = require("./eligibilityLevels");

const HARD_FAIL_PENALTY = 100;

function toLowerSet(arr) {
  return new Set((arr || []).filter(Boolean).map((s) => String(s).toLowerCase()));
}

/**
 * Canonical aliases for category labels.
 *
 * The LLM extractor instructs the model to use short labels like "BPL" and
 * "EWS", while the deterministic extractor and the frontend form both use the
 * compound label "BPL / Economically Weaker". Neither side is wrong — they
 * describe the same population — but a strict set comparison would silently
 * fail every BPL-targeted scheme for a user who has the compound label, and
 * vice versa.
 *
 * This map is applied to BOTH sides (user categories AND scheme categories)
 * before the comparison so the stored label never matters. It is additive:
 * the original label is kept AND the aliases are inserted, so a scheme that
 * specifies "EWS" matches a user who ticked "BPL / Economically Weaker".
 *
 * Add new aliases here whenever the extractor or the frontend introduces a
 * new spelling — the alternative is a data migration over every stored scheme
 * and every user document.
 */
const CATEGORY_ALIASES = new Map([
  // Frontend compound label ↔ LLM short labels
  ["bpl / economically weaker", ["bpl", "ews"]],
  // LLM short labels → frontend compound (and each other)
  ["bpl",                        ["bpl / economically weaker", "ews"]],
  ["ews",                        ["bpl / economically weaker", "bpl"]],
]);

/**
 * Expand a lowercased category set using CATEGORY_ALIASES.
 * Returns a new Set that includes the originals plus every alias.
 */
function expandCategorySet(lowerSet) {
  const expanded = new Set(lowerSet);
  for (const item of lowerSet) {
    const aliases = CATEGORY_ALIASES.get(item);
    if (aliases) aliases.forEach((a) => expanded.add(a));
  }
  return expanded;
}

/**
 * Normalize a free-text course/stream name to the same canonical tag the
 * extractor uses (see COURSE_KEYWORDS in deterministicExtractor.js), so
 * "B.Tech CSE", "BE CSE", "Computer Science Engineering" and "BSc Computer
 * Science" all compare equal to a scheme rule of "Computer Science".
 * Falls back to the trimmed lowercase input when nothing matches, so an
 * exact-name scheme rule (e.g. a rare stream not in the keyword list)
 * still matches an identically-typed user value.
 */
const COURSE_EQUIVALENCE = [
  { key: "computer science", re: /\b(computer\s*science|computer\s+applications?|\bcs\b|\bcse\b|\bit\b|information\s+technology)\b/i },
  { key: "engineering",      re: /\b(engineering|b\.?\s?tech|be\b|m\.?\s?tech)\b/i },
  { key: "medicine",         re: /\b(medicine|medical|mbbs|\bmd\b|nursing|bams|bhms|bums)\b/i },
  { key: "law",              re: /\b(law|llb|llm)\b/i },
  { key: "agriculture",      re: /\bagricultur\w*\b/i },
  { key: "arts",             re: /\b(arts|humanities|\bba\b)\b/i },
  { key: "commerce",         re: /\b(commerce|\bbcom\b|\bmcom\b|accountancy)\b/i },
  { key: "science",          re: /\b(science|\bbsc\b|\bmsc\b)\b/i },
  { key: "management",       re: /\b(management|\bmba\b|\bbba\b)\b/i },
  { key: "pharmacy",         re: /\bpharmac\w*\b/i },
];
function normalizeCourse(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  // Computer Science is checked before the generic "engineering"/"science"
  // buckets so "B.Tech CSE" and "BSc Computer Science" land on the more
  // specific tag rather than the broader one.
  for (const { key, re } of COURSE_EQUIVALENCE) {
    if (re.test(v)) return key;
  }
  return v;
}

/**
 * Check all restrictive rules against the user. Returns { positive, failed,
 * unknown, noConstraint }. Every rule that was specified adds an entry to
 * exactly one of positive / failed / unknown; a rule that wasn't specified
 * adds to noConstraint.
 *
 * `strict` controls what happens when the user is missing a field the
 * scheme rules require:
 *   true  → unknown  ("we cannot verify the user qualifies — ask them")
 *   false → noConstraint ("scheme doesn't apply if we don't know")
 *
 * `unknown` is NOT `failed`. A known failed condition (the user answered
 * and the answer disqualifies them) always means NOT_ELIGIBLE. A genuinely
 * unanswered required field means NEEDS_MORE_INFORMATION — the user might
 * still qualify once they answer. Conflating the two used to turn every
 * incomplete profile into a silent rejection; evaluateEligibility below is
 * what turns these three buckets into the final ELIGIBLE / NOT_ELIGIBLE /
 * NEEDS_MORE_INFORMATION verdict.
 *
 * For a constrained scheme we use strict=true (safe default — don't
 * promise someone a scheme we can't verify they qualify for). For a
 * universal scheme we still use strict=true so the same guardrail
 * applies if someone attached a rule to a nominally-universal scheme.
 */
function checkRules(user, rules, { strict = true, scheme = {} } = {}) {
  const p = user.profile || {};
  const positive = [];
  const failed = [];
  const unknown = [];
  const noConstraint = [];

  // ---- states ----
  const effectiveStates = (rules.states || []).length > 0
    ? rules.states
    : (scheme?.state && scheme.state !== "All India"
        ? [scheme.state]
        : (rules.state && rules.state !== "All India" ? [rules.state] : []));

  if (effectiveStates.length === 0) {
    noConstraint.push({ rule: "state", reason: "no state restriction" });
  } else {
    const schemeStates = toLowerSet(effectiveStates);
    const userState = (p.state || "").toLowerCase();
    if (userState && schemeStates.has(userState)) {
      positive.push({ rule: "state", reason: `user in ${p.state}` });
    } else if (!userState && !strict) {
      noConstraint.push({ rule: "state", reason: "user state unknown, non-strict" });
    } else if (!userState) {
      unknown.push({ rule: "state", reason: `requires ${effectiveStates.join(", ")}, user state not provided` });
    } else {
      failed.push({
        rule: "state",
        reason: `requires ${effectiveStates.join(", ")}, user in "${p.state || "(unset)"}"`,
      });
    }
  }

  // ---- gender ----
  if ((rules.genders || []).length === 0) {
    noConstraint.push({ rule: "gender", reason: "no gender restriction" });
  } else {
    const schemeGenders = toLowerSet(rules.genders);
    const userGender = (p.gender || "").toLowerCase();
    if (userGender && schemeGenders.has(userGender)) {
      positive.push({ rule: "gender", reason: `${p.gender} qualifies` });
    } else if (!userGender && !strict) {
      noConstraint.push({ rule: "gender", reason: "user gender unknown, non-strict" });
    } else if (!userGender) {
      unknown.push({ rule: "gender", reason: `requires ${rules.genders.join("/")}, user gender not provided` });
    } else {
      failed.push({
        rule: "gender",
        reason: `requires ${rules.genders.join("/")}, user "${p.gender || "(unset)"}"`,
      });
    }
  }

  // ---- categories — STRICT AND-of-OR ----
  //
  // Use rules.categoryGroups when present: each inner array is an
  // OR-group ("SC/ST/OBC" = one group), and EVERY group must be
  // satisfied. This is the fix for the "PwD student" case — a scheme
  // whose text is "physically disabled students" produces
  //   categoryGroups: [["Person with Disability"]]  and  occupations: ["Student"]
  // and the user must satisfy BOTH constraints; a plain Student without
  // the PwD category no longer sneaks through.
  //
  // Fall back to strict-AND on the flat `categories` list when
  // categoryGroups isn't populated (legacy rows before this migration).
  const groups = Array.isArray(rules.categoryGroups) && rules.categoryGroups.length > 0
    ? rules.categoryGroups
    : (Array.isArray(rules.categories) && rules.categories.length > 0
        ? rules.categories.map((c) => [c])   // each cat becomes its own AND-required group
        : []);

  if (groups.length === 0) {
    noConstraint.push({ rule: "category", reason: "no category restriction" });
  } else if ((p.categories || []).length === 0 && (p.gender || "").toLowerCase() !== "female" && !strict) {
    noConstraint.push({ rule: "category", reason: "user categories unknown, non-strict" });
  } else if ((p.categories || []).length === 0 && (p.gender || "").toLowerCase() !== "female") {
    unknown.push({ rule: "category", reason: "scheme has category requirement(s), user categories not provided" });
  } else {
    // Expand the user's category set through CATEGORY_ALIASES so that
    // "BPL / Economically Weaker" (frontend label) also matches "BPL" or
    // "EWS" as stored by the LLM extractor, and vice versa.
    const userCats = expandCategorySet(toLowerSet(p.categories));
    // Bridge: a female user counts as "Woman" for schemes that use that tag.
    if ((p.gender || "").toLowerCase() === "female") userCats.add("woman");

    const groupResults = groups.map((group) => {
      // Expand scheme category labels too — a scheme stored with "BPL" (LLM)
      // must match a user who has "BPL / Economically Weaker" (frontend).
      const opts = expandCategorySet(
        new Set((group || []).map((c) => String(c).toLowerCase()).filter(Boolean))
      );
      const satisfiedBy = [...opts].filter((c) => userCats.has(c));
      return { group, opts: [...opts], satisfiedBy };
    });

    const unmetGroups = groupResults.filter((g) => g.satisfiedBy.length === 0);
    const metGroups = groupResults.filter((g) => g.satisfiedBy.length > 0);

    if (unmetGroups.length === 0) {
      positive.push({
        rule: "category",
        reason: `user satisfies every category requirement: ${metGroups
          .map((g) => g.satisfiedBy.join("|"))
          .join(" AND ")}`,
      });
    } else {
      failed.push({
        rule: "category",
        reason: `missing required category group(s): ${unmetGroups
          .map((g) => `[${g.group.join(" or ")}]`)
          .join(" AND ")}; user has ${p.categories?.join(", ") || "(none)"}`,
      });
    }
  }

  // ---- occupation ----
  if ((rules.occupations || []).length === 0) {
    noConstraint.push({ rule: "occupation", reason: "no occupation restriction" });
  } else {
    const schemeOccs = toLowerSet(rules.occupations);
    const userOcc = (p.occupation || "").toLowerCase();
    if (userOcc && schemeOccs.has(userOcc)) {
      positive.push({ rule: "occupation", reason: `${p.occupation} qualifies` });
    } else if (!userOcc && !strict) {
      noConstraint.push({ rule: "occupation", reason: "user occupation unknown, non-strict" });
    } else if (!userOcc) {
      unknown.push({ rule: "occupation", reason: `requires ${rules.occupations.join("/")}, user occupation not provided` });
    } else {
      failed.push({
        rule: "occupation",
        reason: `requires ${rules.occupations.join("/")}, user "${p.occupation || "(unset)"}"`,
      });
    }
  }

  // ---- applicantType ----
  const reqApplicantTypes = (rules.applicantTypes || []).map((t) => String(t).toUpperCase());
  if (reqApplicantTypes.length === 0) {
    noConstraint.push({ rule: "applicantType", reason: "no applicant entity type restriction" });
  } else {
    const typeSet = new Set(reqApplicantTypes);
    const userOcc = (p.occupation || "").toLowerCase();

    // Strict organizational / institutional gate:
    // Schemes for INSTITUTION or NGO_SHG can NEVER be applied to by an individual citizen.
    if (typeSet.has("INSTITUTION") || typeSet.has("NGO_SHG")) {
      failed.push({
        rule: "applicantType",
        reason: `scheme is restricted to institutions/organizations (${[...typeSet].join(", ")}), not individual citizens`,
      });
    } else if (typeSet.has("ENTERPRISE") && userOcc !== "entrepreneur" && userOcc !== "self-employed") {
      failed.push({
        rule: "applicantType",
        reason: `scheme is restricted to enterprise/startup applicants, user occupation is "${p.occupation || "(unset)"}"`,
      });
    } else if (typeSet.has("FACULTY_RESEARCHER") && userOcc !== "faculty" && userOcc !== "scientist" && userOcc !== "researcher") {
      failed.push({
        rule: "applicantType",
        reason: `scheme requires faculty/researcher applicant, user occupation is "${p.occupation || "(unset)"}"`,
      });
    } else if (typeSet.has("FARMER") && userOcc !== "farmer" && userOcc) {
      failed.push({
        rule: "applicantType",
        reason: `scheme requires farmer applicant, user occupation is "${p.occupation}"`,
      });
    } else if (typeSet.has("STUDENT") && userOcc !== "student" && userOcc) {
      failed.push({
        rule: "applicantType",
        reason: `scheme requires student applicant, user occupation is "${p.occupation}"`,
      });
    } else {
      positive.push({
        rule: "applicantType",
        reason: `applicant type (${[...typeSet].join(", ")}) matches user profile`,
      });
    }
  }

  // ---- age ----
  const userAge = Number.isFinite(p.age) ? p.age : null;
  const hasAgeRule = rules.minAge != null || rules.maxAge != null;
  if (hasAgeRule) {
    if (userAge === null) {
      if (strict) {
        unknown.push({ rule: "age", reason: `scheme has age rule (${rules.minAge ?? "-"}..${rules.maxAge ?? "-"}), age not provided` });
      } else {
        noConstraint.push({ rule: "age", reason: "user age unknown, non-strict" });
      }
    } else if (rules.minAge != null && userAge < rules.minAge) {
      failed.push({ rule: "age", reason: `min ${rules.minAge}, user ${userAge}` });
    } else if (rules.maxAge != null && userAge > rules.maxAge) {
      failed.push({ rule: "age", reason: `max ${rules.maxAge}, user ${userAge}` });
    } else {
      positive.push({ rule: "age", reason: `${userAge} within range` });
    }
  }

  // ---- income ----
  const userIncome = Number.isFinite(p.annualIncome) ? p.annualIncome : null;
  const hasIncomeRule = rules.maxAnnualIncome != null || rules.minAnnualIncome != null;
  if (hasIncomeRule) {
    if (userIncome === null) {
      if (strict) unknown.push({ rule: "annualIncome", reason: "scheme has income rule, income not provided" });
      else noConstraint.push({ rule: "annualIncome", reason: "user income unknown, non-strict" });
    } else if (rules.maxAnnualIncome != null && userIncome > rules.maxAnnualIncome) {
      failed.push({ rule: "annualIncome", reason: `max ₹${rules.maxAnnualIncome}, user ₹${userIncome}` });
    } else if (rules.minAnnualIncome != null && userIncome < rules.minAnnualIncome) {
      failed.push({ rule: "annualIncome", reason: `min ₹${rules.minAnnualIncome}, user ₹${userIncome}` });
    } else {
      positive.push({ rule: "annualIncome", reason: `₹${userIncome} within range` });
    }
  }

  // ---- education (minimum) ----
  if (rules.minEducationLevel) {
    if (!p.education) {
      if (strict) unknown.push({ rule: "education", reason: `requires ${rules.minEducationLevel}, not provided` });
      else noConstraint.push({ rule: "education", reason: "user education unknown, non-strict" });
    } else if (meetsEducation(p.education, rules.minEducationLevel)) {
      positive.push({ rule: "education", reason: `${p.education} ≥ ${rules.minEducationLevel}` });
    } else {
      failed.push({ rule: "education", reason: `requires ${rules.minEducationLevel}, user "${p.education}"` });
    }
  }

  // ---- education (maximum) — the mirror of the rule above, for schemes
  // that stop applying once a person has too much education (e.g. a
  // pre-matric scholarship). Evaluated independently: a scheme can (in
  // principle) specify both a floor and a ceiling.
  if (rules.maxEducationLevel) {
    if (!p.education) {
      if (strict) unknown.push({ rule: "maxEducationLevel", reason: `requires at most ${rules.maxEducationLevel}, not provided` });
      else noConstraint.push({ rule: "maxEducationLevel", reason: "user education unknown, non-strict" });
    } else if (withinMaxEducation(p.education, rules.maxEducationLevel)) {
      positive.push({ rule: "maxEducationLevel", reason: `${p.education} ≤ ${rules.maxEducationLevel}` });
    } else {
      failed.push({ rule: "maxEducationLevel", reason: `requires at most ${rules.maxEducationLevel}, user "${p.education}"` });
    }
  }

  // ---- course / stream ----
  if ((rules.courses || []).length === 0) {
    noConstraint.push({ rule: "course", reason: "no course/stream restriction" });
  } else {
    // Compare on the normalized/equivalence-mapped form so "B.Tech CSE",
    // "BE CSE" and "BSc Computer Science" all match a scheme rule of
    // "Computer Science" — see normalizeCourse() above.
    const schemeCourses = new Set((rules.courses || []).map(normalizeCourse).filter(Boolean));
    const userCourse = normalizeCourse(p.course);
    if (userCourse && schemeCourses.has(userCourse)) {
      positive.push({ rule: "course", reason: `${p.course} qualifies` });
    } else if (!userCourse && !strict) {
      noConstraint.push({ rule: "course", reason: "user course unknown, non-strict" });
    } else if (!userCourse) {
      unknown.push({ rule: "course", reason: `requires ${rules.courses.join("/")}, user course not provided` });
    } else {
      failed.push({
        rule: "course",
        reason: `requires ${rules.courses.join("/")}, user "${p.course || "(unset)"}"`,
      });
    }
  }

  // ---- marks ----
  const userMarks = Number.isFinite(p.marksPercentage) ? p.marksPercentage : null;
  if (rules.minMarksPercentage != null) {
    if (userMarks === null) {
      if (strict) unknown.push({ rule: "marks", reason: `requires ${rules.minMarksPercentage}%, not provided` });
      else noConstraint.push({ rule: "marks", reason: "user marks unknown, non-strict" });
    } else if (userMarks >= rules.minMarksPercentage) {
      positive.push({ rule: "marks", reason: `${userMarks}% ≥ ${rules.minMarksPercentage}%` });
    } else {
      failed.push({ rule: "marks", reason: `min ${rules.minMarksPercentage}%, user ${userMarks}%` });
    }
  }

  // ---- disability ----
  // Two independent signals: whether disability is required at all, and
  // (if the scheme names one) a minimum percentage threshold. `p.disability`
  // and `p.disabilityPercentage` are tri-state (true/false/null) — see
  // models/User.js. `null`/unanswered MUST route to `unknown`, never to
  // `failed`: defaulting an unanswered question to "does not have a
  // disability" would silently reject someone who simply hasn't been asked.
  const hasDisabilityRule = rules.disabilityRequired === true || rules.minDisabilityPercentage != null;
  if (hasDisabilityRule) {
    if (p.disability === null || p.disability === undefined) {
      if (strict) unknown.push({ rule: "disability", reason: "scheme requires disability status, not provided" });
      else noConstraint.push({ rule: "disability", reason: "user disability status unknown, non-strict" });
    } else if (p.disability === false) {
      failed.push({ rule: "disability", reason: "scheme requires a person with disability, user has none" });
    } else if (rules.minDisabilityPercentage != null) {
      const userPct = Number.isFinite(p.disabilityPercentage) ? p.disabilityPercentage : null;
      if (userPct === null) {
        if (strict) unknown.push({ rule: "disability", reason: `requires ≥${rules.minDisabilityPercentage}% disability, percentage not provided` });
        else noConstraint.push({ rule: "disability", reason: "user disability percentage unknown, non-strict" });
      } else if (userPct >= rules.minDisabilityPercentage) {
        positive.push({ rule: "disability", reason: `${userPct}% ≥ ${rules.minDisabilityPercentage}% required` });
      } else {
        failed.push({ rule: "disability", reason: `requires ≥${rules.minDisabilityPercentage}%, user ${userPct}%` });
      }
    } else {
      positive.push({ rule: "disability", reason: "user has a disability, as required" });
    }
  } else {
    noConstraint.push({ rule: "disability", reason: "no disability restriction" });
  }

  // ---- single girl child ----
  if (rules.singleGirlChildRequired === true) {
    if (p.singleGirlChild === null || p.singleGirlChild === undefined) {
      if (strict) unknown.push({ rule: "singleGirlChild", reason: "scheme requires single-girl-child status, not provided" });
      else noConstraint.push({ rule: "singleGirlChild", reason: "user single-girl-child status unknown, non-strict" });
    } else if (p.singleGirlChild === true) {
      positive.push({ rule: "singleGirlChild", reason: "user is a single girl child, as required" });
    } else {
      failed.push({ rule: "singleGirlChild", reason: "scheme requires a single girl child, user is not" });
    }
  } else {
    noConstraint.push({ rule: "singleGirlChild", reason: "no single-girl-child restriction" });
  }

  return { positive, failed, unknown, noConstraint };
}

/**
 * Evaluate one user × one scheme. Returns a verdict object with the
 * eligible boolean, a tri-state `status` (ELIGIBLE / NOT_ELIGIBLE /
 * NEEDS_MORE_INFORMATION), the score used for ranking, mode metadata for
 * the "why" UI, and the raw rule lists.
 *
 * Status precedence (never violated, regardless of eligibilityType):
 *   1. Any KNOWN failed condition            → NOT_ELIGIBLE
 *   2. No failure, but a required field the
 *      user hasn't answered yet              → NEEDS_MORE_INFORMATION
 *   3. Every required condition satisfied     → ELIGIBLE
 * `eligible` (boolean, kept for every existing caller) is exactly
 * `status === "ELIGIBLE"` — NEEDS_MORE_INFORMATION is NOT eligible, but it
 * is also explicitly NOT the same claim as NOT_ELIGIBLE, and callers that
 * want to distinguish the two (the /matches route, the chat assistant)
 * should read `status`, not just `eligible`.
 */
function evaluateEligibility(user, scheme, { allowUnknown = false, strict = true } = {}) {
  const rules = scheme.eligibilityRules || {};
  const eligibilityType = rules.eligibilityType || "unknown";

  if (eligibilityType === "unknown" && !allowUnknown) {
    return {
      eligible: false,
      status: "NOT_ELIGIBLE",
      mode: "unknown",
      eligibilityType,
      score: -Infinity,
      matched: [],
      positiveMatches: [],
      failed: [{ rule: "eligibilityType", reason: "scheme eligibility is unknown / unparsed" }],
      unknown: [],
      noConstraint: [],
    };
  }

  const { positive, failed, unknown, noConstraint } = checkRules(user, rules, { strict, scheme });

  // A known failure is authoritative regardless of eligibilityType or how
  // many other signals are positive — one hard fail always beats every
  // positive match. This is checked identically for every branch below.
  let status;
  if (failed.length > 0) {
    status = "NOT_ELIGIBLE";
  } else if (unknown.length > 0) {
    status = "NEEDS_MORE_INFORMATION";
  } else if (eligibilityType === "universal") {
    // Universal schemes match everyone who doesn't actively fail or leave
    // a rule unanswered. We inject a synthetic "universal" positive so
    // downstream UI has something to display for the "matched because" list.
    status = "ELIGIBLE";
    if (positive.length === 0) {
      positive.push({ rule: "universal", reason: "scheme is open to all" });
    }
  } else {
    // constrained, or the allowUnknown path (treated like constrained) —
    // needs a real positive signal, not just an absence of problems.
    status = positive.length >= 1 ? "ELIGIBLE" : "NOT_ELIGIBLE";
  }

  const eligible = status === "ELIGIBLE";
  const score = positive.length - HARD_FAIL_PENALTY * failed.length;

  return {
    eligible,
    status,
    mode: eligibilityType === "unknown" ? "unknown" : "rules",
    eligibilityType,
    score,
    matched: positive, // backwards-compat name
    positiveMatches: positive,
    failed,
    unknown,
    noConstraint,
  };
}

function isMatch(user, scheme, opts) {
  return evaluateEligibility(user, scheme, opts).eligible;
}

function getDocumentReadiness(user, scheme) {
  const required = scheme.documents || [];
  if (required.length === 0) return { required: 0, have: 0, missing: [] };
  const have = new Set((user.profile?.documentsAvailable || []).map((d) => d.toLowerCase()));
  const missing = required.filter((d) => !have.has(d.toLowerCase()));
  return { required: required.length, have: required.length - missing.length, missing };
}

module.exports = { evaluateEligibility, isMatch, checkRules, getDocumentReadiness, normalizeCourse, expandCategorySet };
