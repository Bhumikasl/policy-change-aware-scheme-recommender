#!/usr/bin/env node
/**
 * PHASE X — cross-surface recommendation agreement.
 *
 *   npm run evaluate:surfaces
 *   npm run evaluate:surfaces -- --verbose
 *   npm run evaluate:surfaces -- --out x.json
 *
 * The system tells a user their recommendations through three independent
 * paths — the matches page, the chat assistant, and the propagation pass that
 * writes the audit trail and sends the notifications. This checks that all
 * three select the same schemes, hand the ranker the same candidate shape, and
 * produce the same ordering.
 *
 * Exits non-zero on any disagreement. A disagreement means at least one of the
 * three is telling the user something the others contradict, so CI can gate
 * on it.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const {
  runSurfaceAgreement,
  RANKER_CANDIDATE_FIELDS,
  SURFACES,
} = require("../src/evaluation/surfaceAgreement");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : null;
const VERBOSE = args.includes("--verbose");

const result = runSurfaceAgreement();

const bar = "=".repeat(78);
console.log(bar);
console.log("PHASE X — CROSS-SURFACE RECOMMENDATION AGREEMENT");
console.log(bar);
console.log(`surfaces compared : ${result.surfaces}`);
for (const s of SURFACES) console.log(`                    ${s.key.padEnd(12)} ${s.label}`);
console.log(`users             : ${result.users}`);
console.log(`scheme universes  : ${result.universes}`);
console.log(`comparisons       : ${result.comparisons}`);
console.log(`run status        : ${result.status}`);
console.log("");

console.log("-".repeat(78));
console.log("THE THREE PROPERTIES");
console.log("-".repeat(78));
console.log("  X.1 SHAPE      every surface hands the ranker the same candidate fields");
console.log(`                 (${RANKER_CANDIDATE_FIELDS.join(", ")})`);
console.log("  X.2 MEMBERSHIP every surface selects the same set of schemes");
console.log("  X.3 ORDER      every surface produces the same ranking over that set");
console.log("");
console.log("  Two of them are ALSO checked against something outside the surfaces,");
console.log("  because three paths sharing one builder break identically and go on");
console.log("  agreeing with each other:");
console.log("    SHAPE_VS_CONTRACT       against the ranker's documented candidate fields");
console.log("    MEMBERSHIP_VS_REFERENCE against the Phase U reference implementation");
console.log("");

console.log("-".repeat(78));
console.log("EVIDENCE STRENGTH");
console.log("-".repeat(78));
console.log("  A dropped candidate field scores ZERO rather than throwing, so a");
console.log("  divergence is only visible where that field is the deciding signal.");
console.log(`  Comparisons where document readiness decides the order: ${result.readinessDecisive}/${result.comparisons}`);
console.log("");
console.log("  Every other corpus in this project — Q's, R's, T's — happens to");
console.log("  contain no such case. That is why the surfaces disagreed while the");
console.log("  whole suite passed.");
console.log("");

if (result.disagreements.length > 0) {
  console.log("-".repeat(78));
  console.log("DISAGREEMENTS — at least one surface contradicts the others");
  console.log("-".repeat(78));
  const byProperty = {};
  for (const d of result.disagreements) byProperty[d.property] = (byProperty[d.property] || 0) + 1;
  for (const [property, n] of Object.entries(byProperty)) {
    console.log(`  ${property.padEnd(24)} ${n}`);
  }
  console.log("");
  for (const d of result.disagreements.slice(0, 15)) {
    console.log(`  [${d.property}] ${d.surfaces.join("  vs  ")}`);
    console.log(`    user     : ${d.user}`);
    console.log(`    universe : ${d.universe}`);
    console.log(`    detail   : ${d.detail}`);
  }
  if (result.disagreements.length > 15) {
    console.log(`  ... and ${result.disagreements.length - 15} more`);
  }
  console.log("");
}

if (VERBOSE) {
  console.log("-".repeat(78));
  console.log("EVERY COMPARISON");
  console.log("-".repeat(78));
  for (const c of result.cases) {
    const flag = c.agreed ? "ok  " : "FAIL";
    const decisive = c.readinessDecisive ? "readiness decides" : "";
    console.log(`  ${flag} ${String(c.candidates).padStart(2)} cand  ${c.user.padEnd(30)} ${c.universe.padEnd(42)} ${decisive}`);
    if (VERBOSE) {
      for (const [key, s] of Object.entries(c.perSurface)) {
        console.log(`         ${key.padEnd(12)} ${s.order.join(" > ") || "(none)"}`);
      }
    }
  }
  console.log("");
}

console.log(bar);
console.log("WHAT THIS DID NOT MEASURE");
console.log(bar);
console.log("  - Whether the RANKING IS GOOD. Agreement says the three surfaces");
console.log("    tell the user the same thing, not that the thing is right.");
console.log("    Relevance quality still needs human judgements (Phase T's limit).");
console.log("  - The LLM verifier stage. GET /matches can veto a shortlisted");
console.log("    scheme after ranking; that stage is not part of the candidate");
console.log("    assembly compared here and needs a real LLM run to measure.");
console.log("  - Real HTTP. The surfaces are exercised in process through the");
console.log("    functions the routes call, not through a running server.");
console.log("  - A real user population or real scheme data — the corpus is");
console.log("    SYNTHETIC and built to make divergence decidable, not large.");
console.log(bar);

if (OUT) {
  fs.writeFileSync(
    path.resolve(OUT),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...result,
        note:
          "Phase X cross-surface recommendation agreement. Differential across the three " +
          "production paths, with membership additionally checked against an independent " +
          "expectation built on the Phase U reference implementation. SYNTHETIC corpus.",
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${OUT}`);
}

process.exit(result.status === "AGREE" ? 0 : 1);
