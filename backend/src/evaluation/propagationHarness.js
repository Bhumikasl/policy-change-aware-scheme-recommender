/**
 * PHASE Q — the harness that runs the corpus and produces the observations.
 *
 * Separated from the CLI so the same code path is exercised by the test suite
 * and by `npm run evaluate:propagation`. A harness only the CLI can reach is a
 * harness nothing tests.
 */

const { runCase, compareRuns } = require("./propagationOracle");
const { STATUS } = require("./propagationMetrics");
const { matchesQuery } = require("./queryEvaluator");

/**
 * An in-process user store with the slice of the Mongoose model surface
 * `assessImpact` actually uses: `find(filter).batchSize(n).cursor()` and
 * `countDocuments(filter)`.
 *
 * Filters are evaluated by `queryEvaluator`, which implements only the
 * operators the Impact Agent emits and throws on anything else. A run through
 * this store is labelled SIMULATED_STORE so no reader mistakes it for a
 * measurement of MongoDB.
 */
function makeUserStore(users) {
  const rows = users.map((u) => ({ ...u }));
  return {
    find(filter = {}) {
      const matched = rows.filter((r) => matchesQuery(r, filter));
      const query = {
        batchSize() {
          return this;
        },
        cursor() {
          let i = 0;
          return { next: async () => (i < matched.length ? matched[i++] : null) };
        },
        then(resolve, reject) {
          return Promise.resolve(matched).then(resolve, reject);
        },
      };
      return query;
    },
    async countDocuments(filter = {}) {
      return rows.filter((r) => matchesQuery(r, filter)).length;
    },
    rows,
  };
}

/**
 * Run every case in the corpus.
 *
 * A case that throws becomes a FAILED observation carrying its error, and the
 * run status becomes FAILED. It is never dropped: a corpus that silently
 * shrinks when something breaks reports a soundness figure over whatever
 * happened to work, which is worse than no figure at all.
 */
async function runCorpus({ corpus, users, changeVerdict = null, userModel = null } = {}) {
  const store = userModel || makeUserStore(users);
  const observations = [];

  for (const kase of corpus) {
    try {
      const runs = await runCase(kase, { userModel: store, changeVerdict });
      const cmp = compareRuns(runs);

      // `skipped` means the Change Agent's verdict said no user could be
      // affected, and BOTH runs returned before any user was examined. That
      // gate is upstream of the banding, so this case measured nothing about
      // the band — NOT_MEASURED, not SOUND. Scoring it SOUND would let a
      // corpus of skipped cases report perfect soundness having tested nothing.
      if (cmp.candidateSelection === "skipped") {
        observations.push({
          id: kase.id,
          label: kase.label,
          status: STATUS.NOT_MEASURED,
          reason: "changeVerdict.userImpactExpected was false — the band was never exercised",
          ...cmp,
        });
        continue;
      }

      // The agent's own contract, checked against what the corpus expected.
      // A mismatch is reported, not asserted away: it means either the corpus
      // labelling or the agent's banding changed, and both are worth seeing.
      const selectionAsExpected =
        !kase.expectedSelection || kase.expectedSelection === cmp.candidateSelection;

      observations.push({
        id: kase.id,
        label: kase.label,
        status: cmp.sound ? STATUS.SOUND : STATUS.UNSOUND,
        expectedSelection: kase.expectedSelection || null,
        selectionAsExpected,
        ...cmp,
      });
    } catch (err) {
      observations.push({
        id: kase.id,
        label: kase.label,
        status: STATUS.FAILED,
        error: err.message,
      });
    }
  }

  return { observations, store };
}

module.exports = { runCorpus, makeUserStore };
