/**
 * ELIGIBILITY UPDATE SERVICE — "Newly Eligible / Eligibility Updated" feature.
 *
 * ADDITIVE ONLY. This file adds new capability; it does NOT touch, replace,
 * or weaken any existing recommendation, RAG, semantic search, eligibility
 * matching, ranking, scheme versioning, UI, API, database, or authentication
 * code.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SERVICE DOES
 * ---------------------------------------------------------------------------
 * When a scheme's eligibility rules change from one version to another, this
 * service determines whether that change makes a user NEWLY eligible — i.e.
 * the user was NOT eligible under the OLD rules but IS eligible under the NEW
 * rules.
 *
 * The eligibility decision uses matcher.js → evaluateEligibility() — the
 * SAME hard deterministic gate the live /matches endpoint uses. This is not
 * semantic similarity, not AI confidence, not keyword matching. It is the
 * same AND-of-OR mandatory-condition engine used everywhere else.
 *
 * ---------------------------------------------------------------------------
 * CORE TRANSITION RULE
 * ---------------------------------------------------------------------------
 *   previousStatus === NOT_ELIGIBLE AND currentStatus === ELIGIBLE → NEWLY_ELIGIBLE
 *
 *   Any other combination:
 *     - NEEDS_MORE_INFORMATION is NOT treated as eligible
 *     - currentStatus NOT_ELIGIBLE → not newly eligible, not shown
 *     - Both eligible → "eligibility updated" (not "newly eligible")
 *     - Only non-eligibility-rule fields changed → not triggered
 *
 * ---------------------------------------------------------------------------
 * DEDUPLICATION
 * ---------------------------------------------------------------------------
 * A user is never re-notified about a transition they have already received
 * via the propagation pipeline. The service checks RecommendationHistory for
 * rows keyed by (userId, schemeId, triggeringChangeId) before surfacing a result.
 *
 * ---------------------------------------------------------------------------
 * INJECTABLE DEPENDENCIES
 * ---------------------------------------------------------------------------
 * All database models are injectable so every behaviour path is unit-testable
 * without a live MongoDB connection.
 */

const { evaluateEligibility } = require("./matcher");
const logger = require("../utils/logger");

// ELIGIBILITY_RULE_FIELDS is the authoritative list of rule fields the
// comparator diffs. Only changes to these trigger an eligibility re-check.
const { ELIGIBILITY_RULE_FIELDS } = require("../normalizer/normalizer");

/**
 * Number of days to look back for scheme history entries that changed
 * eligibility rules. Configurable via env so it can be narrowed in
 * production or widened for backfill runs.
 */
const LOOKBACK_DAYS =
  Number(process.env.ELIGIBILITY_UPDATE_LOOKBACK_DAYS) || 30;

// The prefix the comparator uses when recording eligibility rule diffs.
// A diff with field "eligibilityRules.minAge" came from a rule change.
const RULE_DIFF_PREFIX = "eligibilityRules.";

/**
 * Returns true if this SchemeHistory diff array contains at least one
 * eligibility-rule field change (as opposed to only description / benefit /
 * keyword / embedding changes).
 *
 * @param {Array<{field: string}>} diffs
 */
function hasEligibilityRuleChange(diffs) {
  if (!Array.isArray(diffs) || diffs.length === 0) return false;
  return diffs.some((d) => {
    const f = String(d.field || "");
    if (!f.startsWith(RULE_DIFF_PREFIX)) return false;
    const rulePart = f.slice(RULE_DIFF_PREFIX.length);
    return ELIGIBILITY_RULE_FIELDS.includes(rulePart);
  });
}

/**
 * Build a human-readable explanation from the list of changed eligibility
 * rule diffs and the user's profile. Returns an array of plain-language
 * strings — never technical field names like "eligibilityRules.minAge".
 *
 * @param {Array<{field,oldValue,newValue}>} diffs
 * @param {Object} profile — user.profile
 * @returns {string[]}
 */
