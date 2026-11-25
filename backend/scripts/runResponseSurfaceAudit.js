#!/usr/bin/env node
/**
 * PHASE W — public response-surface audit.
 *
 *   npm run evaluate:exposure
 *   npm run evaluate:exposure -- --verbose
 *   npm run evaluate:exposure -- --out w.json
 *
 * Runs each unauthenticated endpoint's response projection over a
 * fully-populated document and checks two things:
 *
 *   W.1 CONFINEMENT   nothing classified INTERNAL leaves the process
 *   W.2 SUFFICIENCY   everything the frontend reads is still there
 *
 * Exits non-zero on a leak, a missing field, or a field with no declared
 * classification. All three are defects, not settings, so CI can gate on it.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const {
  runResponseSurfaceAudit,
  EXPOSURE_POLICY,
  INTERNAL,
} = require("../src/evaluation/responseSurface");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : null;
const VERBOSE = args.includes("--verbose");

const result = runResponseSurfaceAudit();

const bar = "=".repeat(78);
console.log(bar);
console.log("PHASE W — PUBLIC RESPONSE-SURFACE AUDIT");
console.log(bar);
console.log(`routes declared        : ${result.routes.length}`);
console.log(`unauthenticated routes : ${result.publicRoutes}`);
console.log(`surfaces audited       : ${result.surfaces.length}`);
console.log(`frontend source        : ${result.frontendAvailable ? "present" : "NOT FOUND — sufficiency NOT CHECKED"}`);
console.log(`run status             : ${result.status}`);
console.log("");

console.log("-".repeat(78));
console.log("THE TWO PROPERTIES");
console.log("-".repeat(78));
console.log("  W.1 CONFINEMENT  no INTERNAL field may appear in an unauthenticated response");
console.log("  W.2 SUFFICIENCY  every field the frontend reads must still be present");
console.log("  W.3 WIRING       every audited route must actually call its projection");
console.log("");
console.log("  Neither alone is a specification. Confinement is satisfied by");
console.log("  returning {}; sufficiency is satisfied by returning the raw document.");
console.log("  A projection is only correct when squeezed from both sides.");
console.log("");

console.log("-".repeat(78));
console.log("SURFACES");
console.log("-".repeat(78));
console.log(
  "  " +
    "endpoint".padEnd(34) +
    "auth".padEnd(7) +
    "in doc".padStart(7) +
    "emitted".padStart(9) +
    "internal".padStart(10) +
    "withheld".padStart(10) +
    "needed".padStart(8)
);
for (const s of result.surfaces) {
  console.log(
    "  " +
      s.endpoint.padEnd(34) +
      (s.authenticated ? "yes" : "no").padEnd(7) +
      String(s.fieldsInDocument).padStart(7) +
      String(s.fieldsEmitted).padStart(9) +
      String(s.internalFieldsInDocument).padStart(10) +
      String(s.internalFieldsWithheld).padStart(10) +
      String(s.frontendFieldsRequired ?? "-").padStart(8)
  );
}
console.log("");

if (result.leaks.length > 0) {
  console.log("-".repeat(78));
  console.log("W.1 FAILURES — INTERNAL DATA IN AN UNAUTHENTICATED RESPONSE");
  console.log("-".repeat(78));
  for (const leak of result.leaks) {
    console.log(`  ${leak.endpoint}  ::  ${leak.field}`);
    console.log(`    why internal : ${leak.reason}`);
    const shown = JSON.stringify(leak.value);
    console.log(`    value        : ${shown && shown.length > 160 ? shown.slice(0, 160) + "…" : shown}`);
  }
  console.log("");
}

if (result.missing.length > 0) {
  console.log("-".repeat(78));
  console.log("W.2 FAILURES — THE FRONTEND READS A FIELD THE RESPONSE NO LONGER CARRIES");
  console.log("-".repeat(78));
  for (const m of result.missing) {
    console.log(`  ${m.endpoint}  ::  ${m.field}   (read in frontend/src/${m.file})`);
  }
  console.log("");
}

if (result.unprojected.length > 0) {
  console.log("-".repeat(78));
  console.log("W.3 FAILURES — A ROUTE THAT DOES NOT GO THROUGH ITS PROJECTION");
  console.log("-".repeat(78));
  console.log("  The projection can be perfect and simply not be called. This is the");
  console.log("  only check that fails when a handler reverts to res.json(doc).");
  for (const u of result.unprojected) {
    console.log(`  ${u.endpoint}`);
    console.log(`    ${u.reason}`);
  }
  console.log("");
}

if (result.undeclared.length > 0) {
  console.log("-".repeat(78));
  console.log("UNDECLARED — EMITTED BUT NOT CLASSIFIED");
  console.log("-".repeat(78));
  console.log("  A field with no entry in EXPOSURE_POLICY is neither published nor");
  console.log("  withheld on purpose. Classify it rather than letting it default.");
  for (const u of result.undeclared) {
    console.log(`  ${u.endpoint}  ::  ${u.model}.${u.field}`);
  }
  console.log("");
}

if (VERBOSE) {
  console.log("-".repeat(78));
  console.log("WHAT IS WITHHELD, AND WHY");
  console.log("-".repeat(78));
  for (const [model, fields] of Object.entries(EXPOSURE_POLICY)) {
    console.log(`  ${model}`);
    for (const [field, [classification, reason]] of Object.entries(fields)) {
      if (classification !== INTERNAL) continue;
      console.log(`    ${field.padEnd(34)} ${reason}`);
    }
  }
  console.log("");
  console.log("-".repeat(78));
  console.log("ROUTE INVENTORY");
  console.log("-".repeat(78));
  for (const r of result.routes) {
    console.log(`  ${(r.authenticated ? "AUTH" : "open").padEnd(6)} ${r.method.padEnd(6)} ${r.route.padEnd(42)} ${r.file}`);
  }
  console.log("");
}

console.log(bar);
console.log("WHAT THIS DID NOT MEASURE");
console.log(bar);
console.log("  - It is a STATIC audit. The projection is run in process over a");
console.log("    fixture; no HTTP request is made and no server is started.");
console.log("  - Only the four scheme/history surfaces are audited. The user,");
console.log("    auth, notification and chat routes have their own projections");
console.log("    (toSafeJSON, serialize, toPublicResponse) and their own tests.");
console.log("  - It cannot tell you whether the CLASSIFICATION is right. The");
console.log("    policy table is a stated judgement, read from the model files'");
console.log("    documentation — not a measurement.");
console.log("  - Sufficiency is judged from static property reads in the frontend");
console.log("    source. A field reached by computed access (obj[key]) would not");
console.log("    be seen.");
console.log(bar);

if (OUT) {
  fs.writeFileSync(
    path.resolve(OUT),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...result,
        note:
          "Phase W public response-surface audit. The field universe comes from the " +
          "Mongoose schema definitions, the classification from a declared policy table, " +
          "and the required fields from the frontend source — none of them from " +
          "services/publicProjection.js, which is the thing under test.",
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${OUT}`);
}

process.exit(result.status === "CONFINED" ? 0 : 1);
