const { generateStructured } = require("../services/llmClient");
const {
  describeChange,
  relevantFactors,
  RULE_TO_ATTRIBUTE,
} = require("../services/explanationTemplates");
const {
  ELIGIBILITY_TRANSITIONS,
  RECOMMENDATION_TRANSITIONS,
} = require("../constants/recommendationTransitions");
const logger = require("../utils/logger");

/**
 * AGENT 3 — EXPLANATION AGENT
 *
 * Turns a recorded transition into a sentence the person it happened to can
 * read, and can check.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 * Every fact in the output must already exist in the input. The agent phrases
 * what Phase J observed; it never decides eligibility, never supplies a
 * threshold, never fills a gap with something plausible.
 *
 * That rule is enforced twice, not asserted once:
 *
 *   1. STRUCTURE. The deterministic path renders from stored values through
 *      fixed templates, so there is no step at which a number could be
 *      invented.
 *
 *   2. GROUNDING CHECK. Any sentence that reaches a user — template or LLM —
 *      is scanned for numerals, and every one must appear in the grounding
 *      set. An LLM sentence citing "₹3.5 lakh" when the record says ₹3 lakh is
 *      rejected and the template is used instead.
 *
 * A number the check cannot find is treated as invented, even if it is
 * plausible. That is the point: plausible is exactly what a hallucination
 * looks like.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE LLM IS USED AT ALL
 * ---------------------------------------------------------------------------
 * Only when synthesis genuinely helps: several conditions moved at once and
 * the templates would produce a list of disconnected sentences. A single
 * threshold change is rendered deterministically, always — it is faster, free,
 * reproducible, and cannot be wrong.
 *
 * If the LLM is unavailable, rate-limited or ungrounded, the template output
 * stands. Explanations degrade in fluency, never in accuracy.
 *
 * ---------------------------------------------------------------------------
 * INSUFFICIENT EVIDENCE
 * ---------------------------------------------------------------------------
 * When the record does not contain enough to say WHY — no phrasable changed
 * field, or no user attribute connected to the moved rule — the agent returns
 * `sufficientEvidence: false` and a summary that says so. It does not guess,
 * and the UI shows the absence rather than a confident-sounding sentence with
 * nothing behind it.
 */

const MIN_CONFIDENCE_TO_SHOW = 0.4;

/** Pull every number out of a sentence, normalised for comparison. */
function numeralsIn(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

/**
 * Every number the explanation is allowed to contain: the old and new values
 * of each changed field, the user's own relevant attribute values, and the
 * ranks. Money appears in both raw and lakh/crore form because the templates
 * print "₹2.5 lakh" for 250000, and 2.5 is then a legitimate numeral.
 */
function buildGroundingNumbers({ changedFields = [], factors = [], previousRank, newRank, topK }) {
  const nums = new Set();
  const addValue = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      nums.add(v);
      if (v >= 100000) nums.add(Number((v / 100000).toFixed(2)));
      if (v >= 10000000) nums.add(Number((v / 10000000).toFixed(2)));
      // "₹2.50 lakh" trims to "₹2.5 lakh"
      if (v >= 100000) nums.add(Number(String(v / 100000)));
    } else if (typeof v === "string") {
      for (const n of numeralsIn(v)) nums.add(n);
    } else if (Array.isArray(v)) {
      v.forEach(addValue);
    }
  };

  for (const f of changedFields) {
    addValue(f.oldValue);
    addValue(f.newValue);
  }
  for (const f of factors) addValue(f.value);
  [previousRank, newRank, topK].forEach((r) => {
    if (typeof r === "number") nums.add(r);
  });
  return nums;
}

/**
 * Is every numeral in `text` present in the grounding set?
 *
 * Years are excluded from the check: a formatted date legitimately contains
 * "2026" when the stored value is "2026-12-31", and the date itself is already
 * grounded by the field it came from.
 */
function isGrounded(text, groundingNumbers) {
  const unexplained = [];
  for (const n of numeralsIn(text)) {
    if (groundingNumbers.has(n)) continue;
    if (Number.isInteger(n) && n >= 1900 && n <= 2200) continue; // a year
    unexplained.push(n);
  }
  return { grounded: unexplained.length === 0, unexplained };
}

// ---------------------------------------------------------------------------
// Deterministic rendering
// ---------------------------------------------------------------------------

