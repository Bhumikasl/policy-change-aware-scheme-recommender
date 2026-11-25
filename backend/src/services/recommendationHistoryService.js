const RecommendationHistoryModel = require("../models/RecommendationHistory");
const {
  ELIGIBILITY_TRANSITIONS,
  RECOMMENDATION_TRANSITIONS,
} = require("../constants/recommendationTransitions");

/**
 * RECOMMENDATION HISTORY — read side.
 *
 * Phase J writes the audit trail; nothing could read it. This is the query
 * layer that makes it visible, kept out of the route file so it can be tested
 * without express or supertest.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT RETURN
 * ---------------------------------------------------------------------------
 * A history row carries more than the user needs: internal job ids, the raw
 * matcher rule lists, relevance floats, the denormalised email. Serialising the
 * whole document would leak operational detail into a public API and make every
 * future internal field a breaking change.
 *
 * So the serialiser is an ALLOW-LIST. A new internal field added to the model
 * stays internal until someone deliberately adds it here.
 *
 * The caller's own id is always injected by the route from the verified JWT —
 * it is never read from a query parameter, so there is no way to ask for
 * someone else's history.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * Turn untrusted query parameters into a safe Mongo filter.
 *
 * Every value is either coerced to a number or checked against a fixed enum.
 * Nothing from `query` reaches Mongo as an object, so an attacker cannot send
 * `?eligibilityTransition[$ne]=x` and turn a value into an operator — the
 * classic NoSQL-injection shape for Express query strings.
 *
 * @param {string} userId  from the verified token, never from the query
 * @param {Object} query   req.query
 */
function buildHistoryQuery(userId, query = {}) {
  const filter = { userId };

  const eligibility = String(query.eligibilityTransition || "");
  if (eligibility && Object.values(ELIGIBILITY_TRANSITIONS).includes(eligibility)) {
    filter.eligibilityTransition = eligibility;
  }

  const recommendation = String(query.recommendationTransition || "");
  if (recommendation && Object.values(RECOMMENDATION_TRANSITIONS).includes(recommendation)) {
    filter.recommendationTransition = recommendation;
  }

  // schemeId is free text, so it is forced to a string. An object arriving here
  // would otherwise be spread into the query as operators.
  if (query.schemeId) filter.schemeId = String(query.schemeId);

  // `since` is the only date input; an unparseable value is ignored rather
  // than producing `{ $gte: Invalid Date }`, which matches nothing silently.
  if (query.since) {
    const ts = Date.parse(String(query.since));
    if (!Number.isNaN(ts)) filter.createdAt = { $gte: new Date(ts) };
  }

  return filter;
}

/** Clamp pagination so a caller cannot ask for the whole collection. */
function buildPagination(query = {}) {
  const rawPage = parseInt(String(query.page ?? "1"), 10);
  const rawLimit = parseInt(String(query.limit ?? DEFAULT_LIMIT), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * The public shape of one history row. Allow-list, not a redaction pass:
 * anything not named here never leaves the server.
 */
function serializeHistoryRow(row) {
  return {
    id: String(row._id ?? ""),
    scheme: {
      schemeId: row.schemeId,
      name: row.schemeName || "",
    },
    // Which scheme versions bracket this change — enough for the UI to link to
    // the scheme timeline, without exposing the stored snapshots.
    versions: {
      previous: row.previousSchemeVersion ?? null,
      current: row.newSchemeVersion ?? null,
    },
    changeId: row.triggeringChangeId,
    changeType: row.changeType || "",
    severity: row.severity || "",
    affectedAttributes: row.affectedAttributes || [],

    eligibility: {
      previous: row.previousEligibility,
      current: row.newEligibility,
      transition: row.eligibilityTransition,
    },
    recommendation: {
      previousStatus: row.previousRecommendationStatus,
      currentStatus: row.newRecommendationStatus,
      transition: row.recommendationTransition,
      previousRank: row.previousRank ?? null,
      currentRank: row.newRank ?? null,
      topK: row.topK ?? null,
    },

    // The grounded reason Phase J recorded. `changedFields` is what makes the
    // row auditable by the person it concerns, so it is included; the raw
    // matcher rule arrays are not, being internal vocabulary.
    reason: {
      code: row.reason?.code || "",
      summary: row.reason?.summary || "",
      changedFields: (row.reason?.changedFields || []).map((f) => ({
        field: f.field,
        oldValue: f.oldValue,
        newValue: f.newValue,
      })),
    },

    // Populated by the Explanation Agent in Phase K. Explicitly null until
    // then, so the UI can distinguish "not generated yet" from "empty".
    explanation: row.explanation || null,

    createdAt: row.createdAt,
  };
}

/**
 * List one user's recommendation history, newest first.
 *
 * @param {Object} opts
 * @param {string} opts.userId  the CALLER's id, from the verified token
 * @param {Object} [opts.query] req.query
 * @param {Object} [opts.model] injectable for tests
 */
async function listUserHistory({ userId, query = {}, model = RecommendationHistoryModel } = {}) {
  if (!userId) throw new Error("listUserHistory requires a userId");

  const filter = buildHistoryQuery(userId, query);
  const { page, limit, skip } = buildPagination(query);

  const cursor = model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
  const rows = typeof cursor.lean === "function" ? await cursor.lean() : await cursor;
  const total = await model.countDocuments(filter);

  return {
    items: (rows || []).map(serializeHistoryRow),
    page,
    limit,
    total,
    pages: limit > 0 ? Math.ceil(total / limit) : 0,
  };
}

module.exports = {
  listUserHistory,
  buildHistoryQuery,
  buildPagination,
  serializeHistoryRow,
  MAX_LIMIT,
  DEFAULT_LIMIT,
};
