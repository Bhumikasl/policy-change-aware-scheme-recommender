const SchemeHistoryModel = require("../models/SchemeHistory");
const SchemeModel = require("../models/Scheme");
const { classifyChange } = require("../agents/policyChangeAgent");
const { assessImpact } = require("../agents/policyImpactAgent");
const { propagateChange } = require("./recommendationPropagation");
const { notifyFromTransitions } = require("./notificationService");
const { indexScheme } = require("./ragIndexer");
const logger = require("../utils/logger");

/**
 * POLICY PIPELINE — the H -> I -> J orchestration stage.
 *
 * This is the seam between the existing collection cycle and the research
 * agents. services/pipeline.js calls processSchemeChange() at exactly one
 * point: after reconcile() has confirmed a material change and written the
 * SchemeHistory row. Everything upstream of that point is untouched.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE AND NOT INLINE IN pipeline.js
 * ---------------------------------------------------------------------------
 * Two reasons, both about failure.
 *
 * First, collection and policy analysis fail for unrelated causes and must be
 * reported separately. The government source being reachable and the scheme
 * being persisted is one fact; the impact agent completing is another. If the
 * scheme was collected and stored, the collection SUCCEEDED, even if the
 * analysis after it did not. Conflating them would make one flaky agent look
 * like a broken data feed, and would push someone toward re-fetching the whole
 * source to fix a problem that has nothing to do with it.
 *
 * Second, a failed analysis has to be retryable on its own. Because every
 * stage's status is written onto the SchemeHistory row for (schemeId,
 * version), retryFailedPolicyProcessing() can find and re-run exactly the
 * changes that failed, reading the stored snapshots — with no network call to
 * any government source.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY
 * ---------------------------------------------------------------------------
 * triggeringChangeId is `${schemeId}:v${version}` — deterministic, derived from
 * data that already uniquely identifies the change. That is deliberately NOT
 * the SchemeHistory _id: an ObjectId is generated fresh on insert, so if a
 * history row were ever rewritten the id would change and the same real-world
 * change would look new, defeating the unique index that stops duplicate
 * history. A composite of scheme and version cannot drift that way.
 *
 * Re-running this function for the same (schemeId, version) therefore produces
 * no additional RecommendationHistory rows — the unique index on
 * (userId, schemeId, triggeringChangeId) rejects them and propagateChange
 * counts them as duplicatesSkipped. That holds across process restart,
 * scheduler overlap, and manual retry.
 */

const STATUS = Object.freeze({
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});

/** Stable idempotency key for one scheme change. */
const changeIdFor = (schemeId, version) => `${schemeId}:v${version}`;

/**
 * The previous version's stored snapshot — the "before" the impact agent needs.
 *
 * This is why no migration was required for any of Phase I or J:
 * SchemeHistory.snapshot has always stored the full normalized document per
 * version, eligibilityRules included.
 */
async function loadPreviousSnapshot(schemeId, version, historyModel) {
  if (!version || version <= 1) return null;
  const prev = await historyModel
    .findOne({ schemeId, version: version - 1 })
    .then((d) => d || null);
  return prev?.snapshot || null;
}

/**
 * Run H -> I -> J for ONE confirmed scheme change.
 *
 * Never throws. The caller is the collection cycle, and a policy-analysis
 * failure must not be able to abort collection or mark it failed.
 *
 * @param {Object} opts
 * @param {Object} opts.result   reconcile() output: {type, schemeId, version, diffs, snapshot}
 * @param {string} opts.jobId    correlates every log line and history row in this cycle
 * @param {Object} [opts.deps]   injectable models/agents for tests
 * @returns {Promise<Object>} stage statuses and observability counters
 */
