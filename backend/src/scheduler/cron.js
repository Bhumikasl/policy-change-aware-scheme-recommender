const cron = require("node-cron");
const { runCollectionCycle } = require("../services/pipeline");
const { retryFailedNotifications } = require("../services/notificationService");
const { reindexStaleSchemes } = require("../services/ragIndexer");
const { retryFailedPolicyProcessing } = require("../services/policyPipeline");
const SchemeModel = require("../models/Scheme");
const logger = require("../utils/logger");

let isRunning = false;
let notificationSweepRunning = false;
let ragSweepRunning = false;
let policySweepRunning = false;

function startScheduler() {
  const schedule = process.env.CRON_SCHEDULE || "0 3 * * *";

  if (!cron.validate(schedule)) {
    logger.error(`Invalid CRON_SCHEDULE "${schedule}", falling back to daily at 03:00`);
  }

  cron.schedule(cron.validate(schedule) ? schedule : "0 3 * * *", async () => {
    if (isRunning) {
      logger.warn("Previous collection cycle still running, skipping this tick");
      return;
    }
    isRunning = true;
    try {
      await runCollectionCycle();
    } finally {
      isRunning = false;
    }
  });

  // ---- NOTIFICATION DELIVERY SWEEP -------------------------------------
  //
  // The SAME scheduler, a second job. Not a second scheduler: two independent
  // cron processes would each think they owned the sweep, and the overlap
  // guard below would be meaningless across them.
  //
  // This drains the notification queue — rows that are PENDING (queued mode)
  // or FAILED_RETRYABLE and now due. It runs the delivery step ONLY. It does
  // not re-run the Policy Change Agent, the Policy Impact Agent,
  // Recommendation Propagation or the Explanation Agent, because none of those
  // failed: the analysis succeeded and was recorded, and only the send did
  // not. Re-running them would redo correct work and, worse, invite a second
  // set of history rows for the same change.
  //
  // Separate from the policy retry sweep (retryFailedPolicyProcessing) for the
  // same reason: those are different failures with different fixes.
  const notificationSchedule = process.env.NOTIFICATION_RETRY_CRON || "*/5 * * * *";
  const notificationScheduleValid = cron.validate(notificationSchedule);
  if (!notificationScheduleValid) {
    logger.error(
      `Invalid NOTIFICATION_RETRY_CRON "${notificationSchedule}", falling back to every 5 minutes`
    );
  }

  cron.schedule(notificationScheduleValid ? notificationSchedule : "*/5 * * * *", async () => {
    // A slow SMTP server can make one sweep outlast its interval. Skipping is
    // correct: the rows are still due next tick, and two concurrent sweeps
    // would both claim from the same set.
    if (notificationSweepRunning) {
      logger.warn("Notification sweep still running, skipping this tick");
      return;
    }
    notificationSweepRunning = true;
    const startedAt = Date.now();
    try {
      const out = await retryFailedNotifications({
        limit: Number(process.env.NOTIFICATION_SWEEP_LIMIT) || 100,
      });
      // Only log a quiet sweep at debug level; every five minutes adds up.
      const line = {
        jobId: `notify-sweep-${startedAt}`,
        attempted: out.attempted,
        emailsSent: out.emailsSent,
        emailsFailed: out.emailsFailed,
        errors: out.errors.length,
        durationMs: Date.now() - startedAt,
      };
      if (out.attempted > 0) logger.info("Notification sweep finished", line);
      else logger.debug("Notification sweep finished (nothing due)", line);
    } catch (err) {
      // A failing sweep must not take the scheduler down with it.
      logger.error("Notification sweep failed", { error: err.message });
    } finally {
      notificationSweepRunning = false;
    }
  });

  // ---- RAG RE-INDEX SWEEP ------------------------------------------------
  //
  // The SAME scheduler again, a third job. Still not a second scheduler.
  //
  // Recovers schemes whose knowledge base is stale — a current version with no
  // ACTIVE chunks, which is what an embedding-provider outage leaves behind.
  // It contacts no government source and re-runs no policy agent: for those
  // changes the eligibility decision, the audit trail and the notifications
  // already succeeded, and only the indexing did not.
  //
  // Hourly by default, not every five minutes. A stale index degrades answer
  // freshness; it does not withhold a benefit from anyone, so it does not
  // deserve the notification sweep's urgency — and each attempt costs
  // embedding quota that a tight retry loop would burn during the very outage
  // it is waiting out.
  const ragSchedule = process.env.RAG_REINDEX_CRON || "0 * * * *";
  const ragScheduleValid = cron.validate(ragSchedule);
  if (!ragScheduleValid) {
    logger.error(`Invalid RAG_REINDEX_CRON "${ragSchedule}", falling back to hourly`);
  }
  const ragEnabled = process.env.RAG_INDEXING !== "false";

  if (ragEnabled) {
    cron.schedule(ragScheduleValid ? ragSchedule : "0 * * * *", async () => {
      if (ragSweepRunning) {
        logger.warn("RAG re-index sweep still running, skipping this tick");
        return;
      }
      ragSweepRunning = true;
      const startedAt = Date.now();
      try {
        const out = await reindexStaleSchemes({
          schemeModel: SchemeModel,
          limit: Number(process.env.RAG_SWEEP_LIMIT) || 25,
        });
        const line = { jobId: `rag-sweep-${startedAt}`, ...out };
        if (out.attempted > 0) logger.info("RAG re-index sweep finished", line);
        else logger.debug("RAG re-index sweep finished (nothing stale)", line);
      } catch (err) {
        // A failing sweep must not take the scheduler down with it — and must
        // not touch policy processing, which is already complete for these
        // schemes.
        logger.error("RAG re-index sweep failed", { error: err.message });
      } finally {
        ragSweepRunning = false;
      }
    });
  }

  // ---- POLICY RETRY SWEEP (Phase S) ------------------------------------
  //
  // THE HOLE THIS CLOSES.
  //
  // `retryFailedPolicyProcessing` has existed since Phase J, is tested, and is
  // exported — and was reachable ONLY by a human typing `npm run policy:retry`.
  // Nothing scheduled it. The comment on the notification sweep above even
  // refers to "the policy retry sweep" as though it ran.
  //
  // So when the impact or propagation stage failed transiently, the row was
  // marked `policyRetryable: true` and then waited forever. The affected users
  // kept a recommendation the policy change had already invalidated, with no
  // bound on how long — in a system whose whole claim is that a policy change
  // propagates automatically.
  //
  // This is the SAME scheduler, a fourth job, following the notification and
  // RAG sweeps exactly: an overlap guard, its own interval, and a try/catch so
  // a failing sweep cannot take the scheduler down.
  //
  // Hourly by default. More urgent than the RAG sweep, because a stale
  // recommendation can withhold a benefit from someone; less urgent than the
  // notification sweep, because the analysis has to be re-run rather than a
  // stored message re-sent.
  const policySchedule = process.env.POLICY_RETRY_CRON || "0 * * * *";
  const policyScheduleValid = cron.validate(policySchedule);
  if (!policyScheduleValid) {
    logger.error(`Invalid POLICY_RETRY_CRON "${policySchedule}", falling back to hourly`);
  }

  cron.schedule(policyScheduleValid ? policySchedule : "0 * * * *", async () => {
    if (policySweepRunning) {
      logger.warn("Policy retry sweep still running, skipping this tick");
      return;
    }
    policySweepRunning = true;
    const startedAt = Date.now();
    try {
      const results = await retryFailedPolicyProcessing({
        limit: Number(process.env.POLICY_RETRY_LIMIT) || 50,
        jobId: `policy-retry-${startedAt}`,
      });
      const line = { jobId: `policy-retry-${startedAt}`, attempted: results.length };
      if (results.length > 0) logger.info("Policy retry sweep finished", line);
      else logger.debug("Policy retry sweep finished (nothing retryable)", line);
    } catch (err) {
      logger.error("Policy retry sweep failed", { error: err.message });
    } finally {
      policySweepRunning = false;
    }
  });

  logger.info(
    `Scheduler started — collection "${schedule}", policy retry "${
      policyScheduleValid ? policySchedule : "0 * * * *"
    }", notification sweep "${
      notificationScheduleValid ? notificationSchedule : "*/5 * * * *"
    }", RAG sweep "${
      !ragEnabled ? "disabled" : ragScheduleValid ? ragSchedule : "0 * * * *"
    }"`
  );

  if (process.env.RUN_ON_STARTUP === "true") {
    isRunning = true;
    runCollectionCycle()
      .catch((err) => logger.error("Startup collection cycle failed", { error: err.message }))
      .finally(() => {
        isRunning = false;
      });
  }
}

module.exports = { startScheduler };
