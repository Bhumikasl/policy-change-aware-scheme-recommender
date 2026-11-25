const mongoose = require("mongoose");
const {
  NOTIFICATION_TYPES,
  NOTIFICATION_STATUS,
  NOTIFICATION_CHANNELS,
  SEVERITY_LEVELS,
} = require("../constants/notificationTypes");

/**
 * NOTIFICATION — one record per (user, scheme change, channel).
 *
 * This is both the in-app inbox and the delivery ledger. Keeping them in one
 * collection is deliberate: an in-app notification IS the record that an email
 * was owed, so splitting them would create two things to keep in step and two
 * chances to send twice.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES A NOTIFICATION EXIST
 * ---------------------------------------------------------------------------
 * A row here is created only from a RecommendationHistory row — that is, only
 * where Phase J observed the user's recommendation state actually move. The
 * Notification Agent never evaluates eligibility, never scans users, and never
 * decides who qualifies. It reads a transition that has already been decided
 * deterministically and chooses whether it is worth telling someone about.
 *
 * ---------------------------------------------------------------------------
 * THE DEDUP KEY
 * ---------------------------------------------------------------------------
 * (userId, schemeId, triggeringChangeId, channel).
 *
 * `triggeringChangeId` is the same deterministic `${schemeId}:v${version}` key
 * RecommendationHistory uses, so a replayed collection cycle, an overlapping
 * scheduler tick or a manual retry all resolve to the same row. The unique
 * index is what actually guarantees that; the pre-check in the service is only
 * an optimisation, because two concurrent runs can both pass a pre-check
 * before either inserts.
 *
 * The channel is part of the key so an email and an in-app entry for the same
 * change can coexist, while a second email for it cannot.
 */
const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Denormalised so delivery does not need a second query, and so the ledger
    // stays readable if the account is later removed.
    userEmail: { type: String, default: "" },

    schemeId: { type: String, required: true, index: true },
    schemeName: { type: String, default: "" },
    schemeVersion: { type: Number, default: null },

    // Ties this notification to the exact policy change that caused it, and to
    // the RecommendationHistory row that recorded the transition.
    triggeringChangeId: { type: String, required: true, index: true },
    recommendationHistoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RecommendationHistory",
      default: null,
    },
    processingJobId: { type: String, default: "", index: true },

    type: { type: String, enum: Object.values(NOTIFICATION_TYPES), required: true, index: true },
    severity: { type: String, enum: SEVERITY_LEVELS, default: "MEDIUM", index: true },
    channel: {
      type: String,
      enum: Object.values(NOTIFICATION_CHANNELS),
      default: NOTIFICATION_CHANNELS.IN_APP,
    },

    // What the user sees. `body` is the Phase K explanation when one was
    // generated and grounded; otherwise a deterministic fallback. It is never
    // model-generated text that failed its grounding check.
    title: { type: String, default: "" },
    body: { type: String, default: "" },
    // Whether `body` came from a grounded explanation or the fallback, so the
    // UI and any later evaluation can tell them apart.
    bodySource: { type: String, enum: ["explanation", "fallback"], default: "fallback" },

    status: {
      type: String,
      enum: Object.values(NOTIFICATION_STATUS),
      default: NOTIFICATION_STATUS.PENDING,
      index: true,
    },
    retryCount: { type: Number, default: 0 },
    // Exponential backoff. A row is eligible for retry only once this passes,
    // so a failing SMTP server is not hammered every sweep.
    nextAttemptAt: { type: Date, default: null },
    // Message only, never a stack: stacks carry file paths and sometimes
    // values from the failing call.
    lastError: { type: String, default: "" },
    // Why we stopped: "transient" (will retry), "permanent" (retrying cannot
    // fix it), or "exhausted" (ran out of attempts). Operational only —
    // never serialised to a user.
    failureKind: { type: String, default: "" },

    sentAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

/**
 * IDEMPOTENCY. The mechanism, not a hint.
 *
 * Without this, two overlapping scheduler ticks each pass their pre-check and
 * each send. With it, the second insert fails with E11000 and the service
 * counts it as a duplicate.
 */
NotificationSchema.index(
  { userId: 1, schemeId: 1, triggeringChangeId: 1, channel: 1 },
  { unique: true, name: "uniq_user_scheme_change_channel" }
);

// The inbox query: "my notifications, newest first".
NotificationSchema.index({ userId: 1, createdAt: -1 });
// The unread badge.
NotificationSchema.index({ userId: 1, readAt: 1 });
// The retry sweep: only rows that failed and are due.
NotificationSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model("Notification", NotificationSchema);
