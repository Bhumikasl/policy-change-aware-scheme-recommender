/**
 * PHASE S — how long can a user hold a recommendation the policy already
 * invalidated?
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION, AND WHY IT IS NOT ANY OF O, P, Q OR R
 * ---------------------------------------------------------------------------
 * The project's claim is that a government policy change propagates
 * automatically to the users it affects. Four experiments now examine it:
 *
 *   O  is the retrieved evidence stale?          (about the knowledge base)
 *   P  do the safety guards hold?                (about the LLM layer)
 *   Q  does the targeted band miss anyone?       (about WHO)
 *   R  is the targeted flow actually cheaper?    (about COST)
 *
 * None of them asks WHEN. A propagation that reaches exactly the right people
 * and is six months late is not a correct propagation — it is a wrong
 * recommendation that eventually stopped being wrong. For a system that calls
 * itself a monitor, the interesting quantity is the WORST CASE: the longest a
 * user can be wrong before the system fixes it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED AND WHAT IS DERIVED — THE DISTINCTION MATTERS
 * ---------------------------------------------------------------------------
 * The staleness window has two parts, and only one of them can be measured:
 *
 *   DETECTION DELAY — how long until the next collection tick notices the
 *     change. This is a property of the cron SCHEDULE, not of the code. It is
 *     arithmetic on the configured interval, and it is labelled DERIVED. A
 *     benchmark cannot measure it and pretending otherwise would be a lie.
 *
 *   PROCESSING TIME — how long the pipeline takes once it has noticed. This is
 *     real code doing real work and IS measured, in process.
 *
 * Every figure this module produces carries which of the two it is. A summed
 * "window" that blurred them would look like a measurement and be a schedule
 * setting with a rounding error attached.
 *
 * ---------------------------------------------------------------------------
 * THE PART THAT IS NOT ARITHMETIC
 * ---------------------------------------------------------------------------
 * A stage that fails and is never retried has no worst case at all. The window
 * is UNBOUNDED, and no amount of tuning the schedule changes that.
 *
 * So the analysis below is mostly about recovery paths: for each stage that can
 * fail, is there something that will run again without a human? That check is
 * what found the Phase S defect — `retryFailedPolicyProcessing` existed, was
 * tested, and was scheduled by nothing.
 */

/** Stage failures that leave a user holding a wrong recommendation. */
const STAGE = Object.freeze({
  COLLECTION: "collection",
  POLICY: "policy-analysis",
  NOTIFICATION: "notification-delivery",
  RAG: "rag-indexing",
});

const BOUND = Object.freeze({
  BOUNDED: "BOUNDED",
  UNBOUNDED: "UNBOUNDED",
  NOT_MEASURED: "NOT_MEASURED",
});

/**
 * Upper bound, in minutes, on the wait for the next firing of a cron
 * expression.
 *
 * Deliberately handles only the shapes this project's own schedules use —
 * `*` / `*&#47;N` in the minute or hour field — and returns `null` for anything
 * else rather than guessing. A wrong bound is worse than an absent one: it
 * would be quoted as a guarantee.
 */
function maxIntervalMinutes(expression) {
  if (!expression) return null;
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  // Validated here rather than through node-cron on purpose: this module is an
  // analysis of the SCHEDULE, and it should be runnable without the scheduler's
  // runtime present. It recognises only the shapes below and returns null for
  // everything else, so an unsupported expression yields "not measured" rather
  // than a fabricated bound. The scheduler itself still validates with
  // node-cron before registering a job.
  const FIELD = /^(\*|\*\/\d+|\d+)$/;
  if (!fields.every((f) => FIELD.test(f))) return null;
  const [minute, hour, dom, month, dow] = fields;

  // Anything restricting the day is a schedule whose worst case depends on the
  // calendar. Not guessed.
  if (dom !== "*" || month !== "*" || dow !== "*") return null;

  const step = (field) => {
    if (field === "*") return 1;
    const m = /^\*\/(\d+)$/.exec(field);
    return m && Number(m[1]) > 0 ? Number(m[1]) : null;
  };
  const isFixed = (field) => /^\d+$/.test(field);

  // Worst-case gap between two firings, for the four shapes this project uses.
  if (hour === "*") {
    // Every minute, or every N minutes, of every hour.
    if (minute === "*" || /^\*\/\d+$/.test(minute)) return step(minute);
    // A fixed minute of every hour: "0 * * * *" is hourly.
    if (isFixed(minute)) return 60;
    return null;
  }
  if (/^\*\/\d+$/.test(hour) && isFixed(minute)) {
    // A fixed minute within every N hours.
    const h = step(hour);
    return h === null ? null : h * 60;
  }
  if (isFixed(hour) && isFixed(minute)) {
    // Once a day: "0 3 * * *".
    return 24 * 60;
  }
  return null;
}

