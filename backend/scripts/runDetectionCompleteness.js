#!/usr/bin/env node
/**
 * PHASE V — change-detection completeness.
 *
 *   npm run evaluate:detection
 *   npm run evaluate:detection -- --out v.json
 *   npm run evaluate:detection -- --verbose
 *   npm run evaluate:detection -- --no-cross-check
 *
 * Perturbs every field the normalized scheme document carries, one at a time,
 * and asks whether the change the detector reports matches whether any user's
 * recommended state actually moved.
 *
 * Exits non-zero when any material change is missed, misclassified, or handed
 * to a candidate selection that is not provably complete. Those conditions are
 * defects, not settings, so CI can gate on this.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const {
  runDetectionCompleteness,
  OUTCOME,
  EXCLUDED_FROM_UNIVERSE,
} = require("../src/evaluation/detectionCompleteness");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : null;
const VERBOSE = args.includes("--verbose");
const CROSS_CHECK = !args.includes("--no-cross-check");

const result = runDetectionCompleteness({ crossCheck: CROSS_CHECK });

const bar = "=".repeat(78);
console.log(bar);
console.log("PHASE V — CHANGE-DETECTION COMPLETENESS");
console.log(bar);
console.log(`base scheme shapes    : ${result.bases}`);
console.log(`fields exercised      : ${result.fieldsExercised}   (from the normalized document, NOT COMPARABLE_FIELDS)`);
console.log(`single-field mutations: ${result.mutations}`);
console.log(`oracle population     : ${result.population} enumerated profiles`);
console.log(`run status            : ${result.status}`);
console.log("");

console.log("-".repeat(78));
console.log("THE PROPERTY UNDER TEST");
console.log("-".repeat(78));
console.log("  A change that flips at least one user's recommended state MUST be");
console.log("  detected, classified as user-affecting, and handed a candidate query");
console.log("  that actually reaches every user who moved. The converse is not");
console.log("  required: detecting a change that flips nobody costs a cycle,");
console.log("  missing one costs a person.");
console.log("");
console.log("  The candidate check compares the impact agent's real query against");
console.log("  the users the oracle says moved — not against the agent's own");
console.log("  completenessGuaranteed flag, which reports the selection MODE and");
console.log("  stays true for a band that is simply too narrow.");
console.log("");

console.log("-".repeat(78));
console.log("OUTCOMES");
console.log("-".repeat(78));
const row = (label, n, note) => console.log(`  ${label.padEnd(24)} ${String(n).padStart(5)}   ${note}`);
row("MISSED", result.counts[OUTCOME.MISSED], "material, detector said NO_CHANGE      <- defect");
row("MISCLASSIFIED", result.counts[OUTCOME.MISCLASSIFIED], "detected, but not user-affecting       <- defect");
row("UNSOUND_BAND", result.counts[OUTCOME.UNSOUND_BAND], "candidate query drops a moved user     <- defect");
row("INCOMPLETE_SELECTION", result.counts[OUTCOME.INCOMPLETE_SELECTION], "material, candidate set unproven       <- defect");
row("DETECTED_MATERIAL", result.counts[OUTCOME.DETECTED_MATERIAL], "material and handled correctly");
row("DETECTED_IMMATERIAL", result.counts[OUTCOME.DETECTED_IMMATERIAL], "detected, flips nobody (acceptable noise)");
row("IGNORED_IMMATERIAL", result.counts[OUTCOME.IGNORED_IMMATERIAL], "correctly ignored");
console.log("");
console.log(`  EVIDENCE STRENGTH — a sweep in which nothing is ever material would`);
console.log(`  pass vacuously. Materially-changing mutations: ${result.materialMutations}/${result.mutations}`);
console.log("");

console.log("-".repeat(78));
console.log("ORACLE INDEPENDENCE CROSS-CHECK");
console.log("-".repeat(78));
if (result.crossCheck.status === "NOT RUN") {
  console.log("  NOT RUN (--no-cross-check)");
} else {
  console.log(`  The oracle scores eligibility with the Phase U reference, which does`);
  console.log(`  not import services/matcher.js. Comparing the two over this sweep:`);
  console.log(`    verdicts compared : ${result.crossCheck.compared}`);
  console.log(`    divergent         : ${result.crossCheck.divergent}`);
  console.log(`    status            : ${result.crossCheck.status}`);
}
console.log("");

if (result.failures.length > 0) {
  console.log("-".repeat(78));
  console.log("FAILURES");
  console.log("-".repeat(78));
  for (const f of result.failures.slice(0, 20)) {
    console.log(`  [${f.outcome}] ${f.base} :: ${f.field}`);
    console.log(`    ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`);
    console.log(`    detector route : ${f.route}`);
    console.log(`    users flipped  : ${f.flips}`);
    if (f.sampleFlip) {
      const shown = Object.entries(f.sampleFlip.profile)
        .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      console.log(`    e.g. profile   : ${shown || "(all attributes absent)"}`);
      console.log(`         recommended ${f.sampleFlip.before} -> ${f.sampleFlip.after}`);
    }
    if (f.outcome === OUTCOME.MISCLASSIFIED) {
      console.log(`    classified as  : ${f.changeType} / ${f.severity}, userImpactExpected=${f.userImpactExpected}`);
    }
    if (f.outcome === OUTCOME.UNSOUND_BAND) {
      console.log(`    selection      : ${f.candidateSelection} (completenessGuaranteed=${f.completenessGuaranteed})`);
      console.log(`    moved users the query would NOT reach: ${f.usersOutsideCandidateSet}`);
    }
  }
  if (result.failures.length > 20) console.log(`  ... and ${result.failures.length - 20} more`);
  console.log("");
}

if (VERBOSE) {
  console.log("-".repeat(78));
  console.log("MATERIAL MUTATIONS, FIELD BY FIELD");
  console.log("-".repeat(78));
  const byField = new Map();
  for (const c of result.cases.filter((x) => x.material)) {
    byField.set(c.field, (byField.get(c.field) || 0) + 1);
  }
  for (const [field, n] of [...byField.entries()].sort()) {
    console.log(`  ${field.padEnd(40)} ${String(n).padStart(3)} material mutation(s)`);
  }
  console.log("");
  console.log("  Excluded from the field universe:");
  for (const [field, why] of Object.entries(EXCLUDED_FROM_UNIVERSE)) {
    console.log(`    ${field.padEnd(18)} ${why}`);
  }
  console.log("");
}

console.log(bar);
console.log("WHAT THIS DID NOT MEASURE");
console.log(bar);
console.log("  - COMPLETENESS OF THE POPULATION. The oracle enumerates a bounded");
console.log("    profile space. A MISSED verdict is firm evidence of a defect; the");
console.log("    absence of one is bounded reassurance, not proof.");
console.log("  - Whether the source data itself is correct. Detection compares two");
console.log("    normalized documents; if the collector or extractor misread the");
console.log("    government page, both sides are wrong together.");
console.log("  - The database reconciliation loop. This runs the real normalize,");
console.log("    contentHash gate and diffFields; the Mongo read/write around them");
console.log("    is exercised by the integration suites, not here.");
console.log("  - Multi-field changes. Mutations are applied one field at a time, so");
console.log("    a defect that only appears when two fields move together is out of");
console.log("    scope.");
console.log(bar);

if (OUT) {
  fs.writeFileSync(
    path.resolve(OUT),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status: result.status,
        population: result.population,
        bases: result.bases,
        fieldsExercised: result.fieldsExercised,
        mutations: result.mutations,
        materialMutations: result.materialMutations,
        counts: result.counts,
        crossCheck: result.crossCheck,
        failures: result.failures,
        cases: result.cases,
        note:
          "Phase V change-detection completeness. The mutation set is derived from " +
          "the normalized document's own field universe, never from COMPARABLE_FIELDS. " +
          "Materiality is judged by the Phase U independent reference, which does not " +
          "import services/matcher.js. SYNTHETIC and bounded.",
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${OUT}`);
}

process.exit(result.status === "COMPLETE" ? 0 : 1);
