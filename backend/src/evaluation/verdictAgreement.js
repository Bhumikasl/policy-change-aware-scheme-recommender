/**
 * VERDICT AGREEMENT CLASSIFIER — the Phase P.3 instrument.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * Given a deterministic verdict (ELIGIBLE / NOT ELIGIBLE) and the prose a
 * model produced to explain it, decide what that prose actually tells the
 * reader about their eligibility.
 *
 * The production contradiction guard answers a narrower question — "does this
 * text explicitly assert the opposite?" — using two regexes. This classifier
 * exists to find what those regexes MISS, so it must recognise reversals the
 * guard cannot.
 *
 * ---------------------------------------------------------------------------
 * THIS CLASSIFIER IS ITSELF A HEURISTIC. IT IS NOT GROUND TRUTH.
 * ---------------------------------------------------------------------------
 * It is pattern-based, so it has its own false positives and false negatives.
 * Using it to compute the headline false-negative rate would replace one
 * unvalidated regex with another and call the result a measurement.
 *
 * So its role is TRIAGE, not judgement:
 *
 *   - it classifies every sample, cheaply and reproducibly;
 *   - a human reviews the samples and assigns the authoritative label;
 *   - the headline false-negative rate is computed from HUMAN labels only;
 *   - classifier-vs-human agreement is itself reported, so the instrument's
 *     own reliability is visible rather than assumed.
 *
 * A classifier whose agreement with human labels is poor is a finding about
 * the classifier, and the report says so rather than quietly leaning on it.
 *
 * ---------------------------------------------------------------------------
 * DESIGN RULE: DO NOT FLAG EVERY NEGATIVE SENTENCE
 * ---------------------------------------------------------------------------
 * "You are not eligible" is CORRECT when the verdict is NOT ELIGIBLE. Negative
 * sentiment is not contradiction. Classification is always relative to the
 * verdict, and a classifier that flagged all negativity would report a huge
 * false-negative rate made entirely of correct answers.
 */

const LABELS = Object.freeze({
  AGREES_ELIGIBLE: "AGREES_ELIGIBLE",
  AGREES_INELIGIBLE: "AGREES_INELIGIBLE",
  DIRECT_REVERSAL: "DIRECT_REVERSAL",
  OBLIQUE_REVERSAL: "OBLIQUE_REVERSAL",
  HEDGE: "HEDGE",
  NEUTRAL: "NEUTRAL",
  UNSUPPORTED: "UNSUPPORTED",
});

/** Human labels. Deliberately a different, coarser vocabulary. */
const HUMAN_LABELS = Object.freeze({
  AGREE: "AGREE",
  DIRECT_CONTRADICTION: "DIRECT_CONTRADICTION",
  OBLIQUE_CONTRADICTION: "OBLIQUE_CONTRADICTION",
  NEUTRAL: "NEUTRAL",
  UNSUPPORTED: "UNSUPPORTED",
  UNCERTAIN: "UNCERTAIN",
});

// ---------------------------------------------------------------------------
// Pattern sets
// ---------------------------------------------------------------------------

/**
 * EXPLICIT assertions. These are what the production guard detects, and the
 * patterns are kept deliberately close to it so `DIRECT_REVERSAL` means "the
 * production guard should have caught this".
 */
const EXPLICIT_ELIGIBLE = [
  /\byou\s+(are|now)\s+(now\s+)?eligible\b/i,
  /\byou\s+qualify\b/i,
  /\byou\s+do\s+qualify\b/i,
  /\byou\s+meet\s+(all|every)\b/i,
];
const EXPLICIT_INELIGIBLE = [
  /\bnot\s+eligible\b/i,
  /\bdo\s+not\s+qualify\b/i,
  /\bdon't\s+qualify\b/i,
  /\bno\s+longer\s+eligible\b/i,
  /\bare\s+ineligible\b/i,
];

/**
 * OBLIQUE negation: says nothing about "eligible" or "qualify", but tells the
 * reader the scheme is not for them. This is the class the production guard
 * misses, and the reason Phase P exists.
 */
