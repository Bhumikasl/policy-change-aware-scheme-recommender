const {
  NOTIFICATION_TYPES,
  TYPE_SEVERITY,
  meetsSeverity,
} = require("../constants/notificationTypes");
const {
  ELIGIBILITY_TRANSITIONS,
  RECOMMENDATION_TRANSITIONS,
} = require("../constants/recommendationTransitions");

/**
 * AGENT 4 — NOTIFICATION AGENT
 *
 * Question it answers: *is this worth interrupting someone for?*
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS AGENT IS NOT ALLOWED TO DO
 * ---------------------------------------------------------------------------
 * It does not decide eligibility. It does not query users. It does not read
 * scheme rules. Its entire input is a RecommendationHistory row — a transition
 * the matcher already computed and Phase J already recorded — and its entire
 * output is a verdict about whether to tell the person.
 *
 * That separation is structural, not a convention: this module imports no
 * model, no matcher and no database, so there is no way for it to reach an
 * eligibility decision even by accident. If it ever needs one, the import
 * would have to be added deliberately, and that is the moment to object.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE DECISION AT ALL
 * ---------------------------------------------------------------------------
 * Phase J already filters non-events: a row exists only where something moved.
 * But "something moved" and "worth an email" are different thresholds. A
 * scheme sliding from position 4 to position 5 in a list is a real
 * recommendation change and a genuinely bad reason to email someone.
 *
 * The old notifier had no such distinction — it emailed everyone who matched a
 * scheme whenever any version of it appeared, including a ministry rename. The
 * point of this agent is to be the place where that judgement lives, and to be
 * auditable about it.
 */

/**
 * Map a recorded transition to a notification type.
 *
 * Order matters. Eligibility changes outrank recommendation movements: a user
 * who lost eligibility AND dropped out of the top K needs to hear the first
 * fact, not the second.
 *
 * @param {Object} record a RecommendationHistory document
 * @returns {string|null} a NOTIFICATION_TYPES value, or null if none applies
 */
function classifyNotification(record) {
  const eligibility = record?.eligibilityTransition;
  const recommendation = record?.recommendationTransition;
  const reasonCode = record?.reason?.code;

  if (eligibility === ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE) {
    return NOTIFICATION_TYPES.NEWLY_ELIGIBLE;
  }
  if (eligibility === ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_INELIGIBLE) {
    return NOTIFICATION_TYPES.NO_LONGER_ELIGIBLE;
  }

  // Still eligible. Did what they SEE change?
  if (recommendation === RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED) {
    return NOTIFICATION_TYPES.RECOMMENDATION_ENTERED_TOP_K;
  }
  if (recommendation === RECOMMENDATION_TRANSITIONS.RECOMMENDED_TO_NOT_RECOMMENDED) {
    return NOTIFICATION_TYPES.RECOMMENDATION_LEFT_TOP_K;
  }
  // Rank 1 is the best position, so RANK_INCREASED means the scheme moved UP.
  if (recommendation === RECOMMENDATION_TRANSITIONS.RANK_INCREASED) {
    return NOTIFICATION_TYPES.RANK_INCREASED;
  }
  if (recommendation === RECOMMENDATION_TRANSITIONS.RANK_DECREASED) {
    return NOTIFICATION_TYPES.RANK_DECREASED;
  }

  // Eligibility and position both unchanged, but a term of a scheme they hold
  // moved. This is the case Phase J records for deadline/benefit/document
  // changes affecting an eligible user.
  if (reasonCode === "DEADLINE_CHANGED") return NOTIFICATION_TYPES.DEADLINE_CHANGED;
  if (reasonCode === "BENEFIT_CHANGED") return NOTIFICATION_TYPES.BENEFIT_CHANGED;
  if (reasonCode === "DOCUMENTS_CHANGED") return NOTIFICATION_TYPES.DOCUMENTS_CHANGED;

  return null;
}

/** Deterministic titles. Short, and true regardless of what the LLM did. */
const TITLE = Object.freeze({
  [NOTIFICATION_TYPES.NEWLY_ELIGIBLE]: (s) => `You are now eligible for ${s}`,
  [NOTIFICATION_TYPES.NO_LONGER_ELIGIBLE]: (s) => `You are no longer eligible for ${s}`,
  [NOTIFICATION_TYPES.RECOMMENDATION_ENTERED_TOP_K]: (s) => `${s} was added to your recommendations`,
  [NOTIFICATION_TYPES.RECOMMENDATION_LEFT_TOP_K]: (s) => `${s} left your top recommendations`,
  [NOTIFICATION_TYPES.RANK_INCREASED]: (s) => `${s} moved up your recommendations`,
  [NOTIFICATION_TYPES.RANK_DECREASED]: (s) => `${s} moved down your recommendations`,
  [NOTIFICATION_TYPES.DEADLINE_CHANGED]: (s) => `The application deadline for ${s} changed`,
  [NOTIFICATION_TYPES.BENEFIT_CHANGED]: (s) => `The benefits of ${s} changed`,
  [NOTIFICATION_TYPES.DOCUMENTS_CHANGED]: (s) => `${s} now requires different documents`,
});