/**
 * Which scheduled job, if any, re-runs a failed stage without a human?
 *
 * `recoveredBy` names the job. `null` means nothing does, and the bound for
 * that stage is UNBOUNDED — the state the policy stage was in before Phase S.
 */
function recoveryPaths(env = process.env, { policySweepScheduled = true } = {}) {
  const collection = env.CRON_SCHEDULE || "0 3 * * *";
  const notification = env.NOTIFICATION_RETRY_CRON || "*/5 * * * *";
  const rag = env.RAG_REINDEX_CRON || "0 * * * *";
  const policy = env.POLICY_RETRY_CRON || "0 * * * *";

  return [
    {
      stage: STAGE.COLLECTION,
      // A collection cycle that fails is simply retried by the next tick —
      // there is no stored failure to sweep, the next run recollects.
      recoveredBy: "collection cycle (next tick)",
      schedule: collection,
      maxWaitMinutes: maxIntervalMinutes(collection),
      consequence: "the change is not yet detected; every user keeps the old recommendation",
    },
    {
      stage: STAGE.POLICY,
      recoveredBy: policySweepScheduled ? "policy retry sweep" : null,
      schedule: policySweepScheduled ? policy : null,
      maxWaitMinutes: policySweepScheduled ? maxIntervalMinutes(policy) : null,
      consequence:
        "the change is detected and stored, but eligibility and recommendations " +
        "are NOT updated — affected users keep an invalidated recommendation",
    },
    {
      stage: STAGE.NOTIFICATION,
      recoveredBy: "notification retry sweep",
      schedule: notification,
      maxWaitMinutes: maxIntervalMinutes(notification),
      consequence:
        "the recommendation IS corrected; only the message about it is delayed",
    },
    {
      stage: STAGE.RAG,
      recoveredBy: "RAG re-index sweep",
      schedule: rag,
      maxWaitMinutes: maxIntervalMinutes(rag),
      consequence:
        "eligibility and recommendations are correct; the assistant may quote an " +
        "older version's prose",
    },
  ];
}

/**
 * The worst case, per stage and overall.
 *
 * A single stage with no recovery path makes the WHOLE system unbounded. That
 * is not pessimism — it is what "unbounded" means, and averaging it away with
 * the three stages that do recover would describe a system that does not exist.
 */
function analyse({ env = process.env, processingMs = null, options = {} } = {}) {
  const paths = recoveryPaths(env, options);

  const unrecovered = paths.filter((p) => p.recoveredBy === null);
  const unknownSchedule = paths.filter((p) => p.recoveredBy !== null && p.maxWaitMinutes === null);

  let status;
  if (unrecovered.length > 0) status = BOUND.UNBOUNDED;
  else if (unknownSchedule.length > 0) status = BOUND.NOT_MEASURED;
  else status = BOUND.BOUNDED;

  // The detection delay is the collection interval; correcting a detected
  // change additionally needs the policy path. Only meaningful when both are
  // known and every stage recovers.
  const collection = paths.find((p) => p.stage === STAGE.COLLECTION);
  const policy = paths.find((p) => p.stage === STAGE.POLICY);
  const worstCorrectionMinutes =
    status === BOUND.BOUNDED && collection.maxWaitMinutes !== null && policy.maxWaitMinutes !== null
      ? collection.maxWaitMinutes + policy.maxWaitMinutes
      : null;

  return {
    status,
    paths,
    unrecoveredStages: unrecovered.map((p) => p.stage),
    // DERIVED from the configured schedules. Not a measurement — no clock was
    // involved, and the label travels with the number everywhere it is printed.
    derived: {
      worstCaseCorrectionMinutes: worstCorrectionMinutes,
      basis: "configured cron intervals; assumes every attempt succeeds",
    },
    // MEASURED, when a caller supplies real pipeline timings.
    measured: {
      processingMs: typeof processingMs === "number" ? processingMs : null,
      note:
        processingMs === null
          ? "NOT MEASURED — no pipeline timing supplied"
          : "in-process pipeline duration; excludes SMTP, MongoDB and network",
    },
  };
}

module.exports = { analyse, recoveryPaths, maxIntervalMinutes, STAGE, BOUND };
