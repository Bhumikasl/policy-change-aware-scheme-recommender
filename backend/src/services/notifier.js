const User = require("../models/User");
const NotificationLog = require("../models/NotificationLog");
const logger = require("../utils/logger");
const { sendSchemeEmail } = require("./mailer");
const { evaluateEligibility, isMatch, getDocumentReadiness } = require("./matcher");

/**
 * Notify matching users. Dedup via NotificationLog on (email, schemeId,
 * version, channel) — same version, same user, no duplicate email.
 *
 * A scheme with eligibilityType === "unknown" is NOT emailed to anyone —
 * we don't spam people about schemes we can't verify they qualify for.
 * Universal and constrained schemes both go out; the matcher's verdict
 * decides who receives.
 */
async function notifyMatchingUsers(scheme, summary, eventType, version, deps = {}) {
  // PHASE R. `deps` is additive and defaults to the real models, so production
  // behaviour is unchanged.
  //
  // WHY IT WAS ADDED: this function is the BASELINE the Phase R experiment
  // measures the targeted flow against — the pre-Phase-I path that scanned
  // every user on every version bump. Measuring it means running it over a
  // corpus population, and it previously reached `User` and `NotificationLog`
  // through hardcoded imports with no seam at all. That is the same
  // model-boundary escape that made the RAG and notification stages hang the
  // integration suite: with no connection mongoose does not throw, it BUFFERS,
  // and the caller waits out `bufferTimeoutMS`.
  //
  // It is also why the integration suites `jest.mock` this whole module rather
  // than inject into it — which means the REAL baseline is never exercised, so
  // a regression in it would go unseen.
  const {
    userModel = User,
    logModel = NotificationLog,
    sendEmail = sendSchemeEmail,
  } = deps;

  if (scheme?.eligibilityRules?.eligibilityType === "unknown") {
    logger.info(`Skipping notifications for ${scheme.schemeId} — eligibilityType=unknown`);
    return 0;
  }

  // The full scan this path is named for, and what Phase R measures.
  const users = await userModel.find({});
  const matched = users.filter((u) => isMatch(u, scheme));

  let sent = 0;
  let skipped = 0;

  for (const user of matched) {
    try {
      await logModel.create({
        email: user.email,
        schemeId: scheme.schemeId,
        version,
        eventType,
        channel: "email",
      });
    } catch (err) {
      if (err && err.code === 11000) {
        skipped += 1;
        continue;
      }
      logger.warn(`NotificationLog insert failed for ${user.email}`, { error: err.message });
      continue;
    }

    logger.info(`[NOTIFY -> ${user.email}] (${eventType} v${version}) ${scheme.name}: ${summary}`);
    try {
      await sendEmail(user, scheme, summary, eventType);
    } catch (err) {
      logger.warn(`sendSchemeEmail failed for ${user.email} — continuing pipeline`, { error: err.message });
    }
    sent += 1;
  }

  if (skipped > 0) {
    logger.info(`Dedup: skipped ${skipped} already-notified user(s) for ${scheme.schemeId} v${version}`);
  }
  return sent;
}

module.exports = {
  notifyMatchingUsers,
  isMatch,
  evaluateEligibility,
  getDocumentReadiness,
};
