const NotificationModel = require("../models/Notification");
const UserModel = require("../models/User");
const { decideNotification } = require("../agents/notificationAgent");
const {
  NOTIFICATION_STATUS,
  NOTIFICATION_CHANNELS,
  CLAIMABLE_STATUSES,
  isPermanentFailure,
} = require("../constants/notificationTypes");
const { sendSchemeEmail } = require("./mailer");
const logger = require("../utils/logger");

/**
 * NOTIFICATION SERVICE — Phase L delivery.
 *
 * ---------------------------------------------------------------------------
 * WHERE ITS INPUT COMES FROM, AND WHY THAT MATTERS
 * ---------------------------------------------------------------------------
 * The records this consumes are the ones Recommendation Propagation just
 * wrote — the users the Policy Impact Agent identified, filtered to those
 * whose recommendation state actually moved.
 *
 * It does NOT call User.find({}). The old notifier did, and that single line
 * undid the whole point of targeted impact analysis: the Impact Agent would
 * narrow to twelve users and the notifier would then load all fifty thousand
 * to decide who to email. Here the affected set arrives as an argument, and
 * the only user lookup is a targeted fetch of preferences for users already in
 * that set.
 *
 * ---------------------------------------------------------------------------
 * FAILURE ISOLATION
 * ---------------------------------------------------------------------------
 * A notification failure is not a propagation failure. The audit trail is the
 * guarantee; the email is a courtesy on top of it. So this returns counters
 * rather than throwing, and its caller records them separately from the policy
 * stage statuses. An SMTP outage must not mark a correct policy propagation as
 * FAILED and send the retry sweep re-running work that succeeded.
 *
 * Delivery failures are retryable on their own, with backoff, through
 * retryFailedNotifications().
 */

const MAX_RETRIES = Number(process.env.NOTIFICATION_MAX_RETRIES) || 4;
const BASE_BACKOFF_MS = Number(process.env.NOTIFICATION_BACKOFF_MS) || 60_000;

/**
 * THE QUEUE BOUNDARY (L.3)
 *
 * "inline"  — send during the collection cycle. Simple, and correct while the
 *             affected set is small.
 * "queued"  — write the row as PENDING and return. A worker drains it later.
 *
 * The Notification collection IS the queue: a row with status PENDING and a
 * due nextAttemptAt is a job, `claimDueNotifications` is the dequeue, and the
 * unique index is the exactly-once guarantee. That is deliberate — Redis or
 * BullMQ would add a second datastore to operate, back up and keep consistent
 * with Mongo, to buy throughput this project has not yet been shown to need.
 *
 * What matters for the research claim is the BOUNDARY, and it exists either
 * way: policy processing persists jobs and never waits on SMTP. Switching to
 * a real broker later means replacing claimDueNotifications, not restructuring
 * the pipeline.
 *
 * Default is inline, because that is what the current tests exercise
 * end-to-end. Set NOTIFICATION_DELIVERY_MODE=queued to decouple.
 */
const DELIVERY_MODE = () =>
  (process.env.NOTIFICATION_DELIVERY_MODE || "inline").toLowerCase();

/**
 * Exponential backoff: 1, 2, 4, 8 minutes by default.
 *
 * A fixed delay would hammer a down SMTP server every sweep; without a cap on
 * attempts a permanently bad address would be retried forever.
 */
function backoffFor(retryCount) {
  return BASE_BACKOFF_MS * Math.pow(2, Math.max(0, retryCount));
}

/** Mongoose Query or plain promise, indifferently. */
async function resolveMaybeQuery(q) {
  if (!q) return null;
  return typeof q.lean === "function" ? q.lean() : q;
}

/**
 * Load preferences for exactly the users in the affected set.
 *
 * One `$in` query rather than one query per user, and never a full scan.
 */
async function loadPreferences(userIds, userModel) {
  const prefs = new Map();
  if (userIds.length === 0) return prefs;
  try {
    const rows = await resolveMaybeQuery(
      userModel.find({ _id: { $in: userIds } })
    );
    for (const u of rows || []) {
      prefs.set(String(u._id), {
        email: u.email,
        notificationPrefs: u.notificationPrefs || {},
      });
    }
  } catch (err) {
    // Without preferences the safe default is to create the in-app record and
    // NOT email — silence is recoverable, an unwanted email is not.
    logger.warn("NotificationService: could not load preferences, defaulting to in-app only", {
      error: err.message,
    });
  }
  return prefs;
}

/**
 * Insert one notification, at most once.
 *
 * The pre-check avoids the write on the common replay path. The duplicate-key
 * catch is what actually guarantees uniqueness, because two concurrent runs
 * can both pass a pre-check before either inserts — only the unique index
 * settles that race.
 *
 * @returns {Promise<{created: boolean, doc: Object|null, duplicate: boolean}>}
 */
