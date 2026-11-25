/**
 * PHASE Q — ground truth for the propagation-soundness experiment.
 *
 * ---------------------------------------------------------------------------
 * THE ONE IDEA IN THIS FILE
 * ---------------------------------------------------------------------------
 * The question is whether the Impact Agent's narrow candidate query can miss a
 * user whose eligibility genuinely moved. To answer it, something has to know
 * the true answer.
 *
 * The tempting approach — write a second, simpler implementation of "who is
 * affected" and compare — is the wrong one, and it is worth being explicit
 * about why. A second implementation is a second set of bugs. When the two
 * disagree, nothing tells you which one is right, and the usual outcome is that
 * whichever is easier to change gets "fixed" until the numbers agree. That
 * produces a green result and no knowledge.
 *
 * So the oracle is not a second implementation. It is the SAME `assessImpact`,
 * over the SAME users, with the SAME matcher, the SAME transition classifier
 * and the SAME closed-scheme handling — differing in exactly one respect: the
 * candidate filter is discarded and every user is examined.
 *
 * That isolates the variable under test. Any disagreement between the two runs
 * is attributable to the filter and to nothing else, because the filter is the
 * only thing that differs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS NO PRODUCTION CHANGE
 * ---------------------------------------------------------------------------
 * `assessImpact` already takes `userModel` by injection. Wrapping that model so
 * `find()` ignores the filter it is handed is enough to force a full scan —
 * no flag, no branch, and no production code that exists only for evaluation.
 * The agent cannot tell the difference and therefore cannot behave differently.
 */

const { assessImpact } = require("../agents/policyImpactAgent");

/**
 * Wrap a user model so every `find()` returns the whole collection.
 *
 * `countDocuments` is passed through unchanged: the agent uses it as the
 * denominator of `scanReduction`, and that figure should stay honest even on an
 * oracle run (where it is 0 by definition).
 */
function scanAllModel(userModel) {
  return {
    find: () => userModel.find({}),
    countDocuments: (filter = {}) => userModel.countDocuments(filter),
  };
}

/** A stable identity for set comparison. Mongo ids are objects; these are not. */
const idOf = (impact) => String(impact.userId);

/**
 * Run one corpus case twice: once as the pipeline runs it, once exhaustively.
 *
 * @returns {Promise<{pipeline: Object, oracle: Object}>} both raw agent results
 */
async function runCase(kase, { userModel, changeVerdict = null } = {}) {
  const args = {
    scheme: kase.schemeAfter,
    oldRules: kase.oldRules,
    diffs: kase.diffs,
    changeVerdict,
    oldSchemeSnapshot: kase.oldSchemeSnapshot,
    isNew: false,
  };

  const pipeline = await assessImpact({ ...args, userModel });

  // `isNew: true` is the ONLY thing that differs, and it is not a convenience.
  //
  // Wrapping the model so find() ignores the filter is not sufficient on its
  // own: `assessImpact` returns early, before touching the model at all, when
  // `buildImpactQuery` classifies the query as `none`. An oracle built only on
  // the model wrapper therefore goes blind in exactly the case that matters
  // most — a banding bug that selects NOBODY produces an empty pipeline result
  // AND an empty oracle, and the comparison reports a serene 0 missed.
  //
  // This was not hypothetical. A mutation that dropped removed values from the
  // state/occupation symmetric difference made `state-list-reduced` select
  // nobody, and the first version of this oracle scored that case SOUND.
  //
  // `isNew` is used in exactly one place in the agent — to force
  // `filter: {}` with the full-scan contract — so setting it here means "scan
  // everyone" and nothing else. Every other input is identical, so the
  // comparison still isolates the candidate query.
  const oracle = await assessImpact({
    ...args,
    isNew: true,
    userModel: scanAllModel(userModel),
  });

  return { pipeline, oracle };
}

/**
 * Compare a pipeline run against its oracle.
 *
 * `missed` is the finding that matters. Each entry is a real person the system
 * would never have told. `spurious` should be empty by construction — the
 * pipeline examines a subset of the users the oracle examines, and both apply
 * the same classifier — so a non-empty `spurious` means an assumption broke
 * somewhere, which is worth surfacing rather than assuming away.
 *
 * `transitionMismatches` catches the subtler failure: the same user reached by
 * both runs but classified differently. That cannot happen while the filter is
 * the only difference, which is exactly why it is checked.
 */
function compareRuns({ pipeline, oracle }) {
  const pipelineById = new Map(pipeline.impacts.map((i) => [idOf(i), i]));
  const oracleById = new Map(oracle.impacts.map((i) => [idOf(i), i]));

  const missed = [];
  const transitionMismatches = [];
  for (const [id, truth] of oracleById) {
    const got = pipelineById.get(id);
    if (!got) {
      missed.push({ userId: id, transition: truth.transition });
      continue;
    }
    if (got.transition !== truth.transition) {
      transitionMismatches.push({
        userId: id,
        pipeline: got.transition,
        oracle: truth.transition,
      });
    }
  }

  const spurious = [];
  for (const [id, got] of pipelineById) {
    if (!oracleById.has(id)) spurious.push({ userId: id, transition: got.transition });
  }

  const affected = oracleById.size;
  return {
    affectedByOracle: affected,
    reportedByPipeline: pipelineById.size,
    missed,
    spurious,
    transitionMismatches,
    // Recall over the users who actually moved. `null` rather than 1.0 when the
    // oracle found nobody: a case where nothing moved cannot demonstrate that
    // the band keeps everyone, and scoring it 100% would quietly inflate the
    // average with cases that tested nothing.
    recall: affected === 0 ? null : Number(((affected - missed.length) / affected).toFixed(4)),
    sound: missed.length === 0 && transitionMismatches.length === 0,
    candidatesExamined: pipeline.candidatesExamined,
    oracleExamined: oracle.candidatesExamined,
    candidateSelection: pipeline.candidateSelection,
    scannedEveryUser: pipeline.scannedEveryUser,
    narrowingProven: pipeline.narrowingProven,
    completenessGuaranteed: pipeline.completenessGuaranteed,
    scanReduction: pipeline.scanReduction,
  };
}

module.exports = { scanAllModel, runCase, compareRuns };
