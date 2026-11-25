const { extractHybrid } = require("./hybridExtractor");
const { normalize, normalizeEligibilityRules } = require("../normalizer/normalizer");
const { reconcile } = require("./comparator");
const { processSchemeChange } = require("./policyPipeline");
const collectorsModule = require("../collectors");
const aiSummaryModule = require("./aiSummary");
const notifierModule = require("./notifier");
const logger = require("../utils/logger");

async function maybeEnrichWithHybrid(rawScheme, options = {}) {
  try {
    if (!rawScheme.eligibility || typeof rawScheme.eligibility !== "string" || !rawScheme.eligibility.trim()) {
      rawScheme.eligibilityRules = normalizeEligibilityRules(rawScheme.eligibilityRules || {});
      return rawScheme;
    }

    const textToExtract = [
      rawScheme.eligibility || "",
      rawScheme.description || "",
      rawScheme.name || "",
    ].join("\n");

    const useLlm = options.extractLlm ?? (process.env.LLM_EXTRACT_ELIGIBILITY === "true");
    const hybridExtracted = await extractHybrid(textToExtract, {
      useLlm,
    });

    const { validateEligibilityRules } = require("./eligibilityValidator");
    const validation = validateEligibilityRules(textToExtract, hybridExtracted, rawScheme);

    const mergedRules = {
      ...(rawScheme.eligibilityRules || {}),
      minAge: hybridExtracted.minAge ?? null,
      maxAge: hybridExtracted.maxAge ?? null,
      minAnnualIncome: hybridExtracted.minAnnualIncome ?? null,
      maxAnnualIncome: hybridExtracted.maxAnnualIncome ?? null,
      minMarksPercentage: hybridExtracted.minMarksPercentage ?? null,
      minEducationLevel: hybridExtracted.minEducationLevel ?? null,
      maxEducationLevel: hybridExtracted.maxEducationLevel ?? null,
      genders: hybridExtracted.genders || [],
      categories: hybridExtracted.categories || [],
      categoryGroups: hybridExtracted.categoryGroups || [],
      occupations: hybridExtracted.occupations || [],
      states: hybridExtracted.states || [],
      courses: hybridExtracted.courses || [],
      applicantTypes: validation.applicantTypes || hybridExtracted.applicantTypes || [],
      disabilityRequired: hybridExtracted.disabilityRequired ?? null,
      minDisabilityPercentage: hybridExtracted.minDisabilityPercentage ?? null,
      singleGirlChildRequired: hybridExtracted.singleGirlChildRequired ?? null,
      eligibilityType: validation.eligibilityType || hybridExtracted.eligibilityType || "unknown",
      source: hybridExtracted.source || "hybrid",
      confidence: validation.isValid ? (hybridExtracted.confidence ?? 1.0) : Math.min(hybridExtracted.confidence ?? 0.5, 0.4),
      needsReview: validation.needsReview || (hybridExtracted.needsReview ?? false),
      extractedAt: new Date(),
    };

    rawScheme.eligibilityRules = normalizeEligibilityRules(mergedRules);
    return rawScheme;
  } catch (error) {
    logger.error(`[Pipeline] Enrichment failed for scheme ${rawScheme.schemeId || rawScheme.name}:`, { error: error.message });
    rawScheme.eligibilityRules = normalizeEligibilityRules(rawScheme.eligibilityRules || {});
    return rawScheme;
  }
}

async function runCollectionCycle(options = {}) {
  const {
    jobId = `cycle-${Date.now()}`,
    deps = {},
  } = options;

  const collectors = deps.collectors || collectorsModule;
  const reconcileFn = deps.reconcile || reconcile;
  const processChangeFn = deps.processSchemeChange || processSchemeChange;
  const normalizeFn = deps.normalize || normalize;
  const aiSummary = deps.aiSummary || aiSummaryModule;
  const notifier = deps.notifier || notifierModule;
  const log = deps.logger || logger;
  const legacyNotifierEnabled = deps.legacyNotifierEnabled ?? (process.env.LEGACY_NOTIFIER === "true");

  log.info(`[Pipeline] Starting collection cycle jobId=${jobId}`);
  const items = await collectors.collectAll();

  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let failedCount = 0;
  let historyCreated = 0;
  let affectedUsersCount = 0;
  let policyProcessedCount = 0;
  let policyImpactFailedCount = 0;
  let propagationFailed = 0;
  let legacyNotificationsSent = 0;
  let legacyNotificationsSuppressed = 0;
  let errors = [];

  for (const item of items) {
    try {
      const raw = { ...item.raw };
      await maybeEnrichWithHybrid(raw);
      const normalized = normalizeFn(raw, item.source);
      const changeResult = await reconcileFn(normalized);

      if (changeResult.type === "NEW") {
        newCount++;
        policyProcessedCount++;
        const runStages = deps.runPolicyStages || processChangeFn;
        const policyRecord = await runStages({ result: changeResult, jobId, deps });
        if (policyRecord) {
          historyCreated += policyRecord.historyCreated || 0;
          affectedUsersCount += policyRecord.affectedUserCount || 0;
          if (policyRecord.policyImpactStatus === "FAILED") policyImpactFailedCount++;
          if (policyRecord.propagationStatus === "FAILED") propagationFailed++;
        }
        if (legacyNotifierEnabled) {
          legacyNotificationsSent += await notifier.notifyMatchingUsers(changeResult);
        } else {
          legacyNotificationsSuppressed++;
        }
      } else if (changeResult.type === "UPDATED") {
        updatedCount++;
        policyProcessedCount++;
        const runStages = deps.runPolicyStages || processChangeFn;
        const policyRecord = await runStages({ result: changeResult, jobId, deps });
        if (policyRecord) {
          historyCreated += policyRecord.historyCreated || 0;
          affectedUsersCount += policyRecord.affectedUserCount || 0;
          if (policyRecord.policyImpactStatus === "FAILED") policyImpactFailedCount++;
          if (policyRecord.propagationStatus === "FAILED") propagationFailed++;
        }
        if (legacyNotifierEnabled) {
          legacyNotificationsSent += await notifier.notifyMatchingUsers(changeResult);
        } else {
          legacyNotificationsSuppressed++;
        }
      } else {
        unchangedCount++;
      }
    } catch (err) {
      failedCount++;
      log.error(`[Pipeline] Error processing scheme item:`, { error: err.message });
      errors.push({ error: err.message, item });
    }
  }

  const policyStatus =
    policyImpactFailedCount > 0 || propagationFailed > 0
      ? "PARTIAL"
      : "SUCCEEDED";

  log.info(`[Pipeline] Completed collection cycle jobId=${jobId}`, {
    total: items.length,
    new: newCount,
    updated: updatedCount,
    unchanged: unchangedCount,
    failed: failedCount,
    errors: errors.length,
  });

  return {
    jobId,
    total: items.length,
    new: newCount,
    inserted: newCount,
    updated: updatedCount,
    unchanged: unchangedCount,
    failed: failedCount,
    errors,
    collectionStatus: "SUCCEEDED",
    historyCreated,
    affectedUsers: affectedUsersCount,
    policyProcessed: policyProcessedCount,
    policyImpactFailed: policyImpactFailedCount,
    policyStatus,
    propagationFailed,
    legacyNotifierEnabled,
    legacyNotificationsSent,
    legacyNotificationsSuppressed,
  };
}

module.exports = {
  maybeEnrichWithHybrid,
  runCollectionCycle,
};