/**
 * PHASE R — aggregation and reporting for the notification-cost experiment.
 *
 * Same reporting rules as O, P and Q: unmeasured is `null` and never 0, every
 * rate carries its denominator, a case that could not run is reported rather
 * than dropped, and the provenance of the population travels with the number.
 *
 * ---------------------------------------------------------------------------
 * THE ONE JUDGEMENT THIS FILE MAKES
 * ---------------------------------------------------------------------------
 * "Fewer notifications" is only a good result if the ones removed were the ones
 * nobody needed. A path that notifies nobody scores perfectly on volume and is
 * useless. So volume reduction is reported ONLY alongside the count of users
 * the targeted path reached that the legacy path missed — which is where the
 * legacy path's own correctness gap shows up, since it can only ever email
 * people who match the scheme AFTER the change, and is therefore blind to
 * everyone who just lost eligibility.
 */

const STATUS = Object.freeze({
  MEASURED: "MEASURED",
  NOT_MEASURED: "NOT_MEASURED",
  FAILED: "FAILED",
});

const rate = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : null);

function summarise(observations, meta = {}) {
  const ran = observations.filter((o) => o.status !== STATUS.FAILED);
  const failed = observations.filter((o) => o.status === STATUS.FAILED);

  const legacyTotal = ran.reduce((s, o) => s + (o.legacy?.notified || 0), 0);
  const targetedTotal = ran.reduce((s, o) => s + (o.targeted?.notified || 0), 0);
  const legacyScanned = ran.reduce((s, o) => s + (o.legacy?.usersScanned || 0), 0);
  const targetedScanned = ran.reduce((s, o) => s + (o.targeted?.usersScanned || 0), 0);
  const legacyOnly = ran.reduce((s, o) => s + (o.notifiedByLegacyOnly || 0), 0);
  const targetedOnly = ran.reduce((s, o) => s + (o.notifiedByTargetedOnly || 0), 0);

  return {
    status: failed.length ? STATUS.FAILED : ran.length ? STATUS.MEASURED : STATUS.NOT_MEASURED,
    provenance: meta.provenance || "UNKNOWN",
    population: meta.population ?? null,
    cases: { total: observations.length, ran: ran.length, failed: failed.length },

    // R.1 — the deferred question, answered.
    notificationVolume: {
      legacy: legacyTotal,
      targeted: targetedTotal,
      // `null` when the legacy path notified nobody: there is no reduction to
      // express as a fraction of zero, and 0 or 1 would both be misleading.
      reduction: legacyTotal > 0 ? rate(legacyTotal - targetedTotal, legacyTotal) : null,
      interruptionsAvoided: legacyTotal - targetedTotal,
    },

    usersScanned: {
      legacy: legacyScanned,
      targeted: targetedScanned,
      reduction: legacyScanned > 0 ? rate(legacyScanned - targetedScanned, legacyScanned) : null,
    },

    // The honesty counterweight to the volume figure.
    coverage: {
      // People the legacy path emailed and the targeted path did not: users for
      // whom nothing moved.
      notifiedByLegacyOnly: legacyOnly,
      // People the targeted path reached and the legacy path could not. The
      // legacy filter is `isMatch(user, schemeAfter)`, so anyone who LOST
      // eligibility fails it and is never told. This is a correctness gap in
      // the baseline, surfaced rather than buried in a favourable ratio.
      notifiedByTargetedOnly: targetedOnly,
    },
  };
}

/**
 * R.2 — the broker decision.
 *
 * NOTIFICATION_ARCHITECTURE.md: "Revisit when a measured collection cycle
 * spends a material fraction of its time in delivery."
 *
 * This turns that sentence into an arithmetic test against recorded stage
 * timings. `null` in, `NOT_MEASURED` out — a cycle that never ran the
 * notification stage says nothing about whether a broker is warranted.
 */
function brokerRecommendation(cycles = [], { materialFraction = 0.25 } = {}) {
  const usable = cycles.filter(
    (c) => typeof c.totalMs === "number" && c.totalMs > 0 && typeof c.notificationDurationMs === "number"
  );
  if (usable.length === 0) {
    return {
      status: STATUS.NOT_MEASURED,
      reason:
        "no cycle recorded both a total duration and a notification duration — " +
        "the delivery stage did not run, or predates the Phase R instrumentation",
      deliveryFraction: null,
      threshold: materialFraction,
      recommendBroker: null,
      n: 0,
    };
  }

  const totalMs = usable.reduce((s, c) => s + c.totalMs, 0);
  const deliveryMs = usable.reduce((s, c) => s + c.notificationDurationMs, 0);
  const fraction = rate(deliveryMs, totalMs);

  return {
    status: STATUS.MEASURED,
    deliveryMs,
    totalMs,
    deliveryFraction: fraction,
    threshold: materialFraction,
    // The documented trigger condition, evaluated. Not a recommendation to
    // adopt a broker on general principle — a reading of the rule the
    // architecture document already committed to.
    recommendBroker: fraction >= materialFraction,
    n: usable.length,
  };
}

