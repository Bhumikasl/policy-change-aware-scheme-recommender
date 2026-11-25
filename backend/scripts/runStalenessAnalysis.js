#!/usr/bin/env node
/**
 * PHASE S — staleness bound.
 *
 *   npm run evaluate:staleness
 *   npm run evaluate:staleness -- --out s.json
 *   npm run evaluate:staleness -- --without-policy-sweep    # the pre-S state
 *
 * Answers: how long can a user hold a recommendation that a policy change has
 * already invalidated?
 *
 * Reads the SAME environment variables the scheduler reads, so it describes the
 * deployment it is run in rather than a default. Exits non-zero when any stage
 * has no automatic recovery path — that condition is a defect, not a setting.
 */

const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const fs = require("fs");
const { analyse, BOUND } = require("../src/evaluation/stalenessBound");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : null;
// Reproduces the state Phase S found and fixed, so the report can be compared
// against it rather than described.
const WITHOUT_POLICY_SWEEP = args.includes("--without-policy-sweep");

const fmt = (mins) => {
  if (mins === null || mins === undefined) return "NOT MEASURED";
  if (mins < 60) return `${mins} min`;
  if (mins % 60 === 0) return `${mins / 60} h`;
  return `${(mins / 60).toFixed(1)} h`;
};

const result = analyse({
  options: { policySweepScheduled: !WITHOUT_POLICY_SWEEP },
});

const bar = "=".repeat(78);
console.log(bar);
console.log("PHASE S — STALENESS BOUND");
console.log(bar);
console.log("How long can a user hold a recommendation the policy already invalidated?");
if (WITHOUT_POLICY_SWEEP) {
  console.log("\n*** --without-policy-sweep: reproducing the pre-Phase-S state ***");
}
console.log("");
console.log(`overall bound : ${result.status}`);
if (result.status === BOUND.UNBOUNDED) {
  console.log(`UNBOUNDED because these stages have NO automatic recovery:`);
  for (const s of result.unrecoveredStages) console.log(`    - ${s}`);
}
console.log("");

console.log("-".repeat(78));
console.log("RECOVERY PATHS — what re-runs a failed stage without a human?");
console.log("-".repeat(78));
console.log(
  "stage".padEnd(24) + "recovered by".padEnd(30) + "max wait".padEnd(14) + "schedule"
);
for (const p of result.paths) {
  console.log(
    String(p.stage).padEnd(24) +
      String(p.recoveredBy === null ? "*** NOTHING ***" : p.recoveredBy).padEnd(30) +
      fmt(p.maxWaitMinutes).padEnd(14) +
      String(p.schedule || "-")
  );
}
console.log("");
for (const p of result.paths) {
  if (p.recoveredBy === null) {
    console.log(`  ${p.stage}: ${p.consequence}`);
  }
}
console.log("");

console.log("-".repeat(78));
console.log("WORST-CASE CORRECTION WINDOW");
console.log("-".repeat(78));
console.log(`  DERIVED  : ${fmt(result.derived.worstCaseCorrectionMinutes)}`);
console.log(`             (${result.derived.basis})`);
console.log(`  MEASURED : ${result.measured.processingMs === null ? "NOT MEASURED" : result.measured.processingMs + " ms"}`);
console.log(`             ${result.measured.note}`);
console.log("");
console.log("  DERIVED is arithmetic on the configured cron intervals. No clock was");
console.log("  involved and it is NOT a benchmark — it is what the schedule permits.");
console.log("");

console.log(bar);
console.log("WHAT THIS DID NOT MEASURE");
console.log(bar);
console.log("  - real detection delay: depends on when the ministry publishes and");
console.log("    when the collector next runs. Not observable from inside.");
console.log("  - SMTP, MongoDB, Atlas or network latency.");
console.log("  - how often a stage actually fails in production.");
console.log(bar);

if (OUT) {
  fs.writeFileSync(
    path.resolve(OUT),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...result,
        note:
          "Phase S staleness bound. `derived` is arithmetic on configured cron " +
          "intervals, NOT a measurement. `measured` is null unless pipeline " +
          "timings were supplied.",
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${OUT}`);
}

// A stage with no recovery path is a defect. CI should be able to gate on it.
process.exit(result.status === BOUND.UNBOUNDED ? 1 : 0);
