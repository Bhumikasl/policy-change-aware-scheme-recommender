#!/usr/bin/env node
/**
 * Diagnostic: for a given user, break down /matches results by rule
 * source and by which positive signals earned each scheme its spot.
 *
 * Answers questions like:
 *   - "Why am I getting 650 matches?"
 *   - "How many of those come from unparsed rules vs LLM-extracted?"
 *   - "Which rules are doing the actual work — state? tags? gender?"
 *   - "Which schemes are matching on tag overlap only (weakest signal)?"
 *
 * Usage:
 *   node src/scripts/analyzeMatches.js <email>
 *   node src/scripts/analyzeMatches.js <email> --sample 20
 *
 * With --sample N, prints N example schemes from each bucket so you can
 * eyeball whether the matches look right.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/User");
const Scheme = require("../models/Scheme");
const { evaluateEligibility } = require("../services/notifier");

function bucketName(verdict) {
  if (!verdict.eligible) return null;
  if (verdict.mode === "legacy") return "legacy-tag-or-state";
  const rules = new Set(verdict.positiveMatches.map((m) => m.rule));
  if (rules.has("age") || rules.has("annualIncome") || rules.has("education") || rules.has("marks")) {
    return "strong-personal-attr";
  }
  if (rules.has("gender") || rules.has("category") || rules.has("occupation")) {
    return "demographic-targeted";
  }
  if (rules.has("state")) return "state-only";
  if (rules.has("tags")) return "tags-only";
  return "other";
}

async function main() {
  const email = process.argv[2];
  const sampleFlag = process.argv.indexOf("--sample");
  const sampleN = sampleFlag > -1 ? parseInt(process.argv[sampleFlag + 1], 10) || 5 : 5;

  if (!email) {
    console.error("Usage: node src/scripts/analyzeMatches.js <email> [--sample N]");
    process.exit(1);
  }

  await connectDB();
  const user = await User.findOne({ email });
  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  console.log("\n=== USER PROFILE ===");
  console.log(JSON.stringify(user.profile, null, 2));

  const schemes = await Scheme.find({ status: "Active" });
  console.log(`\n=== SCANNING ${schemes.length} active schemes ===`);

  const bySource = { structured: 0, "llm-extracted": 0, unparsed: 0 };
  const byBucket = {};
  const buckets = {};
  const failsBySource = { structured: 0, "llm-extracted": 0, unparsed: 0 };
  let eligibleCount = 0;

  for (const scheme of schemes) {
    const src = scheme.eligibilityRules?.source || "unparsed";
    bySource[src] = (bySource[src] || 0) + 1;
    const v = evaluateEligibility(user, scheme);
    if (!v.eligible) {
      failsBySource[src] = (failsBySource[src] || 0) + 1;
      continue;
    }
    eligibleCount += 1;
    const b = bucketName(v);
    byBucket[b] = (byBucket[b] || 0) + 1;
    if (!buckets[b]) buckets[b] = [];
    if (buckets[b].length < sampleN) {
      buckets[b].push({
        schemeId: scheme.schemeId,
        name: scheme.name,
        state: scheme.state,
        source: src,
        confidence: scheme.eligibilityRules?.confidence,
        positive: v.positiveMatches.map((m) => `${m.rule}=${m.reason}`),
      });
    }
  }

  console.log("\n=== SCHEMES BY RULE SOURCE ===");
  console.table(bySource);

  console.log(`\n=== ELIGIBLE: ${eligibleCount} / ${schemes.length} ===`);

  console.log("\n=== ELIGIBLE MATCHES BY BUCKET ===");
  console.table(byBucket);
  console.log("Bucket meanings:");
  console.log("  strong-personal-attr — matched on age/income/education/marks (strongest)");
  console.log("  demographic-targeted — matched on gender/category/occupation");
  console.log("  state-only           — only state matched (weak)");
  console.log("  tags-only            — legacy-mode tag overlap (weakest structural signal)");
  console.log("  legacy-tag-or-state  — unparsed scheme, matched via legacy path");

  console.log("\n=== SAMPLES PER BUCKET ===");
  for (const [b, entries] of Object.entries(buckets)) {
    console.log(`\n--- ${b} (${byBucket[b]} total, showing ${entries.length}) ---`);
    for (const e of entries) {
      console.log(`• ${e.name}`);
      console.log(`  id=${e.schemeId} state=${e.state} source=${e.source} conf=${e.confidence}`);
      console.log(`  matched: ${e.positive.join(" | ")}`);
    }
  }

  console.log("\n=== INTERPRETATION HINTS ===");
  if (bySource.unparsed > schemes.length * 0.5) {
    console.log("• More than half your schemes are 'unparsed' — run:");
    console.log("     SCHEMES_TO_EXTRACT=200 npm run backfill:eligibility:llm");
    console.log("  to get real structured rules on them via Gemini.");
  }
  if ((byBucket["tags-only"] || 0) + (byBucket["legacy-tag-or-state"] || 0) > eligibleCount * 0.5) {
    console.log("• Most matches come from tag/state alone — nothing checked age/income/education.");
    console.log("  This means LLM extraction hasn't run on them yet, OR the eligibility text");
    console.log("  is thin. Run the LLM backfill to tighten these.");
  }
  if ((byBucket["strong-personal-attr"] || 0) === 0) {
    console.log("• Zero schemes matched on age/income/education/marks — either your profile is");
    console.log("  missing those fields, or no scheme has those rules extracted yet.");
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("analyzeMatches failed:", err);
  process.exit(1);
});