function buildChangedRuleExplanations(diffs, profile) {
  const p = profile || {};
  const lines = [];

  for (const d of diffs || []) {
    const f = String(d.field || "");
    if (!f.startsWith(RULE_DIFF_PREFIX)) continue;
    const key = f.slice(RULE_DIFF_PREFIX.length);

    switch (key) {
      case "minAge": {
        const was = d.oldValue == null ? "unrestricted" : `${d.oldValue}`;
        const now = d.newValue == null ? "unrestricted" : `${d.newValue}`;
        const userAge = p.age != null ? ` (your age: ${p.age})` : "";
        if (d.oldValue == null && d.newValue != null) {
          lines.push(
            `A minimum age requirement of ${d.newValue} was added${userAge}.`
          );
        } else if (d.oldValue != null && d.newValue == null) {
          lines.push(`The minimum age restriction (was ${was}) was removed${userAge}.`);
        } else {
          lines.push(
            `The minimum age changed from ${was} to ${now}${userAge}.`
          );
        }
        break;
      }
      case "maxAge": {
        const was = d.oldValue == null ? "unrestricted" : `${d.oldValue}`;
        const now = d.newValue == null ? "unrestricted" : `${d.newValue}`;
        const userAge = p.age != null ? ` (your age: ${p.age})` : "";
        if (d.oldValue == null && d.newValue != null) {
          lines.push(
            `A maximum age requirement of ${d.newValue} was added${userAge}.`
          );
        } else if (d.oldValue != null && d.newValue == null) {
          lines.push(`The maximum age restriction (was ${was}) was removed${userAge}.`);
        } else {
          lines.push(
            `The maximum age changed from ${was} to ${now}${userAge}.`
          );
        }
        break;
      }
      case "maxAnnualIncome": {
        const fmt = (v) => (v == null ? "unrestricted" : `₹${v.toLocaleString("en-IN")}`);
        lines.push(`Income ceiling changed from ${fmt(d.oldValue)} to ${fmt(d.newValue)}.`);
        break;
      }
      case "minAnnualIncome": {
        const fmt = (v) => (v == null ? "unrestricted" : `₹${v.toLocaleString("en-IN")}`);
        lines.push(`Minimum income changed from ${fmt(d.oldValue)} to ${fmt(d.newValue)}.`);
        break;
      }
      case "genders": {
        const was = (d.oldValue || []).join("/") || "any";
        const now = (d.newValue || []).join("/") || "any";
        lines.push(`Gender requirement changed from "${was}" to "${now}".`);
        break;
      }
      case "states": {
        const was = (d.oldValue || []).join(", ") || "All India";
        const now = (d.newValue || []).join(", ") || "All India";
        lines.push(`State eligibility changed from "${was}" to "${now}".`);
        break;
      }
      case "occupations": {
        const was = (d.oldValue || []).join("/") || "any";
        const now = (d.newValue || []).join("/") || "any";
        lines.push(`Occupation requirement changed from "${was}" to "${now}".`);
        break;
      }
      case "categories":
      case "categoryGroups": {
        const was = d.oldValue == null || (Array.isArray(d.oldValue) && d.oldValue.length === 0)
          ? "no category restriction"
          : JSON.stringify(d.oldValue);
        const now = d.newValue == null || (Array.isArray(d.newValue) && d.newValue.length === 0)
          ? "no category restriction"
          : JSON.stringify(d.newValue);
        if (was !== now) {
          lines.push(`Category requirement changed from ${was} to ${now}.`);
        }
        break;
      }
      case "minEducationLevel": {
        const was = d.oldValue || "none";
        const now = d.newValue || "none";
        lines.push(
          `Minimum education level changed from "${was}" to "${now}".`
        );
        break;
      }
      case "maxEducationLevel": {
        const was = d.oldValue || "none";
        const now = d.newValue || "none";
        lines.push(
          `Maximum education level changed from "${was}" to "${now}".`
        );
        break;
      }
      case "disabilityRequired": {
        if (d.newValue === true) {
          lines.push("This scheme now requires persons with a disability.");
        } else if (d.oldValue === true && !d.newValue) {
          lines.push("The disability requirement was removed.");
        }
        break;
      }
      case "eligibilityType": {
        if (d.oldValue !== d.newValue) {
          lines.push(
            `The scheme's eligibility classification changed from "${d.oldValue || "unknown"}" to "${d.newValue || "unknown"}".`
          );
        }
        break;
      }
      default:
        // Silently skip fields we don't have a template for — never surface
        // raw field names to the user.
        break;
    }
  }

  return lines;
}

