#!/usr/bin/env node
/**
 * PHASE U — matcher agreement against an independent reference.
 *
 *   npm run evaluate:matcher
 *   npm run evaluate:matcher -- --out u.json
 *   npm run evaluate:matcher -- --allow-unknown
 *
 * Enumerates every profile in a bounded, boundary-focused input space against
 * every scheme shape, and compares the production matcher's verdict with a
 * reference implementation written independently from the documented rules.
 *
 * Exits non-zero on any disagreement. A disagreement is not automatically a
 * matcher bug — it means the two readings of the specification differ and a
 * human has to decide which is right — but it always means the "deterministic
 * authority" claim is currently unsupported.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const { runAgreement, SCHEMES, PROFILE_AXES } = require("../src/evaluation/matcherAgreement");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : null;
const ALLOW_UNKNOWN = args.includes("--allow-unknown");

const result = runAgreement({ allowUnknown: ALLOW_UNKNOWN });

const bar = "=".repeat(78);
console.log(bar);
console.log("PHASE U — MATCHER AGREEMENT (production vs independent reference)");
console.log(bar);
console.log(`profiles enumerated : ${result.profiles}   (exhaustive, not sampled)`);
console.log(`scheme shapes       : ${result.schemes}`);
console.log(`verdicts compared   : ${result.compared}`);
console.log(`allowUnknown        : ${ALLOW_UNKNOWN}`);
console.log(`run status          : ${result.status}`);
console.log("");

console.log("-".repeat(78));
console.log("AGREEMENT");
console.log("-".repeat(78));
console.log(`disagreements       : ${result.disagreementCount}   (must be 0)`);
console.log(
  `agreement rate      : ${(result.agreementRate * 100).toFixed(4)}%  (${
    result.compared - result.disagreementCount
  }/${result.compared})`
);
console.log("");
console.log("  EVIDENCE STRENGTH — agreement over a space where nobody is ever");
console.log("  eligible would be vacuous:");
console.log(`    both said ELIGIBLE   : ${result.bothEligible}`);
console.log(`    both said INELIGIBLE : ${result.bothIneligible}`);
console.log("");

if (result.disagreementCount > 0) {
  console.log("-".repeat(78));
  console.log("DISAGREEMENTS — one of the two implementations is wrong");
  console.log("-".repeat(78));
  for (const d of result.disagreements.slice(0, 12)) {
    const shown = Object.entries(d.profile)
      .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    console.log(`  ${d.schemeId}`);
    console.log(`    profile    : ${shown || "(all attributes absent)"}`);
    console.log(`    production : ${d.production}   failed=[${d.productionFailed.join(",")}]`);
    console.log(`    reference  : ${d.reference}   failed=[${d.referenceFailed.join(",")}]`);
  }
  if (result.disagreementCount > 12) {
    console.log(`  ... and ${result.disagreementCount - 12} more`);
  }
  console.log("");
}

console.log(bar);
console.log("WHAT THIS DID NOT MEASURE");
console.log(bar);
console.log("  - whether the SPECIFICATION is right. Both implementations read the");
console.log("    same documented rules; agreement means they read them the same");
console.log("    way, not that the rules serve citizens correctly.");
console.log("  - attribute values outside the enumerated axes. The space is");
console.log("    bounded and boundary-focused, not the whole domain.");
console.log("  - real scheme data or a real user population.");
console.log("  - reason strings, scores, or ordering — only the boolean verdict");
console.log("    the rest of the system acts on.");
console.log(bar);

if (OUT) {
  fs.writeFileSync(
    path.resolve(OUT),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...result,
        axes: PROFILE_AXES,
        schemeIds: SCHEMES.map((s) => s.id),
        note:
          "Phase U matcher agreement. Exhaustive over a BOUNDED, boundary-focused " +
          "input space. The reference implementation is independent of " +
          "services/matcher.js and is never used in production.",
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${OUT}`);
}

process.exit(result.status === "AGREE" ? 0 : 1);
