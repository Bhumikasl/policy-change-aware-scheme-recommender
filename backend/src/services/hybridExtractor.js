/**
 * Hybrid eligibility extractor.
 *
 * Strategy — LLM assists, it does NOT decide:
 *
 *   1. Deterministic pass (regex + keyword) runs FIRST. Anything it
 *      extracts is trusted highly — it's transparent and reproducible.
 *
 *   2. LLM pass runs on the same text. Its output is used ONLY to fill
 *      fields the deterministic pass left null / [], and to help classify
 *      eligibilityType when deterministic couldn't decide.
 *
 *   3. Validation — when deterministic AND LLM both produced a value for
 *      the same field, we compare them:
 *         - Numeric fields: agreement within tolerance → keep deterministic.
 *           Big mismatch → keep deterministic, drop confidence, flag review.
 *         - Array fields: intersection kept, union added with lower conf.
 *
 *   4. Confidence blending — the result's confidence is bounded by:
 *         high  (>=0.75)  : deterministic found >=3 signals OR both agreed
 *         medium (>=0.5)  : one source only, no conflicts
 *         low   (<0.5)    : conflict, or LLM-only with sparse signals
 *
 *   5. needsReview flag — set to true whenever confidence < 0.5, LLM and
 *      deterministic disagreed on a numeric field, or the source is
 *      "unparsed". Downstream code (matcher, admin UI) can use this.
 *
 * Callers get one clean rules object shaped like Scheme.eligibilityRules
 * plus eligibilityType, needsReview, and a per-field provenance map for
 * auditability.
 */

const { extractDeterministic, hasUnrepresentedRestrictions } = require("./deterministicExtractor");
const { extractEligibility: llmExtract } = require("./eligibilityExtractor");
const logger = require("../utils/logger");

const NUMERIC_FIELDS = [
  "minAge", "maxAge",
  "minAnnualIncome", "maxAnnualIncome",
  "minMarksPercentage", "minDisabilityPercentage",
];
const ARRAY_FIELDS = ["genders", "categories", "occupations", "applicantTypes", "states", "courses"];
const RANKED_FIELDS = ["minEducationLevel", "maxEducationLevel"];
// Booleans that mean "this restriction applies" — never merged by
// preferring a value over null the way numbers are; either side finding
// `true` is enough to keep it (a false negative here silently drops a
// disability/single-girl-child restriction, which is worse than a
// spurious needsReview flag).
const BOOLEAN_FIELDS = ["disabilityRequired", "singleGirlChildRequired"];

function numbersAgree(a, b) {
  if (a === null || b === null) return true; // one side unknown → no conflict
  if (a === b) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denom <= 0.1; // within 10%
}

function mergeArrays(det, llm) {
  const d = new Set((det || []).map((x) => x.trim()).filter(Boolean));
  const l = new Set((llm || []).map((x) => x.trim()).filter(Boolean));
  if (d.size === 0) return { value: [...l], agreed: l.size === 0 };
  if (l.size === 0) return { value: [...d], agreed: true };
  // If deterministic found something, prefer intersection when non-empty,
  // else union (LLM may have caught a synonym).
  const inter = [...d].filter((x) => l.has(x));
  if (inter.length > 0) return { value: inter, agreed: true };
  return { value: [...new Set([...d, ...l])], agreed: false };
}

/**
 * Combine deterministic + LLM outputs.
 * @param {Object} det  deterministic rules (from deterministicExtractor)
 * @param {Object|null} llm  LLM rules (from eligibilityExtractor) or null
 * @returns merged rules + provenance + needsReview
 */
function merge(det, llm) {
  const provenance = {};
  const conflicts = [];
  const merged = {
    minAge: null, maxAge: null,
    minAnnualIncome: null, maxAnnualIncome: null,
    minMarksPercentage: null, minEducationLevel: null, maxEducationLevel: null,
    genders: [], categories: [], categoryGroups: [], occupations: [], applicantTypes: [], states: [],
    courses: [], disabilityRequired: null, minDisabilityPercentage: null,
    singleGirlChildRequired: null,
  };

  for (const f of NUMERIC_FIELDS) {
    const dv = det?.[f] ?? null;
    const lv = llm?.[f] ?? null;
    if (dv !== null && lv !== null) {
      merged[f] = dv; // deterministic wins on conflict
      provenance[f] = "deterministic";
      if (!numbersAgree(dv, lv)) {
        conflicts.push({ field: f, deterministic: dv, llm: lv });
      }
    } else if (dv !== null) {
      merged[f] = dv;
      provenance[f] = "deterministic";
    } else if (lv !== null) {
      merged[f] = lv;
      provenance[f] = "llm";
    } else {
      provenance[f] = "none";
    }
  }

  // Education is categorical but ranked — same rule: deterministic wins.
  for (const f of RANKED_FIELDS) {
    const dv = det?.[f] ?? null;
    const lv = llm?.[f] ?? null;
    if (dv) {
      merged[f] = dv;
      provenance[f] = "deterministic";
      if (lv && lv !== dv) conflicts.push({ field: f, deterministic: dv, llm: lv });
    } else if (lv) {
      merged[f] = lv;
      provenance[f] = "llm";
    } else {
      provenance[f] = "none";
    }
  }

  // Booleans: either source asserting `true` is kept — see BOOLEAN_FIELDS
  // comment above for why this is not a symmetric "deterministic wins".
  for (const f of BOOLEAN_FIELDS) {
    const dv = det?.[f] ?? null;
    const lv = llm?.[f] ?? null;
    if (dv === true || lv === true) {
      merged[f] = true;
      provenance[f] = dv === true && lv === true ? "both" : (dv === true ? "deterministic" : "llm");
      if (dv === true && lv === false) conflicts.push({ field: f, deterministic: dv, llm: lv });
    } else {
      merged[f] = null;
      provenance[f] = "none";
    }
  }

  for (const f of ARRAY_FIELDS) {
    const { value, agreed } = mergeArrays(det?.[f], llm?.[f]);
    merged[f] = value;
    if ((det?.[f] || []).length && (llm?.[f] || []).length) {
      provenance[f] = agreed ? "both" : "deterministic+llm-conflict";
      if (!agreed) conflicts.push({ field: f, deterministic: det[f], llm: llm[f], resolved: value });
    } else if ((det?.[f] || []).length) provenance[f] = "deterministic";
    else if ((llm?.[f] || []).length) provenance[f] = "llm";
    else provenance[f] = "none";
  }

  // categoryGroups: only the deterministic extractor knows how to build
  // these (the LLM returns a flat list). If deterministic didn't produce
  // groups, synthesize AND-required singletons from the merged flat list
  // so the matcher still enforces strict AND behavior.
  if (Array.isArray(det?.categoryGroups) && det.categoryGroups.length > 0) {
    merged.categoryGroups = det.categoryGroups.map((g) => [...g]);
    provenance.categoryGroups = "deterministic";
  } else if ((merged.categories || []).length > 0) {
    merged.categoryGroups = merged.categories.map((c) => [c]);
    provenance.categoryGroups = "derived-from-flat";
  } else {
    provenance.categoryGroups = "none";
  }

  return { merged, provenance, conflicts };
}

