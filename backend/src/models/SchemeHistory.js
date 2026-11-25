const mongoose = require("mongoose");

/**
 * Append-only. One document per detected change (or per initial creation).
 * This is what powers the "timeline" / "what changed on July 21" feature.
 */
const SchemeHistorySchema = new mongoose.Schema(
  {
    schemeId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    eventType: { type: String, enum: ["CREATED", "UPDATED"], required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true }, // full normalized doc at this version
    diffs: {
      // array of { field, oldValue, newValue }
      type: [
        {
          field: String,
          oldValue: mongoose.Schema.Types.Mixed,
          newValue: mongoose.Schema.Types.Mixed,
        },
      ],
      default: [],
    },
    aiSummary: { type: String, default: "" }, // plain-language explanation, filled in by aiSummary service

    // ---- policy-analysis stage outcomes (Phase J integration) ----
    //
    // Collection and policy analysis fail for unrelated reasons, so they get
    // separate statuses. A scheme that was fetched and persisted was collected
    // SUCCESSFULLY even if the impact agent then fell over; conflating the two
    // would make one flaky agent look like a broken government feed, and would
    // push someone toward re-fetching a source that was never the problem.
    //
    // These live on the history row rather than in a new collection because
    // this row already exists once per change, is keyed by the same
    // (schemeId, version), and holds the snapshot a retry reads. That makes
    // "what needs retrying" one indexed query instead of a log grep.
    policyImpactStatus: {
      type: String,
      enum: ["PENDING", "SUCCEEDED", "FAILED", "SKIPPED"],
      default: "PENDING",
      index: true,
    },
    propagationStatus: {
      type: String,
      enum: ["PENDING", "SUCCEEDED", "FAILED", "SKIPPED"],
      default: "PENDING",
      index: true,
    },
    // Set when a stage failed in a way a re-run could fix without recollecting.
    policyRetryable: { type: Boolean, default: false, index: true },
    // Counters and decisions, for the admin dashboard and for auditing which
    // candidate-selection mode ran. Ids and numbers only — no emails, no
    // profile values.
    policyProcessing: { type: mongoose.Schema.Types.Mixed, default: null },

    // ---- Phase M: RAG indexing, tracked separately from the policy stages ---
    //
    // A stale knowledge base and a wrong eligibility decision are different
    // failures with different remedies, and merging them would be wrong in
    // both directions: an embedding outage would send the policy retry sweep
    // re-running propagation that already succeeded, and a genuinely failed
    // propagation would look survivable because the index happened to refresh.
    //
    // Declared explicitly because Mongoose runs in strict mode by default —
    // an undeclared field in a $set is silently DROPPED, so the status would
    // appear to be written, the log line would show it, and the row would not
    // have it. Nothing would error.
    ragIndexStatus: {
      type: String,
      enum: ["PENDING", "SUCCEEDED", "FAILED", "SKIPPED"],
      default: "PENDING",
      index: true,
    },
    // The RAG sweep's own flag. Deliberately NOT policyRetryable.
    ragIndexRetryable: { type: Boolean, default: false, index: true },
    ragIndexing: { type: mongoose.Schema.Types.Mixed, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// Reading one version's "before" during a retry, and the comparator's own
// (schemeId, version) lookups.
SchemeHistorySchema.index({ schemeId: 1, version: 1 });
// The retry sweep: "which changes still need their policy stages re-run".
SchemeHistorySchema.index({ policyRetryable: 1, createdAt: 1 });
// The RAG sweep: "which scheme versions have a stale knowledge base". A second
// index rather than a shared one, because the two sweeps must be able to run
// and recover independently.
SchemeHistorySchema.index({ ragIndexRetryable: 1, createdAt: 1 });

module.exports = mongoose.model("SchemeHistory", SchemeHistorySchema);
