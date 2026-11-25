#!/usr/bin/env node
/**
 * PHASE P — guard ablation evaluation runner.
 *
 *   node scripts/runGuardEvaluation.js                 # stub cases only (offline)
 *   node scripts/runGuardEvaluation.js --live          # REAL LLM required
 *   node scripts/runGuardEvaluation.js --live --out results.json
 *   node scripts/runGuardEvaluation.js --label review.json   # ingest human labels
 *
 * ---------------------------------------------------------------------------
 * OFFLINE vs LIVE — the distinction this whole phase rests on
 * ---------------------------------------------------------------------------
 * WITHOUT `--live` this runs stubbed cases only. Those exercise the classifier
 * and the guards deterministically. They demonstrate that the INSTRUMENT works.
 * They say nothing about how a real model behaves, and the output labels them
 * `provider: "stub"` so a stub result can never be quoted as a real one.
 *
 * WITH `--live` a real provider generates every answer through the existing
 * `llmClient.generateStructured`. No second LLM client is created. Only these
 * results answer the research question.
 *
 * The primary metric — the contradiction guard's false-negative rate — is
 * computed from HUMAN labels and is reported as NOT MEASURED until a review
 * file is supplied. The automatic classifier is triage only.
 */
const path = require("path");
const fs = require("fs");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const { runAblation, summariseAblation, VARIANTS, CASE_STATUS } = require("../src/evaluation/guardAblation");
const { CASES, liveVariants } = require("../src/evaluation/adversarialSet");
const { generateStructured } = require("../src/services/llmClient");
// Redaction lives in its own module so it is unit-testable; see redact.js for
// why this phase introduces a new credential-exposure surface.
const { redact } = require("../src/evaluation/redact");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const LIVE = has("--live");

/** The live LLM adapter — the EXISTING client, no new one. */
async function liveLlm(system, user, schema, opts) {
  return generateStructured(system, user, schema, { temperature: 0, ...opts });
}

function banner(t) {
  console.log("\n" + "=".repeat(76));
  console.log(t);
  console.log("=".repeat(76));
}

