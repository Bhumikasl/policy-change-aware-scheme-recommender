const mongoose = require("mongoose");

/**
 * RECOMMENDATION HISTORY — the audit trail.
 *
 * Append-only. One document per (user, scheme, triggering change) where the
 * user's recommendation state actually moved.
 *
 * This collection is what makes the research claim checkable. Without it the
 * system can say "you are eligible for X"; with it the system can say "you
 * became eligible for X on 12 March because version 4 of the scheme raised the
 * income ceiling from ₹2.5 lakh to ₹3 lakh", and a reviewer can verify that
 * against SchemeHistory version 3 and version 4. Every row points back at the
 * exact scheme versions and the exact change event that produced it.
 *
 * Two rules govern writes:
 *
 *   1. NOTHING IS RECORDED THAT DID NOT MOVE. A row means a real transition.
 *      Re-running the same change must not append duplicate rows, which is what
 *      the unique index below enforces.
 *
 *   2. EVERY FIELD IS OBSERVED, NOT INFERRED. previousRank comes from ranking
 *      the user against the scheme universe as it was; newRank from ranking
 *      against the universe as it is. Neither is a guess.
 */

// One vocabulary, defined once in src/constants and imported by both this
// model and the propagation service. See that file for the rank-direction
// semantics, which are the easiest thing here to get backwards.
const {
  ELIGIBILITY_TRANSITIONS,
  RECOMMENDATION_TRANSITIONS,
  RECOMMENDATION_STATUS,
} = require("../constants/recommendationTransitions");

const RecommendationHistorySchema = new mongoose.Schema(
  {
    // ---- who and what ----
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Denormalised so the audit trail stays readable if a user is deleted.
    userEmail: { type: String, default: "" },
    schemeId: { type: String, required: true, index: true },
    schemeName: { type: String, default: "" },

    // ---- what caused this ----
    // The SchemeHistory document id (or a deterministic synthetic id). This is
    // the idempotency key: reprocessing the same change must not append again.
    triggeringChangeId: { type: String, required: true, index: true },
    // Correlates every row produced by one propagation run.
    processingJobId: { type: String, default: "", index: true },
    // The event that carried this change through the pipeline (Phase M).
    eventId: { type: String, default: "" },

    previousSchemeVersion: { type: Number, default: null },
    newSchemeVersion: { type: Number, default: null },

    // ---- eligibility ----
    previousEligibility: { type: Boolean, required: true },
    newEligibility: { type: Boolean, required: true },
    eligibilityTransition: {
      type: String,
      enum: Object.values(ELIGIBILITY_TRANSITIONS),
      required: true,
      index: true,
    },

    // ---- recommendation ----
    previousRecommendationStatus: {
      type: String,
      enum: Object.values(RECOMMENDATION_STATUS),
      required: true,
    },
    newRecommendationStatus: {
      type: String,
      enum: Object.values(RECOMMENDATION_STATUS),
      required: true,
    },
    recommendationTransition: {
      type: String,
      enum: Object.values(RECOMMENDATION_TRANSITIONS),
      required: true,
      index: true,
    },
    // 1-based position among the user's eligible schemes. null when the user
    // was not eligible, so there was no position to hold.
    previousRank: { type: Number, default: null },
    newRank: { type: Number, default: null },
    previousRelevance: { type: Number, default: null },
    newRelevance: { type: Number, default: null },
    // The K in force when this row was written, so a later change to the
    // cutoff cannot silently reinterpret history.
    topK: { type: Number, default: null },

    // ---- why ----
    // A structured, machine-checkable statement of the cause. Prose for humans
    // is the Explanation Agent's job (Phase K); this is the grounding it reads.
    reason: {
      code: { type: String, default: "" },
      summary: { type: String, default: "" },
      changedFields: {
        type: [{ field: String, oldValue: mongoose.Schema.Types.Mixed, newValue: mongoose.Schema.Types.Mixed }],
        default: [],
      },
      rulesNowPassing: { type: [String], default: [] },
      rulesNowFailing: { type: [String], default: [] },
    },
    affectedAttributes: { type: [String], default: [] },
    changeType: { type: String, default: "" },
    severity: { type: String, default: "" },

    // Filled in by the Explanation Agent once it runs; null until then rather
    // than a placeholder sentence, so an ungenerated explanation is visibly
    // absent instead of quietly fabricated.
    explanationRef: { type: mongoose.Schema.Types.ObjectId, ref: "Explanation", default: null },
    explanation: { type: String, default: "" },
    // What the sentence rests on: which template or model produced it, and
    // the exact stored values it was allowed to cite. This is what makes an
    // explanation auditable after the fact rather than merely readable.
    explanationMeta: { type: mongoose.Schema.Types.Mixed, default: null },

    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

/**
 * IDEMPOTENCY.
 *
 * One row per user per scheme per triggering change. If a collection cycle is
 * retried, or the same SchemeHistory document is reprocessed after a crash,
 * the second insert violates this index and is skipped rather than doubling
 * the user's history (and, later, their notifications).
 */
RecommendationHistorySchema.index(
  { userId: 1, schemeId: 1, triggeringChangeId: 1 },
  { unique: true, name: "uniq_user_scheme_change" }
);

// The dashboard query: "what changed for me lately", newest first.
RecommendationHistorySchema.index({ userId: 1, createdAt: -1 });
// The admin query: "everything one propagation run produced".
RecommendationHistorySchema.index({ processingJobId: 1, createdAt: -1 });

module.exports = mongoose.model("RecommendationHistory", RecommendationHistorySchema);
module.exports.ELIGIBILITY_TRANSITIONS = ELIGIBILITY_TRANSITIONS;
module.exports.RECOMMENDATION_TRANSITIONS = RECOMMENDATION_TRANSITIONS;
module.exports.RECOMMENDATION_STATUS = RECOMMENDATION_STATUS;
