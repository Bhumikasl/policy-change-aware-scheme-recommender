const Scheme = require("../models/Scheme");
const SchemeHistory = require("../models/SchemeHistory");
const { COMPARABLE_FIELDS, ELIGIBILITY_RULE_FIELDS } = require("../normalizer/normalizer");
const logger = require("../utils/logger");

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  // Sort by JSON so nested arrays (categoryGroups) compare correctly.
  const sa = [...a].map((v) => JSON.stringify(v)).sort();
  const sb = [...b].map((v) => JSON.stringify(v)).sort();
  return sa.every((v, i) => v === sb[i]);
}

function valuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return arraysEqual(a, b);
  return a === b;
}

/**
 * Field-by-field diff between the stored doc and the freshly normalized doc.
 * Returns [] if nothing comparable changed.
 */
/**
 * Diff eligibilityRules field by field. Emits one diff per changed rule
 * (e.g. "eligibilityRules.maxAnnualIncome") so downstream reasoning can
 * see WHICH rule shifted, not just "eligibility changed".
 */
function diffEligibilityRules(oldRules = {}, newRules = {}) {
  const diffs = [];
  for (const f of ELIGIBILITY_RULE_FIELDS) {
    const oldV = oldRules?.[f];
    const newV = newRules?.[f];
    if (!valuesEqual(oldV, newV)) {
      diffs.push({ field: `eligibilityRules.${f}`, oldValue: oldV, newValue: newV });
    }
  }
  return diffs;
}

function diffFields(oldDoc, newDoc) {
  const diffs = [];
  for (const field of COMPARABLE_FIELDS) {
    if (field === "eligibilityRules") {
      diffs.push(...diffEligibilityRules(oldDoc.eligibilityRules, newDoc.eligibilityRules));
      continue;
    }
    const oldValue = oldDoc[field];
    const newValue = newDoc[field];
    if (!valuesEqual(oldValue, newValue)) {
      diffs.push({ field, oldValue, newValue });
    }
  }
  return diffs;
}

/**
 * Takes ONE normalized scheme (output of normalizer.normalize) and reconciles it
 * against MongoDB. Returns a change event descriptor so the caller (scheduler)
 * can decide whether to trigger AI summary + notifications.
 *
 * @returns {Promise<{type: 'NEW'|'UPDATED'|'NO_CHANGE', schemeId: string, diffs?: Array, snapshot?: Object}>}
 */
async function reconcile(normalized) {
  const existing = await Scheme.findOne({ schemeId: normalized.schemeId });

  // ---------- New scheme ----------
  if (!existing) {
    const created = await Scheme.create({
      ...normalized,
      version: 1,
      firstSeenAt: new Date(),
      lastCheckedAt: new Date(),
      lastUpdatedAt: new Date(),
    });

    await SchemeHistory.create({
      schemeId: created.schemeId,
      version: 1,
      eventType: "CREATED",
      snapshot: normalized,
      diffs: [],
    });

    logger.info("New scheme detected", { schemeId: created.schemeId, name: created.name });
    return { type: "NEW", schemeId: created.schemeId, version: 1, snapshot: normalized };
  }

  // ---------- Same content hash -> nothing changed, just bump lastCheckedAt ----------
  if (existing.contentHash === normalized.contentHash) {
    existing.lastCheckedAt = new Date();
    await existing.save();
    return { type: "NO_CHANGE", schemeId: existing.schemeId };
  }

  // ---------- Hash differs -> find exactly what changed ----------
  const diffs = diffFields(existing.toObject(), normalized);

  if (diffs.length === 0) {
    // Hash changed but no comparable field actually differs (e.g. whitespace-only
    // noise that clean() didn't fully normalize). Treat as no-op, but still store
    // the new hash so we don't keep re-flagging it every cycle.
    existing.contentHash = normalized.contentHash;
    existing.lastCheckedAt = new Date();
    await existing.save();
    return { type: "NO_CHANGE", schemeId: existing.schemeId };
  }

  const newVersion = existing.version + 1;

  Object.assign(existing, normalized);
  existing.version = newVersion;
  existing.lastCheckedAt = new Date();
  existing.lastUpdatedAt = new Date();
  await existing.save();

  await SchemeHistory.create({
    schemeId: existing.schemeId,
    version: newVersion,
    eventType: "UPDATED",
    snapshot: normalized,
    diffs,
  });

  logger.info("Scheme updated", { schemeId: existing.schemeId, changedFields: diffs.map((d) => d.field) });
  return { type: "UPDATED", schemeId: existing.schemeId, version: newVersion, diffs, snapshot: normalized };
}

module.exports = { reconcile, diffFields };