function renderEligibilitySentence({ eligibilityTransition, changes, factors }) {
  const primary = changes[0];
  const factor = factors[0];

  if (eligibilityTransition === ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE) {
    if (primary && factor) {
      return `${primary.sentence} Because ${factor.label} is ${factor.display}, you now meet this condition.`;
    }
    if (primary) return `${primary.sentence} You now meet the scheme's conditions.`;
    return "You now meet this scheme's eligibility conditions.";
  }

  if (eligibilityTransition === ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_INELIGIBLE) {
    if (primary && factor) {
      return `${primary.sentence} Because ${factor.label} is ${factor.display}, you no longer meet this condition.`;
    }
    if (primary) return `${primary.sentence} You no longer meet the scheme's conditions.`;
    return "You no longer meet this scheme's eligibility conditions.";
  }

  return null;
}

function renderRecommendationSentence({ recommendationTransition, previousRank, newRank, topK }) {
  switch (recommendationTransition) {
    case RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED:
      return newRank
        ? `It has been added to your recommendations at position ${newRank}.`
        : "It has been added to your recommendations.";
    case RECOMMENDATION_TRANSITIONS.RECOMMENDED_TO_NOT_RECOMMENDED:
      return "It has been removed from your recommendations.";
    // Rank 1 is best, so "moved up" means the NUMBER fell.
    case RECOMMENDATION_TRANSITIONS.RANK_INCREASED:
      return `It moved up your list, from position ${previousRank} to ${newRank}.`;
    case RECOMMENDATION_TRANSITIONS.RANK_DECREASED:
      return `It moved down your list, from position ${previousRank} to ${newRank}.`;
    default:
      return null;
  }
}

/**
 * Explain a change that leaves eligibility and rank untouched but alters a
 * term of the scheme the user holds — the deadline case Phase J records.
 */
function renderHolderSentence({ changes, reasonCode }) {
  const relevant = changes.find((c) =>
    ({
      DEADLINE_CHANGED: "lastDate",
      BENEFIT_CHANGED: "benefits",
      DOCUMENTS_CHANGED: "documents",
    }[reasonCode] === c.field)
  );
  if (!relevant) return null;
  return `${relevant.sentence} Your eligibility is unchanged, but this affects a scheme you qualify for.`;
}

// ---------------------------------------------------------------------------
// LLM synthesis — only for genuinely multi-condition cases
// ---------------------------------------------------------------------------

const LLM_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["summary", "confidence"],
};

const LLM_SYSTEM = `You rewrite a set of factual statements about an Indian government scheme change into ONE short paragraph addressed to the user.

ABSOLUTE RULES:
- Use ONLY the facts given. Do not add any number, threshold, date, benefit or requirement that is not in the input.
- Do not state whether the user is eligible. That has already been decided; you are describing a decision, not making one.
- Do not speculate about why the government made the change.
- Keep every figure exactly as written in the input.
- Two or three sentences. Plain, direct, second person. No greeting, no sign-off.

Set confidence to 0.9 when you used only the given facts, and lower if you were unsure.`;

