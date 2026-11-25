/**
 * PHASE Q — a MongoDB query evaluator for the operators the Impact Agent emits.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NARROW ON PURPOSE
 * ---------------------------------------------------------------------------
 * Phase Q measures whether the Impact Agent's targeted candidate query is
 * SOUND — whether the band it computes can ever miss a user whose eligibility
 * genuinely moved. Answering that offline means running the agent's own filter
 * against a user population without a database.
 *
 * A general-purpose Mongo emulator would be the wrong tool: it would be large,
 * it would be wrong in places nobody noticed, and a measurement taken through a
 * subtly wrong emulator measures the emulator. So this implements EXACTLY the
 * operator set `deriveCandidateFilter` and `buildImpactQuery` can produce:
 *
 *     $gt  $gte  $lt  $lte  $in        (leaf comparisons)
 *     $or                              (targeted-union)
 *     { field: value }                 (direct equality)
 *     { _id: null }                    (the empty-set sentinel)
 *     { }                              (full scan)
 *
 * ...and nothing else. `tests/propagationEvaluation.test.js` reads the agent's
 * source and fails if it ever emits an operator this file does not implement,
 * so the two cannot drift apart silently. That drift guard is what makes an
 * offline number trustworthy.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN OFFLINE RESULT IS AND IS NOT
 * ---------------------------------------------------------------------------
 * A run through this evaluator is labelled SIMULATED_STORE. It measures the
 * agent's banding logic, which is the thing under test — but it is NOT a
 * measurement of MongoDB, of index behaviour, or of Atlas. `--live` runs the
 * same corpus against the real User collection for that.
 */

/** Read a dotted path, the way Mongo addresses a nested field. */
function getPath(doc, path) {
  return String(path)
    .split(".")
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

/** Operators this file implements. The drift guard in the test reads this. */
const SUPPORTED_OPERATORS = Object.freeze(["$gt", "$gte", "$lt", "$lte", "$in", "$or"]);

class UnsupportedQueryError extends Error {
  constructor(operator) {
    super(
      `Phase Q query evaluator does not implement "${operator}". ` +
        `The Impact Agent emits an operator this harness cannot evaluate, so an ` +
        `offline soundness figure would be wrong rather than merely incomplete. ` +
        `Implement it here (and in the drift guard) before trusting a result.`
    );
    this.operator = operator;
    this.expected = true;
  }
}

/**
 * Compare like Mongo does for the numeric operators the bands use.
 *
 * Mongo does NOT match a missing or null field against `$gt` / `$lte`, and that
 * detail matters here: a user with no recorded income must not silently fall
 * inside an income band. Returning false for null/undefined is the honest
 * reading, and it is also the conservative one — it can only make the measured
 * recall WORSE, never flatter it.
 */
function compare(op, actual, expected) {
  if (actual === null || actual === undefined) return false;
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  switch (op) {
    case "$gt": return actual > expected;
    case "$gte": return actual >= expected;
    case "$lt": return actual < expected;
    case "$lte": return actual <= expected;
    default: throw new UnsupportedQueryError(op);
  }
}

/**
 * `$in` against a scalar OR an array field.
 *
 * Mongo matches an array field when ANY element is in the list, and the agent
 * relies on that for `profile.categories`. Matching is case-sensitive, exactly
 * as Mongo is — the agent already compensates by emitting both casings.
 */
function matchesIn(actual, list) {
  const wanted = Array.isArray(list) ? list : [list];
  if (Array.isArray(actual)) return actual.some((v) => wanted.includes(v));
  return wanted.includes(actual);
}

function matchesLeaf(actual, condition) {
  // A plain value is an equality test, not an operator document.
  if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
    if (Array.isArray(actual)) return actual.includes(condition);
    return actual === condition;
  }

  for (const [op, expected] of Object.entries(condition)) {
    if (op === "$in") {
      if (!matchesIn(actual, expected)) return false;
    } else if (op === "$gt" || op === "$gte" || op === "$lt" || op === "$lte") {
      if (!compare(op, actual, expected)) return false;
    } else {
      throw new UnsupportedQueryError(op);
    }
  }
  return true;
}

/**
 * Does this document match this query?
 *
 * @param {Object} doc    a user document
 * @param {Object} query  a filter produced by buildImpactQuery
 * @returns {boolean}
 */
function matchesQuery(doc, query) {
  if (!query || typeof query !== "object") return true;

  for (const [key, condition] of Object.entries(query)) {
    if (key === "$or") {
      const branches = Array.isArray(condition) ? condition : [];
      // An empty $or matches nothing in Mongo. buildImpactQuery never emits
      // one, but guessing "true" here would inflate every recall figure.
      if (!branches.some((b) => matchesQuery(doc, b))) return false;
      continue;
    }
    if (key.startsWith("$")) throw new UnsupportedQueryError(key);

    // The empty-set sentinel the agent uses for "nobody can be affected".
    if (key === "_id" && condition === null) return false;

    if (!matchesLeaf(getPath(doc, key), condition)) return false;
  }
  return true;
}

module.exports = { matchesQuery, getPath, SUPPORTED_OPERATORS, UnsupportedQueryError };
