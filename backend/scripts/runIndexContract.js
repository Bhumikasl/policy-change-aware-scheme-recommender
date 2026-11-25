#!/usr/bin/env node
/**
 * PHASE Y — the index contract.
 *
 *   npm run evaluate:indexes
 *   npm run evaluate:indexes -- --live       # also read the real cluster
 *   npm run evaluate:indexes -- --verbose
 *   npm run evaluate:indexes -- --out y.json
 *   npm run evaluate:indexes -- --print-table   # the checklist the schemas imply
 *
 * Four production code paths treat a duplicate-key error as "already done".
 * Each is exactly-once ONLY because a unique index rejects the second insert —
 * a guarantee that lives in the database, not in any function, and that no test
 * in this repository can exercise.
 *
 * Exits non-zero when the checklist and the schemas disagree, when a
 * uniqueness the code depends on has no unique declaration behind it, or when a
 * live read finds a declared index missing, non-unique, or still building.
 *
 * Without a reachable database the live check reports NOT MEASURED with the
 * exact reason. It is never reported as passing.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const {
  runIndexContract,
  liveIndexes,
  checklistRows,
  CONSTRAINT_DEPENDENCIES,
  OUTCOME,
} = require("../src/evaluation/indexContract");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : null;
const VERBOSE = args.includes("--verbose");
const LIVE = args.includes("--live");
const PRINT_TABLE = args.includes("--print-table");

(async () => {
  if (PRINT_TABLE) {
    console.log("| Collection | Index | Purpose | Unique |");
    console.log("|---|---|---|---|");
    for (const r of checklistRows()) {
      console.log(`| \`${r.collection}\` | \`${r.name}\` |  | ${r.unique ? "**Yes**" : "No"} |`);
    }
    process.exit(0);
  }

  const live = LIVE ? await liveIndexes() : null;
  const result = runIndexContract({ live });

  const bar = "=".repeat(78);
  console.log(bar);
  console.log("PHASE Y — INDEX CONTRACT");
  console.log(bar);
  console.log(`collections            : ${result.counts.collections}`);
  console.log(`indexes declared       : ${result.counts.declared}   (${result.counts.declaredUnique} unique)`);
  console.log(`indexes documented     : ${result.counts.documented}`);
  console.log(`constraint dependencies: ${result.counts.dependencies}`);
  console.log(`run status             : ${result.status}`);
  console.log("");

  console.log("-".repeat(78));
  console.log("THE THREE PROPERTIES");
  console.log("-".repeat(78));
  console.log("  Y.1 DOCUMENTED  every declared index is in INDEX_VERIFICATION.md, and");
  console.log("                  the checklist asks for nothing the schemas do not declare");
  console.log("  Y.2 BACKED      every uniqueness the CODE depends on is declared unique");
  console.log("  Y.3 LIVE        the cluster actually has them, unique, finished building");
  console.log("");
  console.log("  Y.2's input is the independent one: it is read from the code that");
  console.log("  DEPENDS on a constraint, not from the code that DECLARES one. Deleting");
  console.log("  `unique: true` from a schema and from the checklist together still");
  console.log("  leaves the dependency behind, so Y.2 still fails.");
  console.log("");

  console.log("-".repeat(78));
  console.log("WHAT THE CODE DEPENDS ON");
  console.log("-".repeat(78));
  for (const dep of result.dependencies) {
    const ok = dep.present && dep.catchesDuplicateKey && dep.referencesModel;
    console.log(`  ${(ok ? "ok" : "??").padEnd(4)} ${dep.file.padEnd(30)} -> ${dep.model}`);
    console.log(`       ${dep.why}`);
  }
  console.log("");

  console.log("-".repeat(78));
  console.log("Y.3 — THE LIVE CLUSTER");
  console.log("-".repeat(78));
  if (result.live.status === "MEASURED") {
    console.log("  MEASURED — indexes read from the database named by MONGODB_URI.");
  } else {
    console.log(`  NOT MEASURED — ${result.live.reason}`);
    console.log("");
    console.log("  This is the only property that can confirm the guarantee actually");
    console.log("  holds. A declaration is a request: Mongoose builds indexes lazily,");
    console.log("  autoIndex is often off in production, and a unique build over a");
    console.log("  collection that already has duplicates fails silently and leaves no");
    console.log("  constraint at all. NOT MEASURED is not a pass.");
    console.log("");
    console.log("  To measure:  MONGODB_URI=... npm run evaluate:indexes -- --live");
  }
  console.log("");

  if (result.findings.length > 0) {
    console.log("-".repeat(78));
    console.log("FINDINGS");
    console.log("-".repeat(78));
    const byOutcome = {};
    for (const f of result.findings) byOutcome[f.outcome] = (byOutcome[f.outcome] || 0) + 1;
    for (const [outcome, n] of Object.entries(byOutcome)) {
      console.log(`  ${outcome.padEnd(26)} ${n}`);
    }
    console.log("");
    const shown = VERBOSE ? result.findings : result.findings.slice(0, 20);
    for (const f of shown) {
      const flag = f.outcome === OUTCOME.UNBACKED || f.unique ? " <-- UNIQUE" : "";
      console.log(`  [${f.outcome}] ${f.detail}${flag}`);
      if (f.why) console.log(`      depends on it for: ${f.why}`);
    }
    if (!VERBOSE && result.findings.length > 20) {
      console.log(`  ... and ${result.findings.length - 20} more (--verbose for all)`);
    }
    console.log("");
  }

  if (VERBOSE) {
    console.log("-".repeat(78));
    console.log("EVERY DECLARED INDEX");
    console.log("-".repeat(78));
    let collection = "";
    for (const d of [...result.declared].sort(
      (a, b) => a.collection.localeCompare(b.collection) || a.name.localeCompare(b.name)
    )) {
      if (d.collection !== collection) {
        collection = d.collection;
        console.log(`  ${collection}`);
      }
      console.log(`    ${d.unique ? "UNIQUE" : "      "} ${d.name}`);
    }
    console.log("");
  }

  console.log(bar);
  console.log("WHAT THIS DID NOT MEASURE");
  console.log(bar);
  console.log("  - Whether the indexes EXIST, unless --live reported MEASURED. Y.1 and");
  console.log("    Y.2 compare code against documentation and against code; only Y.3");
  console.log("    touches a database.");
  console.log("  - Query plans. An index existing is not an index being used; the");
  console.log("    checklist's explain() step is still a manual check.");
  console.log("  - Whether the declared index SET is the right one for the workload.");
  console.log("    This verifies the contract is consistent, not that it is optimal.");
  console.log("  - Concurrency itself. That two racing inserts collide is a property of");
  console.log("    the constraint, and is only demonstrable against a real cluster.");
  console.log(bar);

  if (OUT) {
    fs.writeFileSync(
      path.resolve(OUT),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          ...result,
          constraintDependencies: CONSTRAINT_DEPENDENCIES,
          note:
            "Phase Y index contract. Declared indexes come from the Mongoose schema " +
            "definitions, the checklist from INDEX_VERIFICATION.md, and the required " +
            "uniqueness from the production code that depends on a duplicate-key error. " +
            "Y.3 is MEASURED only when a real database was reachable.",
        },
        null,
        2
      )
    );
    console.log(`\nwrote ${OUT}`);
  }

  process.exit(result.status === "CONSISTENT" ? 0 : 1);
})();