async function processSchemeChange({ result, jobId = "", deps = {} } = {}) {
  const {
    historyModel = SchemeHistoryModel,
    schemeModel = SchemeModel,
    changeAgent = classifyChange,
    impactAgent = assessImpact,
    propagate = propagateChange,
    notify = process.env.NOTIFICATIONS === "false" ? null : notifyFromTransitions,
    // RAG indexing is opt-out and defaults ON, but it is the ONE stage whose
    // absence changes nothing else: with it disabled the policy stages, the
    // audit trail and the notifications are all still exactly correct — the
    // knowledge base is simply not refreshed.
    ragIndex = process.env.RAG_INDEXING === "false" ? null : indexScheme,
    // The RAG chunk model, injectable.
    //
    // WITHOUT THIS the Phase M stage escaped the integration suite's model
    // boundary: indexScheme() defaults `deps.model` to the real Mongoose
    // SchemeChunk, and this call site passed no deps at all. With no database
    // connection mongoose BUFFERS create(), so the promise never settled — the
    // test timed out at 5 s and the buffered call then threw "import after the
    // Jest environment has been torn down".
    //
    // Left undefined (production, and every existing caller) indexScheme uses
    // the real model exactly as before. Nothing about production changes.
    ragChunkModel = undefined,
    // The notification model, injectable — the exact same defect one stage
    // earlier, and hidden behind it.
    //
    // `notifyFromTransitions()` defaults `deps.notificationModel` to the real
    // Mongoose Notification, and the `notify()` call below passes no `deps`.
    // Every cycle in the integration suite that did not override `notify`
    // wholesale therefore buffered `Notification.findOne` against a database
    // that was never connected. It only surfaced once the RAG escape above was
    // closed, because the RAG stage ran first and killed the test before the
    // notification stage was ever reached.
    //
    // Left undefined (production, and every existing caller) the real model is
    // used exactly as before.
    notificationModel = undefined,
    useLlm = process.env.POLICY_CHANGE_LLM !== "false",
  } = deps;

  const started = Date.now();
  const isNew = result?.type === "NEW";
  const schemeId = result?.schemeId;
  const newVersion = result?.version ?? null;
  const oldVersion = isNew ? null : newVersion != null ? newVersion - 1 : null;
  const triggeringChangeId = changeIdFor(schemeId, newVersion);

  // Structured, and deliberately free of anything personal: ids and counts
  // only. No emails, no profile values, no credentials.
  const record = {
    jobId,
    schemeId,
    oldVersion,
    newVersion,
    changeId: triggeringChangeId,
    isNew,
    changeType: null,
    severity: null,
    candidateSelection: null,
    scannedEveryUser: null,
    narrowingProven: null,
    completenessGuaranteed: null,
    affectedUserCount: 0,
    propagationCount: 0,
    historyCreated: 0,
    historySkipped: 0,
    // Notification counters live beside the policy ones but are NEVER folded
    // into policyImpactStatus/propagationStatus. An SMTP outage is not a
    // failed policy propagation, and treating it as one would send the retry
    // sweep re-running analysis that succeeded.
    notificationsCreated: 0,
    notificationsEmailed: 0,
    notificationsSuppressed: 0,
    notificationsFailed: 0,
    notificationStatus: STATUS.PENDING,
    // PHASE R. `null` rather than 0 until the stage runs: 0 would read as
    // "delivery was instant" when it means "delivery never happened".
    notificationDurationMs: null,
    policyImpactStatus: STATUS.PENDING,
    propagationStatus: STATUS.PENDING,
    // ---- Phase M: RAG indexing, tracked entirely separately ----------------
    // The knowledge base going stale is a DIFFERENT kind of failure from the
    // eligibility decision being wrong, and conflating them would be actively
    // harmful in both directions: a failed embedding call would send the retry
    // sweep re-running propagation that already succeeded, and a genuinely
    // failed propagation would look survivable because the index refreshed.
    // So RAG gets its own status, its own error list and its own retry flag,
    // and none of them feed `record.status` or `record.retryable`.
    ragIndexStatus: STATUS.PENDING,
    ragChunksIndexed: 0,
    ragChunksSuperseded: 0,
    ragEmbeddingDegraded: false,
    ragRetryable: false,
    ragErrors: [],
    ragDurationMs: 0,
    retryable: false,
    errors: [],
    durationMs: 0,
    status: STATUS.PENDING,
  };

  // ---- STAGE H: classify the change ---------------------------------------
  let changeVerdict = null;
  try {
    changeVerdict = await changeAgent(result?.diffs || [], {
      isNew,
      useLlm,
      schemeName: result?.snapshot?.name || "",
    });
    record.changeType = changeVerdict.changeType;
    record.severity = changeVerdict.severity;
  } catch (err) {
    // classifyChange already swallows LLM failures internally, so reaching
    // here means something structural broke. Both downstream stages depend on
    // the verdict, so neither can run — but collection still succeeded.
    record.policyImpactStatus = STATUS.FAILED;
    record.propagationStatus = STATUS.FAILED;
    record.retryable = true;
    record.status = STATUS.FAILED;
    record.errors.push({ stage: "policyChange", error: err.message });
    await persistStatus(historyModel, schemeId, newVersion, record);
    logger.error("Policy pipeline: change classification failed", redactable(record));
    return finish(record, started);
  }

  // ---- STAGE I: who is affected -------------------------------------------
  let impact = null;
  // Hoisted so the RAG stage below can index the same document the policy
  // stages reasoned about. Indexing a DIFFERENT read of the scheme would let
  // the knowledge base and the eligibility decision describe two versions.
  let scheme = null;
  try {
    const oldSnapshot = await loadPreviousSnapshot(schemeId, newVersion, historyModel);
    scheme =
      (await schemeModel.findOne({ schemeId }).then((d) => d || null)) || result?.snapshot;

    impact = await impactAgent({
      scheme,
      oldRules: oldSnapshot?.eligibilityRules || {},
      oldSchemeSnapshot: oldSnapshot,
      diffs: result?.diffs || [],
      changeVerdict,
      isNew,
    });

    record.candidateSelection = impact.candidateSelection;
    record.scannedEveryUser = impact.scannedEveryUser;
    record.narrowingProven = impact.narrowingProven;
    record.completenessGuaranteed = impact.completenessGuaranteed;
    record.affectedUserCount = impact.impacts.length;
    record.policyImpactStatus = STATUS.SUCCEEDED;

    // ---- STAGE J: propagate into recommendations --------------------------
    // Nested inside the same try only for the shared `scheme`/`oldSnapshot`;
    // its own catch below keeps the two statuses independent.
    try {
      const prop = await propagate({
        scheme,
        oldSnapshot,
        isNew,
        diffs: result?.diffs || [],
        changeVerdict,
        impact,
        triggeringChangeId,
        processingJobId: jobId,
      });
      record.propagationCount = prop.usersConsidered;
      record.historyCreated = prop.recordsWritten;
      record.historySkipped = prop.duplicatesSkipped;
      if (prop.errors.length > 0) {
        // Partial failure: some users were recorded, some were not. Marking
        // this SUCCEEDED would lose the ones that were not.
        record.propagationStatus = STATUS.FAILED;
        record.retryable = true;
        record.errors.push(...prop.errors.map((e) => ({ stage: `propagation:${e.stage}`, error: e.error })));
      } else {
        record.propagationStatus = STATUS.SUCCEEDED;
      }

      // ---- STAGE L: notify, from the transitions just recorded ------------
      // Consumes prop.records — the users the Impact Agent selected, filtered
      // to those whose recommendation state actually moved. No user scan.
      //
      // Its own try/catch, and its own status: notification is downstream of
      // the audit trail and must not be able to invalidate it.
      if (notify) {
        // PHASE R. The notification stage is the ONE stage whose cost was never
        // recorded, and NOTIFICATION_ARCHITECTURE.md defers the decision about
        // adopting a message broker to a measurement that needs exactly this
        // number: "Revisit when a measured collection cycle spends a material
        // fraction of its time in delivery... That measurement belongs to
        // Phase R and has not been taken."
        //
        // It could not be taken, because nothing recorded it. `durationMs` and
        // `ragDurationMs` existed; the delivery stage had no clock on it at all.
        const notifyStarted = Date.now();
        try {
          const sent = await notify({
            records: prop.records || [],
            processingJobId: jobId,
            // Forwarded only when injected. `notifyFromTransitions` falls back
            // to the real Notification model when `deps.notificationModel` is
            // absent, so production is untouched and tests get the in-memory
            // collection.
            ...(notificationModel ? { deps: { notificationModel } } : {}),
          });
          record.notificationsCreated = sent.inAppCreated;
          record.notificationsEmailed = sent.emailsSent;
          record.notificationsSuppressed = sent.suppressed;
          record.notificationsFailed = sent.emailsFailed + sent.errors.length;
          record.notificationStatus =
            record.notificationsFailed > 0 ? STATUS.FAILED : STATUS.SUCCEEDED;
        } catch (err) {
          record.notificationStatus = STATUS.FAILED;
          logger.warn("Policy pipeline: notification stage failed", {
            jobId,
            schemeId,
            error: err.message,
          });
        } finally {
          // In `finally`, so a delivery stage that FAILED still reports what it
          // cost. A timing figure that only covers the successful runs would
          // understate exactly the case the broker decision cares about.
          record.notificationDurationMs = Date.now() - notifyStarted;
        }
      } else {
        record.notificationStatus = STATUS.SKIPPED;
      }
    } catch (err) {
      record.propagationStatus = STATUS.FAILED;
      record.retryable = true;
      record.errors.push({ stage: "propagation", error: err.message });
    }
  } catch (err) {
    record.policyImpactStatus = STATUS.FAILED;
    // Propagation consumes the impact result, so it cannot run without one.
    record.propagationStatus = STATUS.SKIPPED;
    record.retryable = true;
    record.errors.push({ stage: "policyImpact", error: err.message });
  }

  // ---- STAGE M: refresh the RAG knowledge base ----------------------------
  //
  // Runs LAST and OUTSIDE the policy try/catch, deliberately.
  //
  // Last, because the policy decision, the audit trail and the notification
  // are the things a person acts on, and none of them read from the vector
  // index. Outside, because the whole point of a separate status is that this
  // stage cannot reach `record.errors`, `record.retryable` or `record.status`
  // — if it could, an embedding provider outage would mark a perfectly good
  // propagation as needing a retry.
  //
  // The failure this prevents is specific: a scheme whose income ceiling just
  // changed, whose eligibility recomputed correctly, whose users were
  // correctly notified — and whose assistant keeps quoting the old ceiling
  // because nobody invalidated the chunk.
  if (!ragIndex) {
    record.ragIndexStatus = STATUS.SKIPPED;
  } else if (!scheme) {
    // Stage I never got far enough to read the scheme. Nothing to index; the
    // policy retry will bring us back here.
    record.ragIndexStatus = STATUS.SKIPPED;
  } else {
    const ragStarted = Date.now();
    try {
      const indexed = await indexSchemeSafely(ragIndex, {
        scheme: typeof scheme.toObject === "function" ? scheme.toObject() : scheme,
        changeType: isNew ? "NEW" : "UPDATED",
        // Forwarded only when injected. `indexScheme` falls back to the real
        // SchemeChunk model when `deps.model` is absent, so production is
        // untouched and tests get the in-memory collection.
        ...(ragChunkModel ? { deps: { model: ragChunkModel } } : {}),
      });
      record.ragChunksIndexed = indexed.chunksIndexed || 0;
      record.ragChunksSuperseded = indexed.chunksSuperseded || 0;
      record.ragEmbeddingDegraded = !!indexed.embeddingDegraded;
      record.ragErrors = (indexed.errors || []).map((e) => ({
        stage: `rag:${e.stage}`,
        error: String(e.error).slice(0, 500),
      }));
      record.ragIndexStatus =
        indexed.status === "INDEXED"
          ? STATUS.SUCCEEDED
          : indexed.status === "SKIPPED"
          ? STATUS.SKIPPED
          : STATUS.FAILED;
      record.ragRetryable = record.ragIndexStatus === STATUS.FAILED;
    } catch (err) {
      // indexScheme is written not to throw. This catch exists because
      // "written not to throw" is a claim about today's code, and the cost of
      // being wrong is a failed policy cycle.
      record.ragIndexStatus = STATUS.FAILED;
      record.ragRetryable = true;
      record.ragErrors.push({ stage: "rag:unexpected", error: String(err.message).slice(0, 500) });
      logger.warn("Policy pipeline: RAG indexing threw unexpectedly", {
        jobId,
        schemeId,
        version: newVersion,
        error: err.message,
      });
    }
    record.ragDurationMs = Date.now() - ragStarted;
  }

  // Deliberately excludes notificationStatus AND ragIndexStatus. `status`
  // answers "did the policy analysis succeed", and the retry sweep keys off
  // `retryable`, which only the policy stages set. A failed email is retried by
  // the notification sweep; a failed index by the RAG sweep — neither by
  // re-running the agents.
  record.status =
    record.policyImpactStatus === STATUS.SUCCEEDED && record.propagationStatus === STATUS.SUCCEEDED
      ? STATUS.SUCCEEDED
      : STATUS.FAILED;

  await persistStatus(historyModel, schemeId, newVersion, record);

  const line = redactable(record);
  if (record.status === STATUS.SUCCEEDED) logger.info("Policy pipeline: processed", line);
  else logger.error("Policy pipeline: stage failed", line);

  return finish(record, started);
}