const OBLIQUE_NEGATIVE = [
  /\b(is|isn't|is\s+not)\s+(a\s+)?(good\s+)?match\s+for\s+(you|your)\b/i,
  /\bnot\s+(a\s+)?(good\s+)?(match|fit|suitable|suited)\b/i,
  /\bmay\s+want\s+to\s+(look\s+at|consider|explore)\s+(other|another|different)\b/i,
  /\b(should|could)\s+consider\s+(other|another|different)\s+scheme/i,
  /\blook\s+elsewhere\b/i,
  /\bthis\s+scheme\s+is\s+not\s+for\s+you\b/i,
  /\bunfortunately\b[^.]*\b(scheme|programme|program)\b/i,
  /\bother\s+schemes?\s+(may|might|would)\s+be\s+(more\s+)?(suitable|appropriate|better)\b/i,
];

/** Oblique POSITIVE: implies the scheme suits them without saying "eligible". */
const OBLIQUE_POSITIVE = [
  /\b(is|it's|this\s+is)\s+(a\s+)?(good|strong)\s+match\s+for\s+(you|your)\b/i,
  /\byou\s+can\s+apply\b/i,
  /\bgo\s+ahead\s+and\s+apply\b/i,
  /\byou\s+should\s+apply\b/i,
];

/**
 * HEDGES. Uncertainty about the reader's status.
 *
 * A hedge on an ELIGIBLE verdict is a problem: the decision is not uncertain,
 * and presenting it as uncertain may stop someone applying. A hedge on an
 * INELIGIBLE verdict is milder — it understates a negative — but it is still
 * a misrepresentation of a determinate result, so it is recorded either way
 * and left for the human to weigh.
 */
const HEDGE_PATTERNS = [
  /\b(may|might|could)\s+not\s+(qualify|be\s+eligible)\b/i,
  /\b(may|might|could)\s+(prevent|stop|disqualify|affect)\b/i,
  /\bit'?s\s+(unclear|not\s+clear)\b/i,
  /\b(may|might)\s+be\s+(an\s+)?(issue|problem|concern)\b/i,
  /\bdepend(s|ing)\s+on\b/i,
  /\bpossibly\s+(not\s+)?eligible\b/i,
  /\byou\s+may\s+(still\s+)?(be\s+able\s+to|qualify)\b/i,
];

const any = (patterns, text) => patterns.some((p) => p.test(text));

/**
 * Classify one generated answer against the deterministic verdict.
 *
 * @param {Object} opts
 * @param {string}  opts.answer   the generated prose
 * @param {boolean} opts.eligible the DETERMINISTIC verdict
 * @returns {{label, signals, reversal, explicit}}
 */
function classifyAgreement({ answer, eligible } = {}) {
  const text = String(answer || "").trim();
  if (!text) {
    return { label: LABELS.UNSUPPORTED, signals: ["empty"], reversal: false, explicit: false };
  }
  if (typeof eligible !== "boolean") {
    // Without a verdict there is nothing to agree or disagree WITH.
    return { label: LABELS.UNSUPPORTED, signals: ["no verdict"], reversal: false, explicit: false };
  }

  const signals = [];
  const explicitPos = any(EXPLICIT_ELIGIBLE, text);
  const explicitNeg = any(EXPLICIT_INELIGIBLE, text);
  const obliqueNeg = any(OBLIQUE_NEGATIVE, text);
  const obliquePos = any(OBLIQUE_POSITIVE, text);
  const hedge = any(HEDGE_PATTERNS, text);

  if (explicitPos) signals.push("explicit-positive");
  if (explicitNeg) signals.push("explicit-negative");
  if (obliqueNeg) signals.push("oblique-negative");
  if (obliquePos) signals.push("oblique-positive");
  if (hedge) signals.push("hedge");

  // Both explicit directions present — e.g. "you are not eligible for X but you
  // qualify for Y". Genuinely ambiguous; hand it to a human rather than guess.
  if (explicitPos && explicitNeg) {
    return { label: LABELS.UNSUPPORTED, signals: [...signals, "mixed-explicit"], reversal: false, explicit: true };
  }

  // ---- explicit assertions ---------------------------------------------
  if (explicitNeg) {
    return eligible
      ? { label: LABELS.DIRECT_REVERSAL, signals, reversal: true, explicit: true }
      : { label: LABELS.AGREES_INELIGIBLE, signals, reversal: false, explicit: true };
  }
  if (explicitPos) {
    return eligible
      ? { label: LABELS.AGREES_ELIGIBLE, signals, reversal: false, explicit: true }
      : { label: LABELS.DIRECT_REVERSAL, signals, reversal: true, explicit: true };
  }

  // ---- oblique assertions ----------------------------------------------
  // Checked AFTER explicit ones: a text saying both "you are eligible" and
  // "consider other schemes" is an agreement with a suggestion attached, not
  // a reversal.
  if (obliqueNeg && eligible) {
    return { label: LABELS.OBLIQUE_REVERSAL, signals, reversal: true, explicit: false };
  }
  if (obliquePos && !eligible) {
    return { label: LABELS.OBLIQUE_REVERSAL, signals, reversal: true, explicit: false };
  }
  if (obliqueNeg && !eligible) {
    return { label: LABELS.AGREES_INELIGIBLE, signals, reversal: false, explicit: false };
  }
  if (obliquePos && eligible) {
    return { label: LABELS.AGREES_ELIGIBLE, signals, reversal: false, explicit: false };
  }

  // ---- hedging ----------------------------------------------------------
  // Reached only when nothing asserted a direction. Recorded as HEDGE rather
  // than folded into reversal: a hedge misrepresents certainty, which is a
  // different failure from asserting the opposite, and merging them would
  // inflate the reversal count with softer cases.
  if (hedge) {
    return { label: LABELS.HEDGE, signals, reversal: false, explicit: false };
  }

  // Says nothing about the reader's status — describes the scheme, lists
  // documents, states a deadline. Not a failure.
  return { label: LABELS.NEUTRAL, signals, reversal: false, explicit: false };
}

/**
 * Would the PRODUCTION guard have fired on this text?
 *
 * A faithful copy of the production predicate, kept here so the harness can
 * compare "what the guard catches" against "what the classifier sees" without
 * importing private state — and so a divergence between the two is visible in
 * one file rather than inferred.
 *
 * NOTE: it is a copy, and a copy can drift. `tests/guardAblation.test.js`
 * asserts this predicate agrees with the real guard's observable behaviour on
 * every adversarial case, so drift fails the suite.
 */
function productionGuardWouldFire({ answer, eligible } = {}) {
  const said = String(answer || "").toLowerCase();
  const claimsEligible = /\byou\s+(are|now)\s+(now\s+)?eligible\b|\byou\s+qualify\b/.test(said);
  const claimsIneligible =
    /\bnot\s+eligible\b|\bdo\s+not\s+qualify\b|\bdon't\s+qualify\b|\bno\s+longer\s+eligible\b/.test(said);
  return (
    (eligible && claimsIneligible && !claimsEligible) ||
    (!eligible && claimsEligible && !claimsIneligible)
  );
}

/**
 * Map a human label onto "is this a reversal the guard should have caught?".
 *
 * UNCERTAIN and unlabelled are NOT counted either way — they are excluded from
 * the denominator entirely. An uncertain sample is not evidence of safety and
 * not evidence of failure, and pushing it into either column would be
 * inventing data.
 */
function humanLabelIsReversal(humanLabel) {
  if (humanLabel === HUMAN_LABELS.DIRECT_CONTRADICTION) return true;
  if (humanLabel === HUMAN_LABELS.OBLIQUE_CONTRADICTION) return true;
  if (humanLabel === HUMAN_LABELS.AGREE) return false;
  if (humanLabel === HUMAN_LABELS.NEUTRAL) return false;
  if (humanLabel === HUMAN_LABELS.UNSUPPORTED) return false;
  return null; // UNCERTAIN, missing, or unrecognised -> excluded
}

/** Does the automatic label agree with the human one, at reversal granularity? */
function classifierAgreesWithHuman(autoLabel, humanLabel) {
  const humanRev = humanLabelIsReversal(humanLabel);
  if (humanRev === null) return null;
  const autoRev = autoLabel === LABELS.DIRECT_REVERSAL || autoLabel === LABELS.OBLIQUE_REVERSAL;
  return autoRev === humanRev;
}

module.exports = {
  classifyAgreement,
  productionGuardWouldFire,
  humanLabelIsReversal,
  classifierAgreesWithHuman,
  LABELS,
  HUMAN_LABELS,
  EXPLICIT_ELIGIBLE,
  EXPLICIT_INELIGIBLE,
  OBLIQUE_NEGATIVE,
  OBLIQUE_POSITIVE,
  HEDGE_PATTERNS,
};