function formatReport(summary, observations, broker) {
  const L = [];
  const bar = "=".repeat(76);
  const pct = (v, n, d) => (v === null || v === undefined ? "NOT MEASURED" : `${(v * 100).toFixed(1)}%  (${n}/${d})`);

  L.push(bar);
  L.push("PHASE R — NOTIFICATION COST");
  L.push(bar);
  L.push(`population        : ${summary.population ?? "NOT MEASURED"} users`);
  L.push(`corpus provenance : ${summary.provenance}`);
  L.push(`run status        : ${summary.status}`);
  L.push("");

  L.push("-".repeat(76));
  L.push("R.1 — does the targeted flow interrupt fewer people?");
  L.push("-".repeat(76));
  L.push(`legacy full-scan notified   : ${summary.notificationVolume.legacy}`);
  L.push(`targeted flow notified      : ${summary.notificationVolume.targeted}`);
  L.push(
    `reduction in interruptions  : ${pct(
      summary.notificationVolume.reduction,
      summary.notificationVolume.interruptionsAvoided,
      summary.notificationVolume.legacy
    )}`
  );
  L.push(
    `users scanned               : ${pct(
      summary.usersScanned.reduction,
      summary.usersScanned.legacy - summary.usersScanned.targeted,
      summary.usersScanned.legacy
    )} fewer`
  );
  L.push("");
  L.push("  COVERAGE — fewer is only better if the right people still hear:");
  L.push(`    reached by legacy only   : ${summary.coverage.notifiedByLegacyOnly}  (nothing moved for them)`);
  L.push(`    reached by targeted only : ${summary.coverage.notifiedByTargetedOnly}  (legacy could not see them)`);
  L.push("");

  L.push("-".repeat(76));
  L.push("PER CASE");
  L.push("-".repeat(76));
  L.push("case".padEnd(26) + "selection".padEnd(17) + "legacy".padStart(8) + "targeted".padStart(9) + "scanned".padStart(10));
  for (const o of observations) {
    if (o.status === STATUS.FAILED) {
      L.push(String(o.id).padEnd(26) + "FAILED: " + String(o.error).slice(0, 40));
      continue;
    }
    L.push(
      String(o.id).padEnd(26) +
        String(o.targeted.candidateSelection || "-").padEnd(17) +
        String(o.legacy.notified).padStart(8) +
        String(o.targeted.notified).padStart(9) +
        `${o.targeted.usersScanned}/${o.legacy.usersScanned}`.padStart(10)
    );
  }
  L.push("");

  L.push("-".repeat(76));
  L.push("R.2 — does a collection cycle spend a material fraction in delivery?");
  L.push("-".repeat(76));
  if (broker.status === STATUS.NOT_MEASURED) {
    L.push(`NOT MEASURED — ${broker.reason}`);
    L.push("A broker cannot be justified or ruled out from an unmeasured cycle.");
  } else {
    L.push(`delivery share of cycle : ${pct(broker.deliveryFraction, broker.deliveryMs, broker.totalMs)} over n=${broker.n}`);
    L.push(`documented threshold    : ${(broker.threshold * 100).toFixed(0)}%`);
    L.push(`broker warranted        : ${broker.recommendBroker ? "YES" : "NO"}`);
  }
  L.push("");

  L.push(bar);
  L.push("WHAT THIS RUN DID NOT MEASURE");
  L.push(bar);
  L.push("  - real SMTP, MongoDB or Atlas latency: no email was sent and no");
  L.push("    database was contacted. Timings are in-process compute only.");
  L.push("  - a real user population: the corpus is SYNTHETIC and shared with");
  L.push("    Phase Q. It says nothing about how often each change shape occurs.");
  L.push("  - throughput under concurrency.");
  L.push(bar);
  return L.join("\n");
}

module.exports = { summarise, brokerRecommendation, formatReport, STATUS };