function finish(record, started) {
  record.durationMs = Date.now() - started;
  return record;
}

/** Normalises the indexer's return shape so a stub cannot crash the stage. */
async function indexSchemeSafely(ragIndex, args) {
  const out = await ragIndex(args);
  return out && typeof out === "object" ? out : { status: "FAILED", errors: [{ stage: "input", error: "indexer returned no result" }] };
}

/**
 * Only ids, counts and statuses reach the log. No email, no profile field, no
 * connection string, no key. The impact result carries user emails; they are
 * deliberately not copied here.
 */
function redactable(r) {
  return {
    jobId: r.jobId,
    schemeId: r.schemeId,
    oldVersion: r.oldVersion,
    newVersion: r.newVersion,
    changeId: r.changeId,
    changeType: r.changeType,
    severity: r.severity,
    candidateSelection: r.candidateSelection,
    scannedEveryUser: r.scannedEveryUser,
    narrowingProven: r.narrowingProven,
    completenessGuaranteed: r.completenessGuaranteed,
    affectedUserCount: r.affectedUserCount,
    propagationCount: r.propagationCount,
    historyCreated: r.historyCreated,
    historySkipped: r.historySkipped,
    notificationsCreated: r.notificationsCreated,
    notificationsEmailed: r.notificationsEmailed,
    notificationsSuppressed: r.notificationsSuppressed,
    notificationsFailed: r.notificationsFailed,
    notificationStatus: r.notificationStatus,
    notificationDurationMs: r.notificationDurationMs,
    policyImpactStatus: r.policyImpactStatus,
    propagationStatus: r.propagationStatus,
    ragIndexStatus: r.ragIndexStatus,
    ragChunksIndexed: r.ragChunksIndexed,
    ragChunksSuperseded: r.ragChunksSuperseded,
    ragEmbeddingDegraded: r.ragEmbeddingDegraded,
    ragRetryable: r.ragRetryable,
    ragErrorCount: r.ragErrors.length,
    retryable: r.retryable,
    errorCount: r.errors.length,
    durationMs: r.durationMs,
    status: r.status,
  };
}

