/**
 * PHASE Q — aggregation and reporting for the propagation-soundness experiment.
 *
 * ---------------------------------------------------------------------------
 * THE REPORTING RULES, CARRIED OVER FROM PHASE O AND P
 * ---------------------------------------------------------------------------
 *   - unmeasured is `null`, never 0;
 *   - every rate is printed with its denominator;
 *   - a case that could not run is FAILED or NOT_MEASURED, never quietly
 *     dropped from the denominator;
 *   - the provenance of the population travels with the number.
 *
 * ---------------------------------------------------------------------------
 * WHY SOUNDNESS IS NOT AVERAGED
 * ---------------------------------------------------------------------------
 * Mean recall across cases is the natural-looking summary and it is the wrong
 * one. A mean of 0.98 reads like a good score; what it actually describes is a
 * system that failed to tell some people they had lost a benefit. There is no
 * amount of efficiency elsewhere that trades against that.
 *
 * So the headline is a COUNT of unsound cases and it must be zero, with recall
 * reported per case as supporting detail. A single unsound case makes the whole
 * run UNSOUND regardless of what the other cases did.
 */

const STATUS = Object.freeze({
  SOUND: "SOUND",
  UNSOUND: "UNSOUND",
  FAILED: "FAILED",
  NOT_MEASURED: "NOT_MEASURED",
});

const rate = (numerator, denominator) =>
  denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;

/**
 * Summarise a set of per-case comparisons.
 *
 * @param {Array} observations  one entry per corpus case
 * @param {Object} meta         provenance, population size, store kind
 */
function summarise(observations, meta = {}) {
  const ran = observations.filter((o) => o.status === STATUS.SOUND || o.status === STATUS.UNSOUND);
  const unsound = observations.filter((o) => o.status === STATUS.UNSOUND);
  const failed = observations.filter((o) => o.status === STATUS.FAILED);
  const notMeasured = observations.filter((o) => o.status === STATUS.NOT_MEASURED);

  // Cases where nothing moved cannot demonstrate soundness either way; they are
  // reported separately rather than counted as successes.
  const informative = ran.filter((o) => o.affectedByOracle > 0);

  const totalMissed = ran.reduce((sum, o) => sum + (o.missed?.length || 0), 0);
  const totalAffected = ran.reduce((sum, o) => sum + (o.affectedByOracle || 0), 0);

  // Narrowing is only meaningful where a band was actually attempted.
  const banded = informative.filter((o) => o.scannedEveryUser === false);
  const scanSaved = banded.reduce((sum, o) => sum + (o.oracleExamined - o.candidatesExamined), 0);
  const scanTotal = banded.reduce((sum, o) => sum + o.oracleExamined, 0);

  let runStatus;
  if (failed.length > 0) runStatus = STATUS.FAILED;
  else if (unsound.length > 0) runStatus = STATUS.UNSOUND;
  else if (informative.length === 0) runStatus = STATUS.NOT_MEASURED;
  else runStatus = STATUS.SOUND;

  return {
    status: runStatus,
    provenance: meta.provenance || "UNKNOWN",
    store: meta.store || "UNKNOWN",
    population: meta.population ?? null,
    cases: {
      total: observations.length,
      ran: ran.length,
      informative: informative.length,
      noUsersMoved: ran.length - informative.length,
      failed: failed.length,
      notMeasured: notMeasured.length,
    },
    soundness: {
      // The headline. Anything but 0 is a defect, not a score.
      unsoundCases: unsound.length,
      usersMissed: totalMissed,
      usersAffected: totalAffected,
      // Printed with its denominator wherever it is quoted.
      recallOverAllAffectedUsers: rate(totalAffected - totalMissed, totalAffected),
      unsoundCaseIds: unsound.map((o) => o.id),
    },
    narrowing: {
      // `null`, not 0, when no case attempted a band: nothing was measured.
      casesWithBand: banded.length,
      usersNotRescored: banded.length ? scanSaved : null,
      usersConsidered: banded.length ? scanTotal : null,
      scanReduction: banded.length ? rate(scanSaved, scanTotal) : null,
    },
    byCandidateSelection: groupBySelection(ran),
  };
}

/**
 * Per-mode breakdown.
 *
 * The research question is not "is the system sound on average" but "which
 * change shapes can be banded soundly, and how much does banding save on
 * those". That is a per-mode question, so the table is per mode.
 */
