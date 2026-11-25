require("dotenv").config();
const mongoose = require("mongoose");
const Scheme = require("../models/Scheme");
const { extractHybrid } = require("../services/hybridExtractor");
const { normalizeEligibilityRules } = require("../normalizer/normalizer");
const connectDB = require("../config/db");
const logger = require("../utils/logger");

async function runBackfill() {
  await connectDB();
  logger.info("[Backfill] Starting full eligibility backfill...");

  const batchSize = Number(process.env.BATCH_SIZE) || 100;
  const maxSchemes = process.env.SCHEMES_TO_EXTRACT ? Number(process.env.SCHEMES_TO_EXTRACT) : null;

  let query = Scheme.find({});
  if (maxSchemes) {
    query = query.limit(maxSchemes);
  }

  const cursor = query.batchSize(batchSize).cursor();
  let total = 0;
  let updated = 0;

  for (let scheme = await cursor.next(); scheme != null; scheme = await cursor.next()) {
    total++;

    const textToExtract = [
      scheme.eligibility || "",
      scheme.description || "",
      scheme.name || "",
    ].join("\n");

    const hybridResult = await extractHybrid(textToExtract, {
      rules: scheme.eligibilityRules || {},
      useLlm: process.argv.includes("--extract-llm") || process.env.LLM_EXTRACT_ELIGIBILITY === "true",
    });

    const normalized = normalizeEligibilityRules({
      ...(scheme.eligibilityRules?.toObject?.() || scheme.eligibilityRules || {}),
      ...hybridResult,
      extractedAt: new Date(),
    });

    if (normalized.states.length === 0 && scheme.state && scheme.state !== "All India") {
      normalized.states = [scheme.state];
    }

    await Scheme.updateOne(
      { _id: scheme._id },
      { $set: { eligibilityRules: normalized } }
    );

    updated++;
    if (total % 250 === 0) {
      logger.info(`[Backfill] Processed ${total} schemes...`);
    }
  }

  logger.info(`[Backfill] Finished! Total: ${total}, Updated: ${updated}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  runBackfill().catch((err) => {
    logger.error("[Backfill] Fatal error:", { error: err.message });
    process.exit(1);
  });
}

module.exports = { runBackfill };