/**
 * The body, when no grounded explanation exists.
 *
 * Deliberately thin. It states the transition and nothing more, because
 * anything richer would be the Explanation Agent's job and inventing it here
 * would be exactly the ungrounded prose Phase K exists to prevent.
 */
function fallbackBody(record, type) {
  const scheme = record?.schemeName || record?.schemeId || "this scheme";
  switch (type) {
    case NOTIFICATION_TYPES.NEWLY_ELIGIBLE:
      return `A change to ${scheme} means you now meet its eligibility conditions.`;
    case NOTIFICATION_TYPES.NO_LONGER_ELIGIBLE:
      return `A change to ${scheme} means you no longer meet its eligibility conditions.`;
    case NOTIFICATION_TYPES.RECOMMENDATION_ENTERED_TOP_K:
      return `${scheme} is now among your top recommendations.`;
    case NOTIFICATION_TYPES.RECOMMENDATION_LEFT_TOP_K:
      return `${scheme} is no longer among your top recommendations. You may still be eligible for it.`;
    case NOTIFICATION_TYPES.RANK_INCREASED:
    case NOTIFICATION_TYPES.RANK_DECREASED:
      return `${scheme} changed position in your recommendations.`;
    case NOTIFICATION_TYPES.DEADLINE_CHANGED:
      return `The application deadline for ${scheme} has changed. Your eligibility is unchanged.`;
    case NOTIFICATION_TYPES.BENEFIT_CHANGED:
      return `What ${scheme} provides has changed. Your eligibility is unchanged.`;
    case NOTIFICATION_TYPES.DOCUMENTS_CHANGED:
      return `The documents required for ${scheme} have changed. Your eligibility is unchanged.`;
    default:
      return `${scheme} was updated in a way that affects you.`;
  }
}

/**
 * Decide whether — and how — to notify one user about one recorded transition.
 *
 * Pure. No IO, no clock, no randomness: the same record and the same
 * preferences always give the same verdict, which is what makes the decision
 * auditable and the tests meaningful.
 *
 * @param {Object} opts
 * @param {Object} opts.record            a RecommendationHistory document
 * @param {Object} [opts.notificationPrefs] the user's preferences
 * @returns {{
 *   shouldNotify: boolean, type: string|null, severity: string|null,
 *   emailEligible: boolean, title: string, body: string,
 *   bodySource: "explanation"|"fallback", suppressionReason: string|null
 * }}
 */
function decideNotification({ record, notificationPrefs = {} } = {}) {
  const type = classifyNotification(record);

  const none = {
    shouldNotify: false,
    type: null,
    severity: null,
    inAppEligible: false,
    emailEligible: false,
    title: "",
    body: "",
    bodySource: "fallback",
    suppressionReason: null,
  };

  if (!type) {
    return { ...none, suppressionReason: "no user-facing transition in this record" };
  }

  const severity = TYPE_SEVERITY[type] || "MEDIUM";
  const schemeName = record?.schemeName || record?.schemeId || "this scheme";

  // The Phase K explanation when it exists. `explanation` is only populated
  // when that agent's grounding check passed, so an ungrounded sentence never
  // reaches an inbox — the fallback is used instead.
  const explanation = typeof record?.explanation === "string" ? record.explanation.trim() : "";
  const usingExplanation = explanation.length > 0;

  // ---- email gating -----------------------------------------------------
  // Every qualifying transition produces an IN-APP record. Email is the
  // narrower channel, because it interrupts.
  const unsubscribed = !!notificationPrefs.unsubscribedAt;
  const emailOptOut = notificationPrefs.email === false;
  // Separate switch. Turning off email must NOT silence the in-app inbox —
  // they are different levels of interruption, and someone who stops the mail
  // usually still wants the record.
  const inAppEnabled = notificationPrefs.inApp !== false;
  const threshold = notificationPrefs.minSeverity || "MEDIUM";
  const passesThreshold = meetsSeverity(severity, threshold);

  let suppressionReason = null;
  if (unsubscribed) suppressionReason = "user unsubscribed";
  else if (emailOptOut) suppressionReason = "email disabled in preferences";
  else if (!passesThreshold) {
    suppressionReason = `severity ${severity} is below the user's threshold of ${threshold}`;
  }

  return {
    // Still a notifiable event even if both channels are off — the caller may
    // record it without delivering. Channel gating is expressed by the two
    // *Eligible flags, not by pretending nothing happened.
    shouldNotify: true,
    type,
    severity,
    inAppEligible: inAppEnabled && !unsubscribed,
    emailEligible: suppressionReason === null,
    title: (TITLE[type] || ((s) => `${s} was updated`))(schemeName),
    body: usingExplanation ? explanation : fallbackBody(record, type),
    bodySource: usingExplanation ? "explanation" : "fallback",
    suppressionReason,
  };
}

module.exports = {
  decideNotification,
  classifyNotification,
  fallbackBody,
  TITLE,
};
