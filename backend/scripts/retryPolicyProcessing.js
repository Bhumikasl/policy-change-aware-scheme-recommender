#!/usr/bin/env node
/**
 * npm run policy:retry
 *
 * Re-runs the policy stages (H -> I -> J) for scheme changes whose analysis
 * previously failed. It contacts NO government source: everything it needs —
 * the diffs and the per-version snapshots — is already in SchemeHistory.
 *
 * Safe to run repeatedly. Each change keeps its deterministic
 * triggeringChangeId, so the unique index on RecommendationHistory rejects any
 * row a previous partial run already wrote.
 */
require("dotenv").config();
const connectDB = require("../src/config/db");
const { retryFailedPolicyProcessing } = require("../src/services/policyPipeline");
const logger = require("../src/utils/logger");

(async () => {
  await connectDB();
  const limit = Number(process.argv[2]) || 50;
  const results = await retryFailedPolicyProcessing({
    limit,
    jobId: `manual-retry-${Date.now()}`,
  });

  const recovered = results.filter((r) => r.status === "SUCCEEDED").length;
  const created = results.reduce((n, r) => n + r.historyCreated, 0);
  const skipped = results.reduce((n, r) => n + r.historySkipped, 0);

  logger.info("Retry sweep finished", {
    attempted: results.length,
    recovered,
    stillFailing: results.length - recovered,
    historyCreated: created,
    historySkipped: skipped,
  });
  console.log(
    `Attempted ${results.length}, recovered ${recovered}, still failing ` +
      `${results.length - recovered}. History rows created ${created}, skipped as duplicate ${skipped}.`
  );
  process.exit(results.length - recovered > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Retry sweep failed:", err.message);
  process.exit(1);
});