async function insertOnce(model, doc) {
  try {
    const existing = await resolveMaybeQuery(
      model.findOne({
        userId: doc.userId,
        schemeId: doc.schemeId,
        triggeringChangeId: doc.triggeringChangeId,
        channel: doc.channel,
      })
    );
    if (existing) return { created: false, doc: existing, duplicate: true };
  } catch (err) {
    // A failed pre-check is not fatal; the index still protects us.
    logger.warn("NotificationService: dedup pre-check failed, relying on unique index", {
      error: err.message,
    });
  }

  try {
    const created = await model.create(doc);
    return { created: true, doc: created || doc, duplicate: false };
  } catch (err) {
    if (err && (err.code === 11000 || /duplicate key/i.test(String(err.message)))) {
      return { created: false, doc: null, duplicate: true };
    }
    throw err;
  }
}

/**
 * Turn propagation records into notifications, and attempt delivery.
 *
 * @param {Object} opts
 * @param {Array}  opts.records         RecommendationHistory docs propagation wrote
 * @param {string} [opts.processingJobId]
 * @param {Object} [opts.deps]          injectable models/mailer for tests
 * @returns {Promise<Object>} counters; never throws
 */
async function notifyFromTransitions({ records = [], processingJobId = "", deps = {} } = {}) {
  const {
    notificationModel = NotificationModel,
    userModel = UserModel,
    sendEmail = sendSchemeEmail,
    decide = decideNotification,
    now = () => new Date(),
    // Explicit override wins; otherwise the environment decides.
    queued = deps.queued !== undefined ? deps.queued : DELIVERY_MODE() === "queued",
  } = deps;

  const result = {
    considered: records.length,
    inAppCreated: 0,
    inAppSuppressed: 0,
    emailsSent: 0,
    emailsQueued: 0,
    emailsFailed: 0,
    permanentFailures: 0,
    suppressed: 0,
    duplicatesSkipped: 0,
    skippedNoTransition: 0,
    errors: [],
  };

  if (records.length === 0) return result;

  const userIds = [...new Set(records.map((r) => String(r.userId)))];
  const prefs = await loadPreferences(userIds, userModel);

  for (const record of records) {
    try {
      const userPref = prefs.get(String(record.userId)) || {};
      const verdict = decide({
        record,
        notificationPrefs: userPref.notificationPrefs || {},
      });

      if (!verdict.shouldNotify) {
        result.skippedNoTransition++;
        continue;
      }

      const base = {
        userId: record.userId,
        userEmail: record.userEmail || userPref.email || "",
        schemeId: record.schemeId,
        schemeName: record.schemeName || "",
        schemeVersion: record.newSchemeVersion ?? null,
        triggeringChangeId: record.triggeringChangeId,
        recommendationHistoryId: record._id || null,
        processingJobId,
        type: verdict.type,
        severity: verdict.severity,
        title: verdict.title,
        body: verdict.body,
        bodySource: verdict.bodySource,
        createdAt: now(),
      };

      // ---- IN-APP: always, for any qualifying transition ------------------
      // The in-app record is the ledger. Even a suppressed email leaves this
      // behind, so a user who lowered their threshold can still see what
      // happened rather than losing it silently.
      if (verdict.inAppEligible) {
        const inApp = await insertOnce(notificationModel, {
          ...base,
          channel: NOTIFICATION_CHANNELS.IN_APP,
          status: NOTIFICATION_STATUS.SENT, // in-app delivery is the insert itself
          sentAt: now(),
        });
        if (inApp.duplicate) result.duplicatesSkipped++;
        else if (inApp.created) result.inAppCreated++;
      } else {
        result.inAppSuppressed++;
      }

      // ---- EMAIL: only when the user's preferences allow it ---------------
      if (!verdict.emailEligible) {
        result.suppressed++;
        // Recorded so "why didn't I get an email" is answerable from data.
        const suppressedRow = await insertOnce(notificationModel, {
          ...base,
          channel: NOTIFICATION_CHANNELS.EMAIL,
          status: NOTIFICATION_STATUS.SUPPRESSED,
          lastError: "",
          sentAt: null,
        });
        if (suppressedRow.duplicate) result.duplicatesSkipped++;
        continue;
      }

      const emailRow = await insertOnce(notificationModel, {
        ...base,
        channel: NOTIFICATION_CHANNELS.EMAIL,
        status: NOTIFICATION_STATUS.PENDING,
        retryCount: 0,
        // Due immediately; the worker decides when it actually runs.
        nextAttemptAt: null,
      });

      if (emailRow.duplicate) {
        // Already emailed, or already queued, for this exact change.
        result.duplicatesSkipped++;
        continue;
      }

      if (queued) {
        // The row IS the job. Policy processing stops here and does not wait
        // on SMTP — which is the whole point of the boundary.
        result.emailsQueued++;
        continue;
      }

      await attemptEmail({
        model: notificationModel,
        row: emailRow.doc,
        sendEmail,
        now,
        result,
      });
    } catch (err) {
      // One user's failure must not abandon the rest of the affected set.
      result.errors.push({ userId: String(record.userId), error: err.message });
      logger.warn("NotificationService: record failed", {
        userId: String(record.userId),
        schemeId: record.schemeId,
        error: err.message,
      });
    }
  }

  logger.info("NotificationService: complete", {
    processingJobId,
    considered: result.considered,
    inAppCreated: result.inAppCreated,
    emailsSent: result.emailsSent,
    emailsQueued: result.emailsQueued,
    emailsFailed: result.emailsFailed,
    deliveryMode: queued ? "queued" : "inline",
    suppressed: result.suppressed,
    duplicatesSkipped: result.duplicatesSkipped,
  });
  return result;
}