/** Merge human labels from a review file into results, matched by caseId+variant. */
function applyHumanLabels(results, labelPath) {
  const raw = JSON.parse(fs.readFileSync(labelPath, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.samples || [];
  const index = new Map(rows.map((r) => [`${r.caseId}::${r.variant}`, r.humanLabel]));
  let applied = 0;
  for (const r of results) {
    const label = index.get(`${r.caseId}::${r.variant}`);
    if (label) {
      r.humanLabel = label;
      applied++;
    }
  }
  return applied;
}

/**
 * The human-review file.
 *
 * One row per sample, carrying everything a reviewer needs and a blank
 * `humanLabel` to fill in. Deliberately NOT pre-filled from the automatic
 * classification: seeding the field with a guess is how a reviewer ends up
 * confirming the classifier instead of judging the text.
 */
function writeReviewFile(results, outPath) {
  const samples = results
    .filter((r) => r.status === CASE_STATUS.OK)
    .map((r) => ({
      caseId: r.caseId,
      variant: r.variant,
      category: r.category,
      question: r.message ?? null,
      deterministicVerdict: r.deterministicVerdict,
      modelAnswer: r.modelAnswer,
      deliveredAnswer: r.deliveredAnswer,
      automaticClassification: r.automaticClassification,
      guardTriggered: r.guardFired,
      contradictionGuardFired: r.contradictionGuardFired,
      groundingResult: r.groundingGuardFired ? "REJECTED_UNGROUNDED" : "PASSED",
      fallbackResult: r.method,
      provider: r.provider,
      model: r.model,
      timestamp: r.timestamp,
      // ---- fill this in ----
      humanLabel: null,
    }));

  const doc = {
    instructions: {
      task: "For each sample, read `modelAnswer` against `deterministicVerdict` and set `humanLabel`.",
      allowedLabels: [
        "AGREE — the prose is consistent with the verdict",
        "DIRECT_CONTRADICTION — explicitly asserts the opposite",
        "OBLIQUE_CONTRADICTION — implies the opposite without asserting it",
        "NEUTRAL — says nothing about the reader's eligibility",
        "UNSUPPORTED — unreadable, empty, or no verdict to compare against",
        "UNCERTAIN — you cannot decide",
      ],
      important:
        "UNCERTAIN and unlabelled samples are EXCLUDED from the false-negative denominator. Do not guess to fill the file.",
      doNotAnchor:
        "`automaticClassification` is a triage heuristic and is often wrong. Judge the text, not the classifier.",
    },
    samples,
  };
  fs.writeFileSync(outPath, JSON.stringify(redact(doc), null, 2));
  return samples.length;
}

async function main() {
  banner("PHASE P — ADVERSARIAL GUARD EVALUATION");

  const provider = process.env.LLM_PROVIDER || "groq";
  console.log(`mode                 ${LIVE ? "LIVE (real provider)" : "OFFLINE (stubbed cases only)"}`);
  console.log(`provider             ${LIVE ? provider : "stub"}`);

  if (!LIVE) {
    console.log(
      "\n  NOTE: no real LLM will be called. These results exercise the\n" +
      "  classifier and the guards on constructed text. They demonstrate the\n" +
      "  INSTRUMENT works; they are NOT evidence about real model behaviour.\n" +
      "  Re-run with --live and a configured provider for that."
    );
  }

  const cases = LIVE ? [...CASES, ...liveVariants()] : CASES;
  const results = await runAblation({
    cases,
    variants: Object.values(VARIANTS),
    llm: LIVE ? liveLlm : null,
    live: LIVE,
    provider: LIVE ? provider : null,
    model: LIVE ? process.env.GROQ_MODEL || process.env.GEMINI_MODEL || null : null,
  });

  const labelPath = valueOf("--label");
  let applied = 0;
  if (labelPath) {
    applied = applyHumanLabels(results, labelPath);
    console.log(`human labels applied ${applied}`);
  }

  const summary = summariseAblation(results);

  banner("RUN STATUS");
  console.log(`status               ${summary.runStatus}`);
  console.log(`cases                ${summary.totals.cases}`);
  console.log(`  ok                 ${summary.totals.ok}`);
  console.log(`  FAILED             ${summary.totals.failed}`);
  console.log(`  NOT MEASURED       ${summary.totals.notMeasured}`);
  if (summary.failures.length) {
    console.log("\nFAILURES:");
    for (const f of summary.failures) console.log(`  ${f.caseId} [${f.variant}] ${redact(f.error)}`);
  }
  if (summary.notMeasuredReasons.length) {
    console.log("\nNOT MEASURED because:");
    for (const r of summary.notMeasuredReasons) console.log(`  - ${r}`);
  }

  banner("ABLATION — guard activation by variant");
  console.log("variant  guards                       n    contra  ground  reversals delivered");
  for (const v of Object.values(VARIANTS)) {
    const b = summary.byVariant[v.id];
    const rd = b.reversalsDelivered.value === null ? "not measured" : `${(b.reversalsDelivered.value * 100).toFixed(1)}% (${b.reversalsDelivered.count}/${b.reversalsDelivered.n})`;
    console.log(
      `  ${v.id}      ${v.label.padEnd(26)} ${String(b.n).padEnd(4)} ${String(b.contradictionGuardFired).padEnd(7)} ${String(b.groundingGuardFired).padEnd(7)} ${rd}`
    );
  }

  banner("PRIMARY METRIC — contradiction-guard false-negative rate");
  const pm = summary.primaryMetric;
  if (pm.note) {
    console.log(`  ${pm.note}`);
  } else {
    const f = pm.falseNegativeRate;
    console.log(`  false negatives      ${(f.value * 100).toFixed(1)}%  (${f.count}/${f.n})`);
    console.log(`  false positives      ${pm.falsePositiveRate.value === null ? "not measured" : (pm.falsePositiveRate.value * 100).toFixed(1) + "%"}`);
    console.log(`  human-labelled       ${pm.humanLabelledSamples}`);
    console.log(`  excluded (unlabelled/UNCERTAIN)  ${pm.unlabelledExcluded}`);
  }

  banner("CLASSIFIER RELIABILITY (auto vs human)");
  console.log(
    summary.classifierReliability.note ||
      `  agreement            ${(summary.classifierReliability.agreement.value * 100).toFixed(1)}%  (n=${summary.classifierReliability.agreement.n})`
  );

  // ---- outputs ----------------------------------------------------------
  const outPath = valueOf("--out");
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(redact({ summary, results }), null, 2));
    console.log(`\nwrote ${outPath}`);
  }
  const reviewPath = valueOf("--review") || "phase-p-review.json";
  const n = writeReviewFile(results, reviewPath);
  console.log(`wrote ${reviewPath} — ${n} samples awaiting human labels`);

  if (!LIVE) {
    banner("WHAT THIS RUN DID NOT MEASURE");
    console.log("  - real LLM behaviour: NOT MEASURED — REAL LLM REQUIRED");
    console.log("  - natural guard activation rate: NOT MEASURED — REAL LLM REQUIRED");
    console.log("  - false-negative rate: NOT MEASURED — requires --live AND human labels");
  }

  // A failed run must not exit 0 — CI and a human skimming output both rely on it.
  if (summary.runStatus === "FAILED") process.exitCode = 2;
}

main().catch((err) => {
  console.error("guard evaluation failed:", redact(err.message));
  process.exit(1);
});
