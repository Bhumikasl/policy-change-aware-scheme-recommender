const mongoose = require("mongoose");

/**
 * One row per (user, scheme, version) actually notified about.
 * The notifier checks this collection before sending — so if a scheme
 * gets picked up as "updated" twice for the same version (e.g. a rerun of
 * a collection cycle after a crash), the same user never gets a duplicate
 * email for the same change.
 *
 * The compound unique index does the actual dedup work; the notifier just
 * tries to insert and treats an E11000 duplicate-key error as "already
 * notified, skip".
 */
const NotificationLogSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    schemeId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    eventType: { type: String, enum: ["NEW", "UPDATED"], required: true },
    channel: { type: String, default: "email" },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

NotificationLogSchema.index(
  { email: 1, schemeId: 1, version: 1, channel: 1 },
  { unique: true }
);

module.exports = mongoose.model("NotificationLog", NotificationLogSchema);