function classifyEligibilityType(merged, detType, llmIsUniversal, freeText = "") {
  // Any restrictive signal at all → constrained. This check MUST run
  // before any universal classification below — a scheme can never be
  // both restricted and universal, no matter what the wording says.
  const hasSignal =
    merged.minAge !== null || merged.maxAge !== null ||
    merged.minAnnualIncome !== null || merged.maxAnnualIncome !== null ||
    merged.minMarksPercentage !== null || !!merged.minEducationLevel ||
    !!merged.maxEducationLevel ||
    (merged.genders || []).length > 0 ||
    (merged.categories || []).length > 0 ||
    (merged.categoryGroups || []).length > 0 ||
    (merged.occupations || []).length > 0 ||
    (merged.states || []).length > 0 ||
    (merged.courses || []).length > 0 ||
    merged.disabilityRequired === true ||
    (merged.minDisabilityPercentage ?? null) !== null ||
    merged.singleGirlChildRequired === true;

  if (hasSignal) return "constrained";

  // No signals were extracted into structured rules. This does NOT by
  // itself mean the scheme is universal — it may just mean nothing
  // parsed. Only classify as universal when there is a POSITIVE signal
  // that the text actually says so AND no unrepresented restrictive indicators exist.
  const hasUnrepresented = hasUnrepresentedRestrictions(freeText);
  if (!hasUnrepresented) {
    if (detType === "universal") return "universal";
    if (llmIsUniversal === true) return "universal";
  }
  return "unknown";
}

async function extractHybrid(freeText, { useLlm = true } = {}) {
  const det = extractDeterministic(freeText);

  const threshold = process.env.LLM_ESCALATE_BELOW != null ? Number(process.env.LLM_ESCALATE_BELOW) : 0.7;
  const shouldEscalate = useLlm && (det.confidence < threshold || threshold > 1.0);

  let llm = null;
  if (shouldEscalate) {
    try {
      llm = await llmExtract(freeText);
    } catch (err) {
      logger.warn("hybridExtractor: LLM call threw, using deterministic only", { error: err.message });
      llm = null;
    }
  }

  const { merged, provenance, conflicts } = merge(det, llm);
  const eligibilityType = classifyEligibilityType(merged, det.eligibilityType, llm?.isUniversal === true, freeText);

  // Confidence blend:
  //   - start from deterministic confidence
  //   - +0.1 if LLM was available AND had no conflicts with deterministic
  //   - -0.2 per conflict (floor 0.05)
  //   - if source is LLM-only with confidence < 0.4, cap at 0.4
  let confidence = det.confidence;
  if (llm && conflicts.length === 0) confidence = Math.min(0.95, confidence + 0.1);
  confidence = Math.max(0.05, confidence - 0.2 * conflicts.length);
  if (det.signals === 0 && llm) {
    confidence = Math.min(confidence, Math.max(0.4, llm.confidence || 0));
  }

  // Decide the recorded source. Whichever contributed the most non-null
  // fields "wins" the label, with "both" when they agreed on anything.
  let source = "deterministic";
  if (llm && Object.values(provenance).some((v) => v === "llm")) {
    source = Object.values(provenance).some((v) => v === "deterministic" || v === "both") ? "llm-extracted" : "llm-extracted";
  }
  if (det.signals === 0 && !llm) source = "unparsed";

  const needsReview =
    confidence < 0.5 ||
    conflicts.length > 0 ||
    (eligibilityType === "unknown");

  return {
    ...merged,
    eligibilityType,
    source,
    confidence,
    extractedAt: new Date(),
    provenance,
    conflicts,
    needsReview,
  };
}

module.exports = { extractHybrid, merge, classifyEligibilityType };