/** Worth an LLM call? Only when there is genuinely something to synthesise. */
function warrantsSynthesis({ changes, factors }) {
  return changes.length >= 2 || (changes.length >= 1 && factors.length >= 2);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Explain one recommendation transition.
 *
 * @param {Object} opts
 * @param {Object} opts.record   the RecommendationHistory document being written
 * @param {Object} [opts.profile] the user's profile (used ONLY for the moved rules)
 * @param {Object} [opts.scheme]  the scheme, for its name
 * @param {boolean} [opts.useLlm]
 * @param {Function} [opts.llm]   injectable generateStructured, for tests
 */
async function explainTransition({
  record,
  profile = {},
  scheme = null,
  useLlm = process.env.EXPLANATION_LLM !== "false",
  llm = generateStructured,
} = {}) {
  const reason = record?.reason || {};
  const changedFields = reason.changedFields || [];

  // Only fields we can phrase. An unphrasable field is dropped rather than
  // shown to a user as a dotted path.
  const changes = changedFields.map(describeChange).filter(Boolean);

  const factors = relevantFactors({
    rulesNowPassing: reason.rulesNowPassing,
    rulesNowFailing: reason.rulesNowFailing,
    profile,
  });

  const groundingNumbers = buildGroundingNumbers({
    changedFields,
    factors,
    previousRank: record?.previousRank,
    newRank: record?.newRank,
    topK: record?.topK,
  });

  const base = {
    schemeId: record?.schemeId ?? null,
    schemeName: scheme?.name || record?.schemeName || "",
    changeId: record?.triggeringChangeId ?? null,
    summary: "",
    changedConditions: changes.map((c) => ({
      field: c.field,
      label: c.label,
      from: c.from,
      to: c.to,
      sentence: c.sentence,
    })),
    userRelevantFactors: factors.map((f) => ({
      attribute: f.attribute,
      label: f.label,
      display: f.display,
    })),
    eligibilityReason: null,
    recommendationReason: null,
    confidence: 0,
    groundingSources: [],
    method: "template",
    sufficientEvidence: false,
  };

  // Grounding provenance: what each statement is allowed to rest on.
  base.groundingSources = [
    ...changedFields.map((f) => ({
      type: "schemeField",
      field: f.field,
      oldValue: f.oldValue,
      newValue: f.newValue,
      schemeVersions: [record?.previousSchemeVersion ?? null, record?.newSchemeVersion ?? null],
    })),
    ...factors.map((f) => ({ type: "userProfile", attribute: f.attribute, value: f.value })),
  ];

  const eligibilitySentence = renderEligibilitySentence({
    eligibilityTransition: record?.eligibilityTransition,
    changes,
    factors,
  });
  const recommendationSentence = renderRecommendationSentence({
    recommendationTransition: record?.recommendationTransition,
    previousRank: record?.previousRank,
    newRank: record?.newRank,
    topK: record?.topK,
  });
  const holderSentence =
    !eligibilitySentence && !recommendationSentence
      ? renderHolderSentence({ changes, reasonCode: reason.code })
      : null;

  base.eligibilityReason = eligibilitySentence;
  base.recommendationReason = recommendationSentence;

  const parts = [eligibilitySentence, recommendationSentence, holderSentence].filter(Boolean);

  // ---- insufficient evidence -------------------------------------------
  // Nothing phrasable, or an eligibility flip with no field behind it. Saying
  // "your eligibility changed" with no cause is not an explanation; it is a
  // confident-sounding blank.
  const flipped =
    record?.eligibilityTransition === ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE ||
    record?.eligibilityTransition === ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_INELIGIBLE;

  if (parts.length === 0 || (flipped && changes.length === 0)) {
    return {
      ...base,
      summary:
        "This scheme changed in a way that affected you, but the record does not contain enough detail to explain why.",
      confidence: 0,
      sufficientEvidence: false,
      method: "template",
    };
  }

  const templateSummary = parts.join(" ");
  const templateCheck = isGrounded(templateSummary, groundingNumbers);

  // A template producing an ungrounded number means a template bug, not a
  // hallucination — but the user must not receive it either way.
  if (!templateCheck.grounded) {
    logger.warn("ExplanationAgent: template output failed its own grounding check", {
      schemeId: base.schemeId,
      changeId: base.changeId,
      unexplained: templateCheck.unexplained,
    });
    return {
      ...base,
      summary:
        "This scheme changed in a way that affected you. The detailed explanation could not be verified against the stored record.",
      confidence: 0,
      sufficientEvidence: false,
      method: "template",
    };
  }

  const result = {
    ...base,
    summary: templateSummary,
    confidence: 0.95, // rendered from stored values; nothing was interpreted
    sufficientEvidence: true,
    method: "template",
  };

  // ---- optional synthesis ------------------------------------------------
  if (!useLlm || !warrantsSynthesis({ changes, factors })) return result;

  try {
    const parsed = await llm(
      LLM_SYSTEM,
      JSON.stringify({
        scheme: base.schemeName,
        facts: parts,
        changedConditions: base.changedConditions.map((c) => c.sentence),
        yourDetails: factors.map((f) => `${f.label} is ${f.display}`),
      }),
      LLM_SCHEMA,
      { temperature: 0 }
    );

    if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) return result;

    const check = isGrounded(parsed.summary, groundingNumbers);
    if (!check.grounded) {
      // The model produced a figure the record does not contain. Keep the
      // template: a fluent wrong number is worse than a plain right one.
      logger.warn("ExplanationAgent: LLM output rejected as ungrounded", {
        schemeId: base.schemeId,
        changeId: base.changeId,
        unexplained: check.unexplained,
      });
      return { ...result, llmRejected: true, llmRejectionReason: "ungrounded numerals" };
    }

    const llmConfidence =
      typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.6;
    if (llmConfidence < MIN_CONFIDENCE_TO_SHOW) {
      return { ...result, llmRejected: true, llmRejectionReason: "low confidence" };
    }

    return {
      ...result,
      summary: parsed.summary.trim(),
      // Capped below the template's: a synthesised sentence is grounded but
      // still interpreted, and should never outrank a rendered fact.
      confidence: Math.min(0.9, llmConfidence),
      method: "template+llm",
    };
  } catch (err) {
    // An LLM outage must never cost the user their explanation.
    logger.warn("ExplanationAgent: LLM unavailable, keeping template", { error: err.message });
    return { ...result, llmRejected: true, llmRejectionReason: "llm unavailable" };
  }
}

module.exports = {
  explainTransition,
  isGrounded,
  numeralsIn,
  buildGroundingNumbers,
  warrantsSynthesis,
  renderEligibilitySentence,
  renderRecommendationSentence,
  MIN_CONFIDENCE_TO_SHOW,
};