/**
 * Stamp the stage outcome onto the SchemeHistory row for this version.
 *
 * That row is the natural home: it already exists per change, is keyed by the
 * same (schemeId, version) pair, and holds the snapshots a retry needs. It is
 * also what makes "find everything that needs retrying" a single indexed query
 * rather than a log grep.
 *
 * A failure to persist status must not itself fail the cycle.
 */
async function persistStatus(historyModel, schemeId, version, record) {
  if (!schemeId || version == null) return;
  try {
    await historyModel.updateOne(
      { schemeId, version },
      {
        $set: {
          policyProcessing: {
            jobId: record.jobId,
            changeId: record.changeId,
            changeType: record.changeType,
            severity: record.severity,
            candidateSelection: record.candidateSelection,
            scannedEveryUser: record.scannedEveryUser,
            narrowingProven: record.narrowingProven,
            completenessGuaranteed: record.completenessGuaranteed,
            affectedUserCount: record.affectedUserCount,
            historyCreated: record.historyCreated,
            historySkipped: record.historySkipped,
            durationMs: Date.now() - (Date.now() - record.durationMs),
            processedAt: new Date(),
            // Message only — no stack, which can carry file paths and values.
            errors: record.errors.map((e) => ({ stage: e.stage, error: String(e.error).slice(0, 500) })),
          },
          policyImpactStatus: record.policyImpactStatus,
          propagationStatus: record.propagationStatus,
          policyRetryable: record.retryable,
          // Stored beside the policy statuses but never merged into them, so
          // "which changes need the agents re-run" and "which schemes have a
          // stale knowledge base" stay two separate indexed queries.
          ragIndexStatus: record.ragIndexStatus,
          ragIndexRetryable: record.ragRetryable,
          ragIndexing: {
            chunksIndexed: record.ragChunksIndexed,
            chunksSuperseded: record.ragChunksSuperseded,
            embeddingDegraded: record.ragEmbeddingDegraded,
            durationMs: record.ragDurationMs,
            indexedAt: new Date(),
            errors: record.ragErrors,
          },
        },
      }
    );
  } catch (err) {
    logger.warn("Policy pipeline: could not persist stage status", {
      schemeId,
      version,
      error: err.message,
    });
  }
}

