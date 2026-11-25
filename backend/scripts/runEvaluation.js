#!/usr/bin/env node
/**
 * PHASE O — evaluation runner.
 *
 *   node scripts/runEvaluation.js                # question set + experiment
 *   node scripts/runEvaluation.js --stale-only   # just the stale-answer study
 *   node scripts/runEvaluation.js --json out.json
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PRODUCES, AND WHAT IT WILL REFUSE TO PRODUCE
 * ---------------------------------------------------------------------------
 * It runs the real agent over the labelled question set and prints measured
 * aggregates. It does not invent anything: a metric with no observations
 * prints "not measured", and retrieval-quality figures are WITHHELD entirely
 * when the embedding provider is `local-hash`, because those would be word
 * overlap rather than semantics.
 *
 * To get retrieval-quality numbers you need three things this script cannot
 * supply for you:
 *   1. EMBEDDING_PROVIDER=gemini (or ollama), and a re-index — existing
 *      local-hash vectors are not comparable and must be discarded;
 *   2. relevance labels in src/evaluation/questionSet.js (`expectedSchemeIds`),
 *      which require human judgement against the real corpus;
 *   3. a real MongoDB connection, so retrieval runs against the real index.
 *
 * Until then the script reports what it can measure and says so about the rest.
 */
const path = require("path");
const fs = require("fs");

// Soft require: dotenv is a normal dependency on a developer machine, but the
// script must still run where it is absent (a CI image, or this project's
// offline sandbox). Failing to load .env changes which provider is configured,
// never whether the numbers are honest — and the report prints the provider it
// actually used, so a missing .env is visible rather than silent.
try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const { runEvaluation, formatReport } = require("../src/evaluation/harness");
const { runStaleAnswerExperiment } = require("../src/evaluation/staleAnswerExperiment");
const { activeProvider } = require("../src/services/embeddingService");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

/**
 * The demo fixture used when no database is connected.
 *
 * Clearly synthetic, and the report says so. Running against real data means
 * pointing `buildData` at the real models — which is the documented next step,
 * not something this script pretends to have done.
 */
const DEMO_SCHEME = {
  schemeId: "merit-scholarship",
  name: "State Merit Scholarship",
  version: 2,
  description: "A scholarship for meritorious students in higher education.",
  eligibility: "Open to students below 25 whose annual family income does not exceed 200000 rupees.",
  benefits: "A tuition grant of Rs 50000 per academic year.",
  documents: ["Aadhaar Card", "Income Certificate"],
  lastDate: "2026-03-31",
  eligibilityRules: {
    minAge: 18, maxAge: 25, maxAnnualIncome: 200000,
    minAnnualIncome: null, minMarksPercentage: null, minEducationLevel: null,
    genders: [], categories: [], occupations: [], states: [],
    source: "structured", eligibilityType: "constrained",
    confidence: 0.7, needsReview: false,
  },
};

const DEMO_USER = {
  _id: "eval-user",
  email: "eval@example.invalid",
  profile: { age: 22, annualIncome: 150000, state: "Karnataka", categories: [], documentsAvailable: ["Aadhaar Card"] },
};

function banner(title) {
  console.log("\n" + "=".repeat(74));
  console.log(title);
  console.log("=".repeat(74));
}

async function main() {
  const out = { generatedAt: new Date().toISOString() };

  banner("PHASE O — EVALUATION RUN");
  console.log(`embedding provider   ${activeProvider()}`);
  if (activeProvider() === "local-hash") {
    console.log(
      "\n  NOTE: local-hash is LEXICAL, not semantic. Retrieval-quality metrics\n" +
      "  will be withheld from this run. Set EMBEDDING_PROVIDER=gemini (or\n" +
      "  ollama) and re-index before quoting any retrieval-quality figure."
    );
  }

  // ---- the stale-answer experiment --------------------------------------
  // Runs first because it is the one measurement that is honest under any
  // provider: it tests a structural property of version filtering.
  banner("STALE-ANSWER EXPERIMENT (version-aware vs version-unaware baseline)");
  const { makeCollection } = loadInMemory();
  const chunkModel = makeCollection("schemechunks", { uniqueKeys: [["chunkId"]] });
  const stale = await runStaleAnswerExperiment({ chunkModel });
  out.staleAnswer = stale;

  console.log(`version-pairs tested   ${stale.n}`);
  console.log(`version-aware  stale   ${stale.versionAware.staleAnswers}/${stale.n}  (coverage ${stale.versionAware.coverage})`);
  console.log(`baseline       stale   ${stale.baseline.staleAnswers}/${stale.n}  (coverage ${stale.baseline.coverage})`);
  console.log(`comparison valid       ${stale.comparisonValid}`);
  console.log("\nSCOPE:\n" + stale.scope);

  if (has("--stale-only")) return finish(out);

  // ---- the question set --------------------------------------------------
  banner("QUESTION SET");
  const { report } = await runEvaluation({
    user: DEMO_USER,
    buildData: () => ({ scheme: DEMO_SCHEME }),
    deps: {
      // No network in the default run. Replace with the real retriever and a
      // live LLM to measure those paths.
      retrieveFn: async () => ({ results: [], sufficient: false, metrics: { totalMs: 0 } }),
      useLlm: process.env.CHAT_LLM === "true",
    },
  });
  out.questionSet = report;
  console.log(formatReport(report));
  console.log(`\nfollow-up context resolved   ${report.followUps.resolved}/${report.followUps.n}`);
  console.log(
    `correct refusals             ${report.refusals.correctlyRefused}/${report.refusals.n}` +
      (report.refusals.missed.length ? `  MISSED: ${report.refusals.missed.join(", ")}` : "")
  );
  if (report.labelling.note) console.log(`\nNOTE: ${report.labelling.note}`);
  if (report.errors.length) console.log(`\nERRORS: ${JSON.stringify(report.errors)}`);

  banner("WHAT THIS RUN DID NOT MEASURE");
  console.log(
    [
      "  - retrieval quality (needs a semantic provider AND relevance labels)",
      "  - real LLM behaviour (no provider call unless CHAT_LLM=true)",
      "  - real MongoDB / Atlas retrieval latency",
      "  - end-to-end HTTP latency",
      "  Numbers above are from this process, on synthetic fixtures.",
    ].join("\n")
  );

  return finish(out);
}

function finish(out) {
  const jsonPath = valueOf("--json");
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${jsonPath}`);
  }
}

/** The in-memory model double, used when no DB is connected. */
function loadInMemory() {
  return require("../tests/helpers/inMemoryDb");
}

main().catch((err) => {
  console.error("evaluation run failed:", err.message);
  process.exit(1);
});