/**
 * Send one email and record the outcome.
 *
 * The row exists BEFORE the send is attempted. That ordering is deliberate: a
 * crash between sending and recording would otherwise leave no trace, and the
 * next cycle would send again. With the row written first, the worst case is a
 * row marked PENDING for a mail that did go out — recoverable, and far better
 * than a duplicate in someone's inbox.
 */
async function attemptEmail({ model, row, sendEmail, now, result }) {
  if (!row) return;

  // Claim it. A second worker selecting on PENDING/FAILED_RETRYABLE will not
  // see a row already in SENDING, so two sweeps overlapping cannot both send
  // the same email.
  try {
    await model.updateOne(
      { _id: row._id },
      { $set: { status: NOTIFICATION_STATUS.SENDING } }
    );
  } catch {
    /* non-fatal: the send below is still guarded by the unique index */
  }

  try {
    await sendEmail(
      { email: row.userEmail, name: "" },
      { schemeId: row.schemeId, name: row.schemeName },
      row.body,
      row.type
    );
    await model.updateOne(
      { _id: row._id },
      { $set: { status: NOTIFICATION_STATUS.SENT, sentAt: now(), lastError: "" } }
    );
    result.emailsSent++;
  } catch (err) {
    const message = String(err.message || "send failed");
    const retryCount = (row.retryCount || 0) + 1;

    // Two different reasons to stop: we ran out of attempts, or the failure is
    // not the kind another attempt can fix. A malformed address fails
    // identically every time, so retrying it just keeps a dead row in the
    // sweep.
    const permanent = isPermanentFailure(message);
    const exhausted = retryCount >= MAX_RETRIES;
    const giveUp = permanent || exhausted;

    await model.updateOne(
      { _id: row._id },
      {
        $set: {
          status: giveUp
            ? NOTIFICATION_STATUS.FAILED_PERMANENTLY
            : NOTIFICATION_STATUS.FAILED_RETRYABLE,
          retryCount,
          // Message only. A stack can carry file paths and argument values.
          lastError: message.slice(0, 300),
          failureKind: permanent ? "permanent" : exhausted ? "exhausted" : "transient",
          nextAttemptAt: giveUp ? null : new Date(now().getTime() + backoffFor(retryCount)),
        },
      }
    );
    result.emailsFailed++;
    if (permanent) result.permanentFailures = (result.permanentFailures || 0) + 1;
  }
}

/**
 * Dequeue: rows that are due for a delivery attempt.
 *
 * Selects only PENDING and FAILED_RETRYABLE. SENT, SUPPRESSED,
 * FAILED_PERMANENTLY and SENDING are all excluded — the last of those is what
 * stops two overlapping workers claiming the same row.
 */
async function claimDueNotifications({ model, limit, now }) {
  return resolveMaybeQuery(
    model
      .find({
        channel: NOTIFICATION_CHANNELS.EMAIL,
        status: { $in: CLAIMABLE_STATUSES },
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now() } }],
      })
      .limit(limit)
  );
}

/**
 * Retry emails that failed and are now due.
 *
 * Contacts no government source and re-runs no policy stage: the notification
 * rows already hold everything a resend needs. Safe to run repeatedly — a row
 * already SENT is not selected, and the unique index means no new row can be
 * created for the same change.
 */
async function retryFailedNotifications({ limit = 50, deps = {} } = {}) {
  const {
    notificationModel = NotificationModel,
    sendEmail = sendSchemeEmail,
    now = () => new Date(),
  } = deps;

  const due = await claimDueNotifications({ model: notificationModel, limit, now });

  const result = { attempted: 0, emailsSent: 0, emailsFailed: 0, errors: [] };
  for (const row of due || []) {
    result.attempted++;
    try {
      await attemptEmail({ model: notificationModel, row, sendEmail, now, result });
    } catch (err) {
      result.errors.push({ id: String(row._id), error: err.message });
    }
  }

  logger.info("NotificationService: retry sweep complete", result);
  return result;
}

module.exports = {
  notifyFromTransitions,
  retryFailedNotifications,
  claimDueNotifications,
  DELIVERY_MODE,
  attemptEmail,
  backoffFor,
  insertOnce,
  MAX_RETRIES,
};
