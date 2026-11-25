#!/usr/bin/env node
/**
 * PHASE Q — propagation soundness experiment.
 *
 *   npm run evaluate:propagation                  offline, simulated store
 *   npm run evaluate:propagation -- --out q.json  write the machine-readable run
 *   node scripts/runPropagationEvaluation.js --live   against the real database
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TWO MODES MEAN
 * ---------------------------------------------------------------------------
 * OFFLINE  the corpus population is held in process and the Impact Agent's
 *          filters are evaluated by src/evaluation/queryEvaluator.js. This
 *          measures the BANDING LOGIC. It does not measure MongoDB.
 *
 * --live   the same corpus is written to the real `users` collection under a
 *          reserved id prefix, the same experiment runs through Mongoose, and
 *          the corpus users are removed afterwards. This measures the banding
 *          logic AS MONGO EXECUTES IT — index behaviour, type coercion, and
 *          Mongo's own null semantics included.
 *
 * The two are reported separately and never merged. `store` in the output says
 * which one produced the number.
 *
 * --live WRITES TO YOUR DATABASE. It inserts users whose ids begin with
 * `q-user-` and deletes exactly those at the end. It touches nothing else. Do
 * not point it at production.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const { buildCorpus, makeUsers, PROVENANCE } = require("../src/evaluation/propagationCorpus");
const { runCorpus } = require("../src/evaluation/propagationHarness");
const { summarise, formatReport, STATUS } = require("../src/evaluation/propagationMetrics");

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const outIndex = args.indexOf("--out");
const OUT = outIndex >= 0 ? args[outIndex + 1] : null;
const sizeIndex = args.indexOf("--users");
const POPULATION = sizeIndex >= 0 ? Number(args[sizeIndex + 1]) : 240;

/** The reserved id prefix --live inserts under, and deletes afterwards. */
const CORPUS_ID_PREFIX = "q-user-";

async function main() {
  const corpus = buildCorpus();
  const users = makeUsers(POPULATION);

  let userModel = null;
  let mongoose = null;
  let store = "SIMULATED_STORE";

  if (LIVE) {
    mongoose = require("mongoose");
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error(
        "--live requires MONGODB_URI. Refusing to report a live result from a " +
          "database that was never reached."
      );
      process.exit(2);
    }
    await mongoose.connect(uri);
    const User = require("../src/models/User");

    // Clean first: a previous interrupted run must not contaminate this one.
    await User.deleteMany({ _id: { $regex: `^${CORPUS_ID_PREFIX}` } });
    await User.collection.insertMany(users.map((u) => ({ ...u, _id: u._id })));
    userModel = User;
    store = "REAL_MONGODB";
    console.log(`inserted ${users.length} corpus users into the live database\n`);
  }

  let result;
  try {
    result = await runCorpus({ corpus, users, userModel });
  } finally {
    if (LIVE) {
      const User = require("../src/models/User");
      const removed = await User.deleteMany({ _id: { $regex: `^${CORPUS_ID_PREFIX}` } });
      console.log(`\nremoved ${removed.deletedCount} corpus users from the live database`);
      await mongoose.disconnect();
    }
  }

  const summary = summarise(result.observations, {
    provenance: PROVENANCE,
    store,
    population: users.length,
  });

  console.log(formatReport(summary, result.observations));

  // Contract drift is reported loudly but does not change the soundness
  // verdict: the corpus's expectation about which mode the agent picks is a
  // documentation claim, while soundness is a measurement.
  const drift = result.observations.filter((o) => o.selectionAsExpected === false);
  if (drift.length) {
    console.log("\nCANDIDATE-SELECTION DRIFT (corpus expectation vs agent):");
    for (const o of drift) {
      console.log(`  ${o.id}: expected ${o.expectedSelection}, agent chose ${o.candidateSelection}`);
    }
  }

  if (OUT) {
    const payload = {
      generatedAt: new Date().toISOString(),
      summary,
      observations: result.observations,
      note:
        "Phase Q propagation soundness. `store` distinguishes an in-process " +
        "evaluation of the banding logic from a run executed by MongoDB. The " +
        "corpus is SYNTHETIC.",
    };
    fs.writeFileSync(path.resolve(OUT), JSON.stringify(payload, null, 2));
    console.log(`\nwrote ${OUT}`);
  }

  // A run that found an unsound band, or that failed, must not exit 0 — this
  // is the check a CI pipeline would gate on.
  process.exit(summary.status === STATUS.SOUND ? 0 : 1);
}

main().catch((err) => {
  console.error("Phase Q evaluation failed to run:", err.message);
  process.exit(1);
});