function groupBySelection(observations) {
  const out = {};
  for (const o of observations) {
    const key = o.candidateSelection || "unknown";
    out[key] = out[key] || {
      cases: 0,
      unsound: 0,
      usersAffected: 0,
      usersMissed: 0,
      candidatesExamined: 0,
      oracleExamined: 0,
    };
    const g = out[key];
    g.cases += 1;
    if (o.status === STATUS.UNSOUND) g.unsound += 1;
    g.usersAffected += o.affectedByOracle || 0;
    g.usersMissed += o.missed?.length || 0;
    g.candidatesExamined += o.candidatesExamined || 0;
    g.oracleExamined += o.oracleExamined || 0;
  }
  for (const g of Object.values(out)) {
    g.recall = rate(g.usersAffected - g.usersMissed, g.usersAffected);
    g.scanReduction = g.oracleExamined
      ? rate(g.oracleExamined - g.candidatesExamined, g.oracleExamined)
      : null;
  }
  return out;
}

/** Human-readable report. Every rate carries its denominator. */
function formatReport(summary, observations) {
  const L = [];
  const bar = "=".repeat(76);
  const n = (v) => (v === null || v === undefined ? "NOT MEASURED" : v);
  const pct = (v, num, den) =>
    v === null || v === undefined ? "NOT MEASURED" : `${(v * 100).toFixed(1)}%  (${num}/${den})`;

  L.push(bar);
  L.push("PHASE Q — PROPAGATION SOUNDNESS");
  L.push(bar);
  L.push(`population        : ${n(summary.population)} users`);
  L.push(`corpus provenance : ${summary.provenance}`);
  L.push(`user store        : ${summary.store}`);
  L.push(`run status        : ${summary.status}`);
  L.push("");

  L.push("-".repeat(76));
  L.push("SOUNDNESS — can the targeted band miss an affected user?");
  L.push("-".repeat(76));
  L.push(`unsound cases                 : ${summary.soundness.unsoundCases}   (must be 0)`);
  L.push(`users the pipeline never told : ${summary.soundness.usersMissed}`);
  L.push(
    `recall over affected users    : ${pct(
      summary.soundness.recallOverAllAffectedUsers,
      summary.soundness.usersAffected - summary.soundness.usersMissed,
      summary.soundness.usersAffected
    )}`
  );
  if (summary.soundness.unsoundCaseIds.length) {
    L.push(`UNSOUND CASES: ${summary.soundness.unsoundCaseIds.join(", ")}`);
  }
  L.push("");

  L.push("-".repeat(76));
  L.push("NARROWING — what the band saved, where one was attempted");
  L.push("-".repeat(76));
  if (summary.narrowing.casesWithBand === 0) {
    L.push("NOT MEASURED — no case in this run produced a targeted band.");
  } else {
    L.push(
      `users not re-scored : ${pct(
        summary.narrowing.scanReduction,
        summary.narrowing.usersNotRescored,
        summary.narrowing.usersConsidered
      )} across ${summary.narrowing.casesWithBand} case(s)`
    );
  }
  L.push("");

  L.push("-".repeat(76));
  L.push("PER CASE");
  L.push("-".repeat(76));
  L.push(
    "case".padEnd(26) +
      "selection".padEnd(18) +
      "affected".padStart(9) +
      "missed".padStart(8) +
      "scanned".padStart(9) +
      "  status"
  );
  for (const o of observations) {
    L.push(
      String(o.id).padEnd(26) +
        String(o.candidateSelection || "-").padEnd(18) +
        String(o.affectedByOracle ?? "-").padStart(9) +
        String(o.missed ? o.missed.length : "-").padStart(8) +
        String(
          o.candidatesExamined === undefined ? "-" : `${o.candidatesExamined}/${o.oracleExamined}`
        ).padStart(9) +
        "  " +
        o.status
    );
  }
  L.push("");

  L.push(bar);
  L.push("WHAT THIS RUN DID NOT MEASURE");
  L.push(bar);
  L.push("  - real policy changes: the corpus is SYNTHETIC and constructed to");
  L.push("    span change shapes, not to reflect how often they occur.");
  L.push("  - how often each shape occurs in Indian government policy.");
  if (summary.store === "SIMULATED_STORE") {
    L.push("  - MongoDB itself: filters were evaluated in process, so index");
    L.push("    behaviour and Mongo's own matching semantics are NOT covered.");
    L.push("    Run with --live against Atlas for that.");
  }
  L.push("  - notification delivery, LLM behaviour and retrieval quality:");
  L.push("    those are Phase L, Phase P and Phase O respectively.");
  L.push(bar);

  return L.join("\n");
}

module.exports = { summarise, groupBySelection, formatReport, STATUS };
