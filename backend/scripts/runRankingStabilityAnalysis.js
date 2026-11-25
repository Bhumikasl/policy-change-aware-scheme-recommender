#!/usr/bin/env node
/**
 * PHASE T — ranking order-invariance.
 *
 *   npm run evaluate:ranking
 *   npm run evaluate:ranking -- --permutations 100 --out t.json
 *
 * Shuffles each user's candidate list many times and requires the ranking to
 * come out identical. An unstable ranking means the position a user sees — and
 * every rank-change notification derived from it — depends on the order MongoDB
 * happened to return rows in.
 *
 * Offline and deterministic: the population is the SYNTHETIC corpus Phase Q and
 * Phase R share, and the permutations come from a seeded integer generator, so
 * a reader can reproduce every arrangement.
 *
 * Exits non-zero when the ranking is unstable — that condition is a defect, not
 * a setting, so CI can gate on it.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  console.warn("dotenv not installed — using ambient environment only");
}

const { rankCandidates, _clearIdfCache } = require("../src/services/relevanceRanker");
const { evaluateEligibility } = require("../src/services/matcher");
const { makeUsers, buildCorpus, PROVENANCE } = require("../src/evaluation/propagationCorpus");
const {
  checkOrderInvariance,
  tieGroups,
  totalOrderCheck,
} = require("../src/evaluation/rankingStability");

const args = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const PERMUTATIONS = Number(arg("--permutations", 24));
const USERS = Number(arg("--users", 40));
const OUT = arg("--out");

/**
 * A candidate pool with deliberate ties.
 *
 * Every corpus case contributes its post-change scheme, and several of them are
 * textually identical — which is the point. A pool of obviously-distinct schemes
 * would rank stably under any comparator and would prove nothing about the
 * tie-break.
 */
function buildPool() {
  const corpus = buildCorpus();
  return corpus.map((kase, i) => ({
    ...kase.schemeAfter,
    schemeId: `${kase.schemeAfter.schemeId}-${String(i).padStart(2, "0")}`,
  }));
}

function main() {
  const pool = buildPool();
  const users = makeUsers(USERS);

  const observations = [];
  for (const user of users) {
    const candidates = pool
      .map((scheme) => ({ scheme, verdict: evaluateEligibility(user, scheme) }))
      .filter((c) => c.verdict.eligible);

    const out = checkOrderInvariance({
      rank: rankCandidates,
      candidates,
      user,
      permutations: PERMUTATIONS,
      clearCache: _clearIdfCache,
    });

    if (out.status === "NOT_MEASURED") {
      observations.push({ userId: user._id, ...out });
      continue;
    }

    _clearIdfCache();
    const ranked = rankCandidates(candidates, user, {});
    observations.push({
      userId: user._id,
      candidates: candidates.length,
      ...out,
      ...tieGroups(ranked),
      ...totalOrderCheck(ranked),
    });
  }

  const measured = observations.filter((o) => o.status !== "NOT_MEASURED");
  const unstable = observations.filter((o) => o.status === "UNSTABLE");
  const notTotal = measured.filter((o) => o.isTotalOrder === false);
  const withTies = measured.filter((o) => (o.tieGroups || 0) > 0);

  const status = unstable.length > 0 ? "UNSTABLE" : measured.length === 0 ? "NOT_MEASURED" : "STABLE";

  const bar = "=".repeat(78);
  console.log(bar);
  console.log("PHASE T — RANKING ORDER-INVARIANCE");
  console.log(bar);
  console.log(`corpus provenance : ${PROVENANCE}`);
  console.log(`users             : ${users.length}   candidate pool: ${pool.length} schemes`);
  console.log(`permutations/user : ${PERMUTATIONS}`);
  console.log(`run status        : ${status}`);
  console.log("");

  console.log("-".repeat(78));
  console.log("ORDER-INVARIANCE — does shuffling the input change the ranking?");
  console.log("-".repeat(78));
  console.log(`users measured                : ${measured.length}`);
  console.log(`users with UNSTABLE ranking   : ${unstable.length}   (must be 0)`);
  console.log(`total rankings compared       : ${measured.length * PERMUTATIONS}`);
  console.log(`comparator not a total order  : ${notTotal.length}   (must be 0)`);
  console.log("");
  console.log("  EVIDENCE STRENGTH — a stable result over no ties proves nothing:");
  console.log(`    users whose ranking contains a tie group : ${withTies.length}/${measured.length}`);
  console.log(
    `    largest tie group observed               : ${
      measured.length ? Math.max(...measured.map((o) => o.largestGroup || 0)) : "NOT MEASURED"
    }`
  );
  console.log("");

  if (unstable.length) {
    console.log("-".repeat(78));
    console.log("UNSTABLE RANKINGS");
    console.log("-".repeat(78));
    for (const o of unstable.slice(0, 5)) {
      console.log(`  ${o.userId}: ${o.disagreementCount}/${o.permutations} permutations disagreed`);
      const d = o.disagreements[0];
      if (d) {
        console.log(`    first divergence at position ${d.firstDivergenceAt + 1}`);
        console.log(`      expected: ${d.expected.slice(0, 4).join(", ")}...`);
        console.log(`      got     : ${d.got.slice(0, 4).join(", ")}...`);
      }
    }
    console.log("");
    console.log("  Each disagreement is a rank the user could see move — and a");
    console.log("  RANK_INCREASED/RANK_DECREASED notification for a change that");
    console.log("  never happened.");
    console.log("");
  }

  console.log(bar);
  console.log("WHAT THIS DID NOT MEASURE");
  console.log(bar);
  console.log("  - ranking QUALITY. Order-invariance says the ranking is a function");
  console.log("    of the candidate set; it says nothing about whether the order is");
  console.log("    good. Relevance quality needs human judgements and is unmeasured.");
  console.log("  - MongoDB's actual return-order behaviour: the instability is");
  console.log("    demonstrated by permutation, not by observing Mongo reorder rows.");
  console.log("  - a real user population — the corpus is SYNTHETIC.");
  console.log(bar);

  if (OUT) {
    fs.writeFileSync(
      path.resolve(OUT),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          status,
          provenance: PROVENANCE,
          users: users.length,
          poolSize: pool.length,
          permutations: PERMUTATIONS,
          unstableUsers: unstable.length,
          observations,
          note:
            "Phase T ranking order-invariance. SYNTHETIC corpus. Measures whether " +
            "the ranking depends on input order, NOT whether the ranking is good.",
        },
        null,
        2
      )
    );
    console.log(`\nwrote ${OUT}`);
  }

  process.exit(status === "UNSTABLE" ? 1 : 0);
}

main();
