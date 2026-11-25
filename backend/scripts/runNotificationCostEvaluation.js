#!/usr/bin/env node
/**
 * PHASE R — notification cost experiment.
 *
 *   npm run evaluate:notification-cost
 *   npm run evaluate:notification-cost -- --out r.json --users 1000
 *
 * Answers the two questions NOTIFICATION_ARCHITECTURE.md defers to Phase R:
 *
 *   R.1  does the targeted flow interrupt fewer people than the legacy
 *        full-scan notifier, on a population?
 *   R.2  does a collection cycle spend a material fraction of its time in
 *        delivery — the documented trigger for adopting a message broker?
 *
 * Offline and deterministic. No email is sent, no database is contacted, and
 * the population is the SYNTHETIC corpus Phase Q uses — reused rather than
 * duplicated, so both experiments describe the same population.
 *
 * R.2 needs stage timings from real cycles. Pass a Phase-R-instrumented run
 * with `--cycles <file.json>` (an array of
 * `{ totalMs, notificationDurationMs }`). Without it, R.2 reports NOT MEASURED
 * rather than guessing — an unmeasured cycle can neither justify a broker nor
 * rule one out.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const { buildCorpus, makeUsers, PROVENANCE } = require("../src/evaluation/propagationCorpus");
const { makeUserStore } = require("../src/evaluation/propagationHarness");
const { runCase } = require("../src/evaluation/notificationCostExperiment");
const {
  summarise,
  brokerRecommendation,
  formatReport,
  STATUS,
} = require("../src/evaluation/notificationCostMetrics");

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = arg("--out");
const CYCLES = arg("--cycles");
const POPULATION = Number(arg("--users", 240));

async function main() {
  const corpus = buildCorpus();
  const users = makeUsers(POPULATION);
  const userModel = makeUserStore(users);

  const observations = [];
  for (const kase of corpus) {
    try {
      const result = await runCase(kase, { users, userModel });
      observations.push({ ...result, status: STATUS.MEASURED });
    } catch (err) {
      // Reported, never dropped: a corpus that silently shrinks reports a
      // figure over whatever happened to work.
      observations.push({ id: kase.id, label: kase.label, status: STATUS.FAILED, error: err.message });
    }
  }

  const summary = summarise(observations, { provenance: PROVENANCE, population: users.length });

  let cycles = [];
  if (CYCLES) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(CYCLES), "utf8"));
      cycles = Array.isArray(raw) ? raw : raw.cycles || [];
    } catch (err) {
      console.warn(`could not read --cycles ${CYCLES}: ${err.message}`);
    }
  }
  const broker = brokerRecommendation(cycles);

  console.log(formatReport(summary, observations, broker));

  if (OUT) {
    fs.writeFileSync(
      path.resolve(OUT),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          summary,
          broker,
          observations,
          note:
            "Phase R notification cost. The corpus is SYNTHETIC. Timings are " +
            "in-process compute only — no SMTP and no database were involved.",
        },
        null,
        2
      )
    );
    console.log(`\nwrote ${OUT}`);
  }

  process.exit(summary.status === STATUS.FAILED ? 1 : 0);
}

main().catch((err) => {
  console.error("Phase R evaluation failed to run:", err.message);
  process.exit(1);
});
