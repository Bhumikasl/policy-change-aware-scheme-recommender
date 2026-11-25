/**
 * Notification vocabulary, shared by the agent, the service, the model and the
 * read API.
 *
 * Kept out of the model for the reason the transition enums were: substituting
 * the model layer in a test would otherwise silently make these undefined, and
 * the failure surfaces far from its cause.
 */

/**
 * The user-facing kinds of change worth telling someone about.
 *
 * Each maps from a transition Phase J already computed. The Notification Agent
 * does not derive these from eligibility rules — it reads a decision that has
 * already been made deterministically.
 */
const NOTIFICATION_TYPES = Object.freeze({
  NEWLY_ELIGIBLE: "NEWLY_ELIGIBLE",
  NO_LONGER_ELIGIBLE: "NO_LONGER_ELIGIBLE",
  RECOMMENDATION_ENTERED_TOP_K: "RECOMMENDATION_ENTERED_TOP_K",
  RECOMMENDATION_LEFT_TOP_K: "RECOMMENDATION_LEFT_TOP_K",
  RANK_INCREASED: "RANK_INCREASED",
  RANK_DECREASED: "RANK_DECREASED",
  DEADLINE_CHANGED: "DEADLINE_CHANGED",
  BENEFIT_CHANGED: "BENEFIT_CHANGED",
  DOCUMENTS_CHANGED: "DOCUMENTS_CHANGED",
});

/**
 * DELIVERY lifecycle. Delivery only.
 *
 * READ is deliberately NOT in this enum. Whether a person has opened a
 * notification and whether the system managed to deliver it are two unrelated
 * facts: a SENT email can go unread forever, and an in-app row can be read
 * while its email is still retrying. Folding them into one field would force a
 * choice between "delivered" and "read" that loses information, and would make
 * "unread count" and "delivery health" queries fight over the same column.
 * Read state lives in `readAt`, and the two are queried independently.
 *
 * Likewise this says nothing about policy processing. A notification that
 * failed to send sits beside a policy analysis that succeeded.
 *
 *   PENDING            row exists, delivery not yet attempted. In queued mode
 *                      this is the queue itself.
 *   SENDING            claimed by a worker. Exists so a second worker cannot
 *                      pick up the same row mid-flight.
 *   SENT               delivered.
 *   FAILED_RETRYABLE   a transient failure; nextAttemptAt says when to try
 *                      again.
 *   FAILED_PERMANENTLY retries exhausted, or the failure is not the kind
 *                      retrying can fix. Never picked up again.
 *   SUPPRESSED         deliberately not sent — below the user's threshold, or
 *                      they opted out. Nothing went wrong, and it must never
 *                      be retried.
 */
const NOTIFICATION_STATUS = Object.freeze({
  PENDING: "PENDING",
  SENDING: "SENDING",
  SENT: "SENT",
  FAILED_RETRYABLE: "FAILED_RETRYABLE",
  FAILED_PERMANENTLY: "FAILED_PERMANENTLY",
  SUPPRESSED: "SUPPRESSED",
});

/** Statuses a worker may claim. Nothing else is ever re-attempted. */
const CLAIMABLE_STATUSES = [
  NOTIFICATION_STATUS.PENDING,
  NOTIFICATION_STATUS.FAILED_RETRYABLE,
];

/**
 * Failures retrying cannot fix.
 *
 * A malformed address will fail identically on every attempt, so retrying it
 * four times just delays the inevitable and keeps a dead row in the sweep.
 * Matched conservatively: anything unrecognised is treated as transient,
 * because wrongly giving up loses a notification while wrongly retrying only
 * costs an attempt.
 */
const PERMANENT_FAILURE_PATTERNS = [
  /invalid\s+(recipient|address|email)/i,
  /no\s+such\s+user/i,
  /mailbox\s+(unavailable|not\s+found)/i,
  /recipient\s+rejected/i,
  /55[0-9]\s/, // 5xx SMTP permanent rejections
];

function isPermanentFailure(message) {
  const text = String(message || "");
  return PERMANENT_FAILURE_PATTERNS.some((re) => re.test(text));
}

const NOTIFICATION_CHANNELS = Object.freeze({
  IN_APP: "in_app",
  EMAIL: "email",
});

const SEVERITY_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/**
 * How urgent each kind is.
 *
 * The ordering carries a judgement worth stating: LOSING something you had
 * outranks gaining something you did not, because a person who has budgeted
 * around a benefit needs to know it is gone more than a person needs to hear
 * about a new opportunity.
 *
 * Rank movements are LOW on purpose. A scheme sliding from position 4 to 5 is
 * true, and telling someone about it by email is noise. The default user
 * threshold is MEDIUM, so those stay in the in-app list and out of the inbox
 * unless the user asks for everything.
 */
const TYPE_SEVERITY = Object.freeze({
  [NOTIFICATION_TYPES.NO_LONGER_ELIGIBLE]: "CRITICAL",
  [NOTIFICATION_TYPES.NEWLY_ELIGIBLE]: "HIGH",
  [NOTIFICATION_TYPES.DEADLINE_CHANGED]: "HIGH",
  [NOTIFICATION_TYPES.RECOMMENDATION_LEFT_TOP_K]: "MEDIUM",
  [NOTIFICATION_TYPES.RECOMMENDATION_ENTERED_TOP_K]: "MEDIUM",
  [NOTIFICATION_TYPES.DOCUMENTS_CHANGED]: "MEDIUM",
  [NOTIFICATION_TYPES.BENEFIT_CHANGED]: "MEDIUM",
  [NOTIFICATION_TYPES.RANK_INCREASED]: "LOW",
  [NOTIFICATION_TYPES.RANK_DECREASED]: "LOW",
});

/** Is `severity` at least `threshold`? */
function meetsSeverity(severity, threshold) {
  const s = SEVERITY_LEVELS.indexOf(severity);
  const t = SEVERITY_LEVELS.indexOf(threshold);
  if (s === -1) return false;
  if (t === -1) return true; // an unrecognised threshold must not silence everything
  return s >= t;
}

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_STATUS,
  CLAIMABLE_STATUSES,
  isPermanentFailure,
  NOTIFICATION_CHANNELS,
  SEVERITY_LEVELS,
  TYPE_SEVERITY,
  meetsSeverity,
};