/**
 * Re-run the policy stages for changes that failed, WITHOUT recollecting.
 *
 * Everything needed is already stored: SchemeHistory holds the diffs and the
 * snapshot for each version. No government source is contacted. Safe to run
 * repeatedly — the same triggeringChangeId means the unique index rejects any
 * history row a previous partial run already wrote.
 */
async function retryFailedPolicyProcessing({ limit = 50, jobId = "", deps = {} } = {}) {
  const { historyModel = SchemeHistoryModel } = deps;
  const failed = await historyModel
    .find({ policyRetryable: true })
    .limit(limit)
    .then((rows) => rows || []);

  const results = [];
  for (const row of failed) {
    results.push(
      await processSchemeChange({
        result: {
          type: row.eventType === "CREATED" ? "NEW" : "UPDATED",
          schemeId: row.schemeId,
          version: row.version,
          diffs: row.diffs || [],
          snapshot: row.snapshot,
        },
        jobId: jobId || `retry-${row.schemeId}-v${row.version}`,
        deps,
      })
    );
  }

  logger.info("Policy pipeline: retry sweep complete", {
    jobId,
    attempted: results.length,
    recovered: results.filter((r) => r.status === STATUS.SUCCEEDED).length,
  });
  return results;
}

module.exports = {
  processSchemeChange,
  retryFailedPolicyProcessing,
  changeIdFor,
  loadPreviousSnapshot,
  STATUS,
};