/**
 * Build a concise "why you're seeing this" sentence from the changed rules
 * and the user's profile, specifically for the newly-eligible case.
 *
 * @param {Array<{field,oldValue,newValue}>} eligibilityDiffs
 * @param {Object} profile
 * @param {string} schemeName
 * @returns {string}
 */
function buildNewlyEligibleExplanation(eligibilityDiffs, profile, schemeName) {
  const p = profile || {};
  const parts = [];

  for (const d of eligibilityDiffs || []) {
    const f = String(d.field || "");
    if (!f.startsWith(RULE_DIFF_PREFIX)) continue;
    const key = f.slice(RULE_DIFF_PREFIX.length);

    if (key === "minAge" || key === "maxAge") {
      // Build the age range context
      const minAge = key === "minAge" ? d.newValue : null;
      const maxAge = key === "maxAge" ? d.newValue : null;
      // Gather the other bound from peer diffs
      const peerMin = eligibilityDiffs.find(
        (x) => x.field === `${RULE_DIFF_PREFIX}minAge`
      );
      const peerMax = eligibilityDiffs.find(
        (x) => x.field === `${RULE_DIFF_PREFIX}maxAge`
      );
      const effectiveMin = peerMin?.newValue ?? null;
      const effectiveMax = peerMax?.newValue ?? null;
      if (p.age != null && (effectiveMin != null || effectiveMax != null)) {
        let range;
        if (effectiveMin != null && effectiveMax != null) {
          range = `${effectiveMin}–${effectiveMax}`;
        } else if (effectiveMin != null) {
          range = `${effectiveMin}+`;
        } else {
          range = `up to ${effectiveMax}`;
        }
        const sentence = `Your age (${p.age}) now falls within the updated age requirement of ${range}.`;
        if (!parts.includes(sentence)) parts.push(sentence);
      }
    } else if (key === "maxAnnualIncome" && p.annualIncome != null && d.newValue != null) {
      parts.push(
        `Your annual income (₹${p.annualIncome.toLocaleString("en-IN")}) is within the updated income ceiling of ₹${d.newValue.toLocaleString("en-IN")}.`
      );
    } else if (key === "states" && p.state) {
      const newStates = d.newValue || [];
      if (newStates.length === 0) {
        parts.push(
          `The scheme is now open to all states, including yours (${p.state}).`
        );
      } else if (
        newStates.some((s) => s.toLowerCase() === p.state.toLowerCase())
      ) {
        parts.push(
          `Your state (${p.state}) is now included in the eligible states.`
        );
      }
    } else if (key === "genders" && p.gender) {
      const newGenders = (d.newValue || []).map((g) => g.toLowerCase());
      const oldGenders = (d.oldValue || []).map((g) => g.toLowerCase());
      if (
        newGenders.includes(p.gender.toLowerCase()) &&
        !oldGenders.includes(p.gender.toLowerCase())
      ) {
        parts.push(`Your gender (${p.gender}) is now eligible.`);
      }
    }
  }

  if (parts.length > 0) return parts.join(" ");

  // Generic fallback — never exposes technical field names
  return `Your current profile now meets the updated eligibility requirements for ${schemeName}.`;
}

/**
 * Reconstruct an old scheme object from the current scheme + the previous snapshot.
 *
 * The comparator stores full normalized docs in SchemeHistory.snapshot, so we
 * use that snapshot's eligibilityRules verbatim. All other fields stay as the
 * current scheme for the purposes of the eligibility gate (status, state, etc.)
 * so we don't incorrectly block on a stale status.
 *
 * @param {Object} currentScheme — plain object (Mongoose .toObject() or lean)
 * @param {Object} oldSnapshot — SchemeHistory.snapshot from version N-1
 * @returns {Object} — scheme-shaped object with old eligibility rules
 */
