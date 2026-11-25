/**
 * PHASE R — the cost of the targeted notification flow, measured.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS PHASE COMES FROM
 * ---------------------------------------------------------------------------
 * Phase R is not invented here. `NOTIFICATION_ARCHITECTURE.md` defers exactly
 * two questions to it, in writing:
 *
 *   1. "**No scalability claim is made here.** The flow is narrower by
 *      construction; whether that yields a measured improvement on a real
 *      population is a Phase R question and has not been measured."
 *
 *   2. "Revisit [a message broker] when a measured collection cycle spends a
 *      material fraction of its time in delivery... That measurement belongs to
 *      Phase R and has not been taken."
 *
 * Both are cost questions about the same path, and both were unanswerable
 * because the instrument did not exist. This is the instrument.
 *
 * ---------------------------------------------------------------------------
 * R.1 — DOES THE TARGETED FLOW ACTUALLY NOTIFY FEWER PEOPLE?
 * ---------------------------------------------------------------------------
 * The claim under test, stated as narrowly as it deserves: for a given policy
 * change over a given population, the Phase I->J->L path interrupts fewer
 * people than the pre-Phase-I notifier did, and the ones it drops are people
 * for whom nothing changed.
 *
 * The baseline is not a reconstruction. It is `notifyMatchingUsers` — the
 * actual legacy function, still in the tree, still reachable behind
 * `LEGACY_NOTIFIER=true` — run over the same population against the same
 * scheme. A re-implementation would be a second set of bugs, and every
 * disagreement would be ambiguous.
 *
 * The comparison is deliberately unflattering in one respect: the legacy path
 * fires on EVERY version bump for everyone who matches the scheme, whereas the
 * targeted path fires only for users whose recommendation state MOVED. That is
 * the whole difference, and reporting it as a ratio without saying so would
 * overstate it. The report names both denominators.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 * Not a throughput benchmark. Not a latency measurement of SMTP, MongoDB or
 * Atlas. Not a statement about a real user population — the corpus is the same
 * SYNTHETIC one Phase Q uses, reused rather than duplicated so the two
 * experiments describe the same population.
 */

const { assessImpact } = require("../agents/policyImpactAgent");
const { classifyEligibilityTransition } = require("../services/recommendationPropagation");
const { notifyMatchingUsers } = require("../services/notifier");
const { decideNotification } = require("../agents/notificationAgent");

/**
 * A NotificationLog stand-in that records rather than writes.
 *
 * The legacy path dedups by inserting into NotificationLog and catching the
 * duplicate-key error. Counting inserts is therefore counting the people it
 * would have emailed, which is the figure R.1 needs.
 */
function makeLogRecorder() {
  const seen = new Set();
  return {
    inserted: [],
    async create(doc) {
      const key = `${doc.email}|${doc.schemeId}|${doc.version}|${doc.channel}`;
      if (seen.has(key)) {
        // Exactly what a unique index raises, so the real dedup branch runs.
        const err = new Error("E11000 duplicate key");
        err.code = 11000;
        throw err;
      }
      seen.add(key);
      this.inserted.push(doc);
      return doc;
    },
  };
}

/**
 * Run the LEGACY full-scan notifier over the population.
 *
 * No email is sent: `sendEmail` is a counter. The point is how many people the
 * path would interrupt, not SMTP behaviour.
 */
async function runLegacyBaseline({ scheme, users, version = 2 }) {
  const logModel = makeLogRecorder();
  const emailed = [];
  const userModel = { async find() { return users; } };

  const started = Date.now();
  const sent = await notifyMatchingUsers(
    scheme,
    "synthetic change summary",
    "UPDATED",
    version,
    { userModel, logModel, sendEmail: async (u) => emailed.push(String(u._id)) }
  );

  return {
    path: "legacy-full-scan",
    usersScanned: users.length,
    notified: sent,
    notifiedIds: emailed,
    durationMs: Date.now() - started,
  };
}

/**
 * Run the TARGETED flow: Impact Agent -> transition -> Notification Agent.
 *
 * This mirrors what `policyPipeline` does between the impact stage and the
 * delivery stage, using the same three production units. It stops before the
 * database write, because R.1 counts who would be interrupted, not rows.
 */
async function runTargetedFlow({ scheme, oldRules, diffs, oldSchemeSnapshot, userModel, changeVerdict = null }) {
  const started = Date.now();

  const impact = await assessImpact({
    scheme,
    oldRules,
    diffs,
    changeVerdict,
    oldSchemeSnapshot,
    isNew: false,
    userModel,
  });

  // Only users whose recommendation state actually moved reach the agent, and
  // only those the agent says are worth interrupting are notified.
  const notifiedIds = [];
  let suppressed = 0;
  for (const impacted of impact.impacts) {
    // The same record shape `recommendationPropagation` hands the agent in
    // production, so the agent's real classification runs rather than a
    // paraphrase of it.
    const record = {
      schemeId: scheme.schemeId,
      schemeName: scheme.name,
      eligibilityTransition: classifyEligibilityTransition(
        impacted.wasEligible,
        impacted.isEligible
      ),
      recommendationTransition: null,
      reason: { code: "", changedFields: [] },
    };
    const decision = decideNotification({ record, notificationPrefs: {} });
    if (decision.shouldNotify) notifiedIds.push(String(impacted.userId));
    else suppressed += 1;
  }

  return {
    path: "targeted",
    usersScanned: impact.candidatesExamined,
    candidateSelection: impact.candidateSelection,
    scannedEveryUser: impact.scannedEveryUser,
    stateMoved: impact.impacts.length,
    notified: notifiedIds.length,
    notifiedIds,
    suppressed,
    durationMs: Date.now() - started,
  };
}

/**
 * One case: both paths over the same population and the same scheme.
 *
 * `notifiedByLegacyOnly` is the number that matters for the claim. Each entry
 * is a person the legacy path would have emailed and the targeted path would
 * not — and, because the targeted set comes from a real transition, each one is
 * a person for whom nothing about their eligibility moved.
 */
async function runCase(kase, { users, userModel, changeVerdict = null } = {}) {
  const legacy = await runLegacyBaseline({ scheme: kase.schemeAfter, users });
  const targeted = await runTargetedFlow({
    scheme: kase.schemeAfter,
    oldRules: kase.oldRules,
    diffs: kase.diffs,
    oldSchemeSnapshot: kase.oldSchemeSnapshot,
    userModel,
    changeVerdict,
  });

  const targetedSet = new Set(targeted.notifiedIds);
  const legacySet = new Set(legacy.notifiedIds);

  return {
    id: kase.id,
    label: kase.label,
    legacy,
    targeted,
    // Interrupted by the legacy path only — the reduction, as people.
    notifiedByLegacyOnly: [...legacySet].filter((id) => !targetedSet.has(id)).length,
    // Interrupted by the targeted path only. Non-zero is INTERESTING, not a
    // bug: the legacy path only ever emails users who match the scheme AFTER
    // the change, so anyone who LOST eligibility is invisible to it. That is a
    // correctness gap in the baseline, and it is reported rather than hidden.
    notifiedByTargetedOnly: [...targetedSet].filter((id) => !legacySet.has(id)).length,
  };
}

module.exports = { runCase, runLegacyBaseline, runTargetedFlow, makeLogRecorder };
