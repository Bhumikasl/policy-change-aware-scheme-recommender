/**
 * PHASE T — is the ranking a function of the candidate SET, or of the order the
 * database happened to return it in?
 *
 * ---------------------------------------------------------------------------
 * THE PROPERTY UNDER TEST
 * ---------------------------------------------------------------------------
 * `rankCandidates` should be ORDER-INVARIANT: shuffle the input and the output
 * ranking must be identical. If it is not, the ranking carries information that
 * came from nowhere — and downstream, this project turns rank movement into
 * claims about the world:
 *
 *     rank 1 -> 2
 *       -> classifyRecommendationTransition  = RANK_DECREASED
 *       -> decideNotification                = shouldNotify: true
 *       -> the user is emailed "<Scheme> moved down your recommendations"
 *       -> a RecommendationHistory row asserts a movement that never happened
 *
 * So order-invariance is not a tidiness concern. It is the difference between
 * an audit trail that records changes and one that manufactures them.
 *
 * ---------------------------------------------------------------------------
 * WHY PERMUTATION TESTING RATHER THAN A UNIT TEST
 * ---------------------------------------------------------------------------
 * A unit test asserts one ranking against one expected order. It passes whether
 * or not the comparator is a total order, because it only ever sees the input in
 * one arrangement — which is exactly how the Phase T defect survived eighteen
 * ranking tests.
 *
 * Shuffling the SAME candidates and requiring the SAME output tests the property
 * itself. A comparator that leaves any pair unresolved fails as soon as a
 * permutation puts that pair the other way round.
 *
 * ---------------------------------------------------------------------------
 * TIE GROUPS ARE REPORTED, NOT TREATED AS FAILURES
 * ---------------------------------------------------------------------------
 * Two schemes scoring identically is normal and not a defect by itself. What
 * matters is whether the comparator RESOLVES the tie deterministically. So the
 * report carries both: how many tie groups exist (a property of the corpus and
 * the scoring function) and whether the output moved (a property of the
 * comparator). Only the second can fail.
 */

/**
 * A deterministic shuffle.
 *
 * Deterministic because a stability result that cannot be reproduced is not
 * evidence — a reader must be able to re-run this and get the same permutations.
 * A plain integer LCG is used rather than Math.random for that reason: no seed
 * to record separately, no library to trust.
 */
function permute(items, seed) {
  const out = [...items];
  let state = (seed >>> 0) || 1;
  const next = () => {
    // Numerical Recipes LCG. Its statistical quality is irrelevant here — all
    // that is needed is a reproducible sequence of distinct arrangements.
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The identity of a ranked entry, for comparing two rankings. */
const idOf = (entry) => String(entry?.scheme?.schemeId ?? entry?.schemeId ?? "");

/**
 * Rank the same candidates under many input orders and compare.
 *
 * @param {Function} rank        the production `rankCandidates`
 * @param {Array}    candidates  one user's candidate list
 * @param {Object}   user
 * @param {number}   permutations
 * @returns {Object} one observation
 */
function checkOrderInvariance({ rank, candidates, user, permutations = 24, clearCache = null } = {}) {
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return {
      status: "NOT_MEASURED",
      reason: "fewer than two candidates — no ordering to disturb",
      permutations: 0,
    };
  }

  const run = (list) => {
    // The IDF cache is keyed on the corpus; clearing it between runs keeps the
    // comparison about the comparator rather than about cache state.
    if (typeof clearCache === "function") clearCache();
    return rank(list, user, {}).map(idOf);
  };

  const baseline = run(candidates);
  const disagreements = [];

  for (let p = 1; p <= permutations; p++) {
    const shuffled = permute(candidates, p * 2654435761);
    const got = run(shuffled);
    if (got.join("|") !== baseline.join("|")) {
      disagreements.push({
        permutation: p,
        // The first position that differs — enough to identify the unresolved
        // pair without dumping two whole rankings into the report.
        firstDivergenceAt: got.findIndex((id, i) => id !== baseline[i]),
        expected: baseline,
        got,
      });
    }
  }

  return {
    status: disagreements.length === 0 ? "STABLE" : "UNSTABLE",
    permutations,
    disagreements: disagreements.slice(0, 3),
    disagreementCount: disagreements.length,
    baseline,
  };
}

/**
 * How many candidates share a scoring position with another candidate?
 *
 * Reported as context for the stability verdict. A corpus with NO ties cannot
 * demonstrate order-invariance at all — there is nothing for the final
 * tie-break to resolve — so a STABLE result over zero tie groups is much weaker
 * evidence than the same result over many, and the report says so rather than
 * letting a vacuous pass look like a strong one.
 */
function tieGroups(ranked) {
  const key = (e) =>
    `${Number(e.relevance ?? 0).toFixed(6)}|${Number(e.verdict?.score ?? 0).toFixed(6)}`;
  const buckets = new Map();
  for (const e of ranked) {
    const k = key(e);
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const groups = [...buckets.values()].filter((n) => n > 1);
  return {
    tieGroups: groups.length,
    tiedCandidates: groups.reduce((a, b) => a + b, 0),
    largestGroup: groups.length ? Math.max(...groups) : 0,
  };
}

/**
 * Is the comparator a TOTAL order over this candidate set?
 *
 * Distinct from stability: stability is observed, totality is structural. Two
 * candidates that tie on every key the comparator reads AND share the tie-break
 * key are genuinely indistinguishable to it, and no amount of shuffling would
 * reveal that. `schemeId` is unique in the collection, so this should always
 * hold — asserting it catches a future tie-break that is not unique.
 */
function totalOrderCheck(ranked) {
  const seen = new Set();
  const duplicates = [];
  for (const e of ranked) {
    const id = idOf(e);
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  return {
    isTotalOrder: duplicates.length === 0,
    duplicateKeys: duplicates,
  };
}

module.exports = { checkOrderInvariance, tieGroups, totalOrderCheck, permute, idOf };