function buildOldSchemeForEvaluation(currentScheme, oldSnapshot) {
  return {
    ...currentScheme,
    eligibilityRules: oldSnapshot?.eligibilityRules ?? {},
  };
}

/**
 * Build the dedup key for a given (schemeId, historyVersion).
 *
 * This matches the format used by the Phase J propagation pipeline so that
 * transitions already recorded there are recognised as already-processed.
 */
function buildTriggeringChangeId(schemeId, version) {
  return `${schemeId}:v${version}`;
}

/**
 * Get all schemes with eligibility-rule changes in the lookback window,
 * together with their previous snapshot.
 *
 * Returns an array of:
 *   { historyEntry, previousSnapshot, schemeId, triggeringChangeId }
 *
 * @param {Object} deps — injectable models
 * @returns {Promise<Array>}
 */
async function fetchEligibilityRuleUpdates(deps = {}) {
  const SchemeHistory = deps.SchemeHistoryModel ||
    require("../models/SchemeHistory");

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Fetch all UPDATED history entries in the window.
  // We cannot filter for eligibility diffs in the DB query because `diffs`
  // is an array of embedded docs — filtering the array element content in
  // MongoDB requires $elemMatch, which is not index-friendly here. Loading
  // the windowed set and filtering in JS is fast enough for typical scheme
  // volumes (a few thousand schemes, 1-2 changes/day each).
  const updatedEntries = await SchemeHistory.find({
    eventType: "UPDATED",
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!updatedEntries || updatedEntries.length === 0) return [];

  // Keep only those with at least one eligibility-rule field diff
  const withRuleChanges = updatedEntries.filter((entry) =>
    hasEligibilityRuleChange(entry.diffs)
  );

  if (withRuleChanges.length === 0) return [];

  // For each, find the previous version's snapshot so we can evaluate
  // eligibility against the OLD rules.
  const results = [];
  for (const entry of withRuleChanges) {
    // The previous snapshot is the SchemeHistory row at (schemeId, version-1).
    let previousSnapshot = null;
    if (entry.version > 1) {
      // Defensive: Mongoose queries expose .lean(); injected test mocks are
      // plain async functions that return the doc directly.
      const q = SchemeHistory.findOne({
        schemeId: entry.schemeId,
        version: entry.version - 1,
      });
      const prev = q && typeof q.lean === "function" ? await q.lean() : await q;
      previousSnapshot = prev?.snapshot ?? null;
    }
    // If version === 1, this is a CREATE with rule info, no previous snapshot.
    // In that case previousEligibility can only be evaluated against an empty
    // rules object (universal — scheme didn't exist before).

    results.push({
      historyEntry: entry,
      previousSnapshot,
      schemeId: entry.schemeId,
      triggeringChangeId: buildTriggeringChangeId(entry.schemeId, entry.version),
    });
  }

  return results;
}

/**
 * Check if this (userId, schemeId, triggeringChangeId) transition has
 * already been recorded by the Phase J propagation pipeline.
 *
 * If so, the user has already been notified through the normal pipeline and
 * we must not surface it again as a "new" discovery.
 *
 * @returns {Promise<boolean>} true if already recorded
 */
async function isAlreadyRecorded(userId, schemeId, triggeringChangeId, deps = {}) {
  const RecommendationHistory =
    deps.RecommendationHistoryModel ||
    require("../models/RecommendationHistory");
  try {
    // Defensive: same pattern as resolveUser() in recommendationPropagation.js
    const q = RecommendationHistory.findOne({
      userId,
      schemeId,
      triggeringChangeId,
    });
    const existing = q && typeof q.lean === "function" ? await q.lean() : await q;
    return !!existing;
  } catch (err) {
    // If we can't check, default to NOT skipping — better to show a duplicate
    // than to silently miss a genuine newly-eligible result.
    logger.warn("EligibilityUpdateService: dedup check failed, showing result", {
      userId: String(userId),
      schemeId,
      error: err.message,
    });
    return false;
  }
}

/**
 * THE PRIMARY FUNCTION.
 *
 * For a single user, compute which schemes recently became NEWLY ELIGIBLE
 * due to an eligibility-rule change.
 *
 * Algorithm for each scheme version update with an eligibility-rule diff:
 *   1. Retrieve the current scheme document.
 *   2. Build an "old scheme" using the previous version's snapshot rules.
 *   3. evaluateEligibility(user, oldScheme) → previousStatus
 *   4. evaluateEligibility(user, currentScheme) → currentStatus
 *   5. Apply transition rules:
 *        previousStatus === NOT_ELIGIBLE AND currentStatus === ELIGIBLE
 *        → newlyEligible = true
 *   6. Dedup against RecommendationHistory.
 *   7. Build human-friendly explanation from diff + profile.
 *
 * @param {Object}  opts
 * @param {Object}  opts.user               Full user document (needs .profile, ._id)
 * @param {number}  [opts.limit]            Max results to return (default 10)
 * @param {Object}  [opts.deps]             Injectable models for testing
 * @returns {Promise<{newlyEligible: Array, eligibilityUpdated: Array, checkedAt: Date, totalChecked: number}>}
 */
async function getNewlyEligibleForUser({ user, limit = 10, deps = {} } = {}) {
  if (!user || !user._id) {
    throw new Error("getNewlyEligibleForUser requires a user document with _id");
  }

  const SchemeModel = deps.SchemeModel || require("../models/Scheme");
  const userId = user._id;

  const started = new Date();
  const newlyEligible = [];
  const eligibilityUpdated = [];

  let updates;
  try {
    updates = await fetchEligibilityRuleUpdates(deps);
  } catch (err) {
    logger.error("EligibilityUpdateService: failed to fetch eligibility rule updates", {
      error: err.message,
    });
    return {
      newlyEligible: [],
      eligibilityUpdated: [],
      checkedAt: started,
      totalChecked: 0,
      error: "Failed to fetch eligibility updates",
    };
  }

  if (updates.length === 0) {
    return { newlyEligible: [], eligibilityUpdated: [], checkedAt: started, totalChecked: 0 };
  }

  // Load current scheme docs for all affected schemeIds in ONE batch query.
  const schemeIds = [...new Set(updates.map((u) => u.schemeId))];
  let currentSchemes;
  try {
    const docs = await SchemeModel.find({ schemeId: { $in: schemeIds } }).lean();
    currentSchemes = new Map(docs.map((s) => [s.schemeId, s]));
  } catch (err) {
    logger.error("EligibilityUpdateService: failed to load current schemes", {
      error: err.message,
    });
    return {
      newlyEligible: [],
      eligibilityUpdated: [],
      checkedAt: started,
      totalChecked: 0,
      error: "Failed to load scheme data",
    };
  }

  for (const update of updates) {
    if (newlyEligible.length + eligibilityUpdated.length >= limit * 2) break;

    const { historyEntry, previousSnapshot, schemeId, triggeringChangeId } = update;

    const currentScheme = currentSchemes.get(schemeId);
    if (!currentScheme) continue;

    // Skip closed/inactive schemes
    const statusStr = String(currentScheme.status ?? "active").toLowerCase();
    if (statusStr === "closed") continue;

    // ----------------------------------------------------------------
    // STEP 3: Evaluate eligibility against the OLD eligibility rules.
    //
    // If there is no previous snapshot (version 1 / new scheme), we treat
    // the old eligibility as a scheme with NO rules (eligible type unknown),
    // which means the user was NOT eligible before (unknown = excluded by
    // default, same as the /matches endpoint behaviour).
    // ----------------------------------------------------------------
    const oldSchemeForEval = previousSnapshot
      ? buildOldSchemeForEvaluation(currentScheme, previousSnapshot)
      : { ...currentScheme, eligibilityRules: { eligibilityType: "unknown" } };

    const previousResult = evaluateEligibility(user, oldSchemeForEval, {
      allowUnknown: false,
      strict: true,
    });

    // ----------------------------------------------------------------
    // STEP 4: Evaluate eligibility against the NEW (current) rules.
    // ----------------------------------------------------------------
    const currentResult = evaluateEligibility(user, currentScheme, {
      allowUnknown: false,
      strict: true,
    });

    const previousStatus = previousResult.status; // ELIGIBLE | NOT_ELIGIBLE | NEEDS_MORE_INFORMATION
    const currentStatus = currentResult.status;

    // ----------------------------------------------------------------
    // STEP 5: Apply transition rules.
    //
    // CRITICAL: NEEDS_MORE_INFORMATION is NOT ELIGIBLE.
    // Only status === "ELIGIBLE" counts as eligible.
    // ----------------------------------------------------------------
    const wasEligible = previousStatus === "ELIGIBLE";
    const isEligible = currentStatus === "ELIGIBLE";

    // If not currently eligible under the new rules, skip entirely.
    if (!isEligible) continue;

    // Dedup: if Phase J already recorded this transition for this user, skip.
    const alreadyDone = await isAlreadyRecorded(
      userId,
      schemeId,
      triggeringChangeId,
      deps
    );
    if (alreadyDone) continue;

    // Filter the diffs to only the eligibility-rule fields.
    const eligibilityDiffs = (historyEntry.diffs || []).filter((d) =>
      d.field && d.field.startsWith(RULE_DIFF_PREFIX) &&
      ELIGIBILITY_RULE_FIELDS.includes(d.field.slice(RULE_DIFF_PREFIX.length))
    );

    const changedRuleExplanations = buildChangedRuleExplanations(
      eligibilityDiffs,
      user.profile
    );

    const result = {
      schemeId: currentScheme.schemeId,
      schemeName: currentScheme.name,
      description: currentScheme.description || "",
      benefits: currentScheme.benefits || "",
      applicationLink: currentScheme.applicationLink || "",
      ministry: currentScheme.ministry || "",
      state: currentScheme.state || "",
      updatedAt: historyEntry.createdAt,
      schemeVersion: historyEntry.version,
      triggeringChangeId,
      previousStatus,
      currentStatus,
      matchedRules: currentResult.matched || [],
      changedRules: changedRuleExplanations,
    };

    if (!wasEligible && isEligible) {
      // NEWLY ELIGIBLE: was NOT_ELIGIBLE (or NEEDS_MORE_INFORMATION) before
      // the rule change, and is now ELIGIBLE.
      result.type = "NEWLY_ELIGIBLE";
      result.headline = "🆕 Newly eligible for you";
      result.reason = `Eligibility criteria for ${currentScheme.name} were recently updated. Based on your current profile, you now meet the updated eligibility requirements.`;
      result.explanation = buildNewlyEligibleExplanation(
        eligibilityDiffs,
        user.profile,
        currentScheme.name
      );
      newlyEligible.push(result);
    } else if (wasEligible && isEligible) {
      // ELIGIBILITY UPDATED: user was eligible before, still eligible after.
      // The rules changed but didn't change the user's eligibility status.
      // Show as "Eligibility updated" — not "Newly eligible".
      result.type = "ELIGIBILITY_UPDATED";
      result.headline = "📋 Eligibility updated";
      result.reason = `Eligibility criteria for ${currentScheme.name} were recently updated. You remain eligible under the updated requirements.`;
      result.explanation = changedRuleExplanations.join(" ") ||
        `The eligibility rules for ${currentScheme.name} were updated, and you remain eligible.`;
      eligibilityUpdated.push(result);
    }
    // wasEligible && !isEligible is already excluded above (we continue if !isEligible)
    // !wasEligible && !isEligible is already excluded above
  }

  // Sort newest first within each bucket.
  const byDate = (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt);
  newlyEligible.sort(byDate);
  eligibilityUpdated.sort(byDate);

  return {
    newlyEligible: newlyEligible.slice(0, limit),
    eligibilityUpdated: eligibilityUpdated.slice(0, limit),
    checkedAt: started,
    totalChecked: updates.length,
  };
}

module.exports = {
  getNewlyEligibleForUser,
  // Exported for unit testing
  hasEligibilityRuleChange,
  buildChangedRuleExplanations,
  buildNewlyEligibleExplanation,
  buildOldSchemeForEvaluation,
  buildTriggeringChangeId,
  fetchEligibilityRuleUpdates,
  isAlreadyRecorded,
  LOOKBACK_DAYS,
};
