/**
 * EVALUATION METRICS — definitions and aggregation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS FOR, AND WHAT IT REFUSES TO DO
 * ---------------------------------------------------------------------------
 * Phases M and N record instrumentation on every call — latencies, chunk
 * counts, grounding outcomes, fallback methods. Until now nothing read them.
 * This turns those per-call records into aggregates.
 *
 * The design constraint that shaped everything here: **a measurement
 * instrument that reports a plausible wrong number is worse than one that
 * reports nothing.** A fabricated latency figure in a capstone is not a small
 * error — it is the kind that survives into a thesis, gets defended, and is
 * only caught by someone reproducing it.
 *
 * So three rules are enforced in code rather than left to discipline:
 *
 *   1. NO DEFAULTS. A metric with no observations reports `null`, never 0.
 *      Zero is a measurement; null is the absence of one, and the difference
 *      matters most exactly when a run went wrong.
 *
 *   2. QUALITY METRICS ARE GATED ON PROVIDER. Retrieval quality measured
 *      under the `local-hash` embedding provider is meaningless — it is
 *      lexical overlap, not semantics. `summarise()` marks any such run
 *      `qualityMeasurable: false` and every quality figure comes back null.
 *      The plumbing metrics still report, because they are provider-
 *      independent.
 *
 *   3. SAMPLE SIZES TRAVEL WITH THE NUMBERS. Every rate carries its `n`. A
 *      grounding-success rate of 1.0 over 3 questions is not a result, and
 *      the shape of the output should make that impossible to miss.
 */

/** Latency percentile. Nearest-rank; returns null on an empty sample. */
function percentile(values, p) {
  const xs = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  // Nearest-rank: ceil(p/100 * n), 1-indexed. Exact and easy to verify by
  // hand, which matters for a number that will be quoted.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function mean(values) {
  const xs = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return null;
  return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2));
}

/**
 * A rate, always reported with its denominator.
 *
 * `{value: null, n: 0}` rather than `{value: 0, n: 0}` — "no questions were
 * asked" and "no question succeeded" are different findings and must not
 * render identically.
 */
function rate(count, total) {
  if (!total) return { value: null, count: 0, n: 0 };
  return { value: Number((count / total).toFixed(4)), count, n: total };
}

/**
 * Unit-neutral distribution. Used for counts.
 *
 * Separate from `latency()` on purpose: an earlier draft reused the latency
 * helper for chunk counts, so "3 chunks per answer" was reported under the key
 * `meanMs`. Nothing would have errored, and a reader — or a thesis — would
 * have inherited a count labelled as milliseconds.
 */
function stats(values) {
  const xs = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  return {
    n: xs.length,
    mean: mean(xs),
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    max: xs.length ? Math.max(...xs) : null,
  };
}

/** Millisecond distribution. Keys carry the unit so they cannot be misread. */
function latency(values) {
  const s = stats(values);
  return { n: s.n, meanMs: s.mean, p50Ms: s.p50, p95Ms: s.p95, maxMs: s.max };
}

/**
 * Which answer methods count as a fallback away from the LLM.
 *
 * Named explicitly rather than inferred as "not llm", because the three are
 * different events and collapsing them would hide the interesting one:
 *
 *   deterministic-fallback   the provider was unavailable
 *   deterministic-override   the model CONTRADICTED the matcher
 *   deterministic-ungrounded the model invented a figure
 *
 * The last two are safety-guard activations, not outages. A run where the
 * fallback rate is high because the provider was down and a run where it is
 * high because the model kept lying are the same number and opposite findings.
 */
const FALLBACK_METHODS = Object.freeze({
  "deterministic-fallback": "providerUnavailable",
  "deterministic-override": "contradictedMatcher",
  "deterministic-ungrounded": "ungroundedFigures",
});
/** LLM disabled by config — not a fallback, and not an LLM answer either. */
const DISABLED_METHOD = "deterministic";

/**
 * One observation per answered question.
 *
 * @param {Object} response  the conversationalAgent response
 * @param {Object} [extra]   {expectedIntent, questionId, category}
 */
function observe(response, extra = {}) {
  const m = response?.metrics || {};
  return {
    questionId: extra.questionId ?? null,
    category: extra.category ?? null,
    intent: response?.intent ?? null,
    expectedIntent: extra.expectedIntent ?? null,
    intentCorrect:
      extra.expectedIntent == null ? null : response?.intent === extra.expectedIntent,
    grounded: !!response?.grounded,
    groundingChecked: !!response?.groundingChecked,
    method: response?.method ?? null,
    fallbackKind: FALLBACK_METHODS[response?.method] || null,
    llmAnswered: response?.method === "llm",
    llmDisabled: response?.method === DISABLED_METHOD,
    retrievedChunks: typeof m.retrievedChunks === "number" ? m.retrievedChunks : null,
    sourceSchemes: Array.isArray(response?.sourceSchemes) ? response.sourceSchemes.length : null,
    retrievalMs: typeof m.retrievalMs === "number" ? m.retrievalMs : null,
    llmMs: typeof m.llmMs === "number" ? m.llmMs : null,
    totalMs: typeof m.totalMs === "number" ? m.totalMs : null,
    // Carried per-observation, because a run can be partly degraded — a
    // provider that fails halfway through is exactly the case a run-level flag
    // would smooth over.
    degraded: Array.isArray(response?.degraded) ? response.degraded.length > 0 : false,
    embeddingDegraded: !!extra.embeddingDegraded,
    // Retrieval hit, ONLY when the question carries a labelled expectation.
    // Unlabelled questions contribute `null` and are excluded from the
    // denominator — an unlabelled question is not a miss, it is not evidence
    // either way, and counting it as either would be inventing data.
    retrievalHit: computeRetrievalHit(response, extra.expectedSchemeIds),
  };
}

/**
 * Did retrieval surface at least one of the schemes the question is labelled
 * with?
 *
 * Returns null — not false — when there is no label. The distinction is the
 * whole point: precision@k over unlabelled questions is not a low score, it is
 * not a score.
 */
function computeRetrievalHit(response, expectedSchemeIds) {
  if (!Array.isArray(expectedSchemeIds) || expectedSchemeIds.length === 0) return null;
  const got = new Set(response?.sourceSchemes || []);
  return expectedSchemeIds.some((id) => got.has(id));
}

/**
 * Aggregate observations into a report.
 *
 * @param {Array} observations
 * @param {Object} env  {embeddingProvider, embeddingModel, vectorStrategy, llmProvider, chatLlmEnabled}
 */
function summarise(observations, env = {}) {
  const obs = observations || [];
  const n = obs.length;

  // The provider gate. `local-hash` is lexical; anything it produces measures
  // the plumbing, not retrieval quality. Rather than print a number with a
  // footnote nobody reads, the quality block is withheld entirely.
  const lexicalOnly =
    String(env.embeddingProvider || "").toLowerCase() === "local-hash" ||
    obs.some((o) => o.embeddingDegraded);
  const qualityMeasurable = n > 0 && !lexicalOnly;

  const withIntentLabel = obs.filter((o) => o.intentCorrect !== null);
  const llmAttempted = obs.filter((o) => !o.llmDisabled);

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      embeddingProvider: env.embeddingProvider ?? null,
      embeddingModel: env.embeddingModel ?? null,
      vectorStrategy: env.vectorStrategy ?? null,
      llmProvider: env.llmProvider ?? null,
      chatLlmEnabled: env.chatLlmEnabled ?? null,
    },
    sample: { questions: n },

    // ---- provider-independent: structure and behaviour -------------------
    // These are honest under any provider, because they measure what the
    // system DID, not how well it understood anything.
    behaviour: {
      intentAccuracy: rate(withIntentLabel.filter((o) => o.intentCorrect).length, withIntentLabel.length),
      groundedRate: rate(obs.filter((o) => o.grounded).length, n),
      insufficientEvidenceRate: rate(obs.filter((o) => !o.grounded).length, n),
      groundingCheckRunRate: rate(obs.filter((o) => o.groundingChecked).length, n),
      llmFallbackRate: rate(obs.filter((o) => o.fallbackKind).length, llmAttempted.length),
      fallbackBreakdown: {
        providerUnavailable: obs.filter((o) => o.fallbackKind === "providerUnavailable").length,
        contradictedMatcher: obs.filter((o) => o.fallbackKind === "contradictedMatcher").length,
        ungroundedFigures: obs.filter((o) => o.fallbackKind === "ungroundedFigures").length,
      },
      degradedAnswerRate: rate(obs.filter((o) => o.degraded).length, n),
    },

    retrieval: {
      chunksReturned: stats(obs.map((o) => o.retrievedChunks)),
      zeroResultRate: rate(obs.filter((o) => o.retrievedChunks === 0).length, n),
      sourceSchemesPerAnswer: mean(obs.map((o) => o.sourceSchemes)),
    },

    latency: {
      retrieval: latency(obs.map((o) => o.retrievalMs)),
      llm: latency(obs.map((o) => o.llmMs)),
      endToEnd: latency(obs.map((o) => o.totalMs)),
    },

    // ---- gated: meaningless under a lexical provider ---------------------
    quality: qualityMeasurable
      ? {
          measurable: true,
          note: "Retrieval quality requires a labelled relevance set; see questionSet.expectedSchemeIds.",
          retrievalPrecisionAtK: rate(
            obs.filter((o) => o.retrievalHit === true).length,
            obs.filter((o) => typeof o.retrievalHit === "boolean").length
          ),
        }
      : {
          measurable: false,
          reason: lexicalOnly
            ? "embedding provider is lexical (local-hash) or vectors are flagged degraded — retrieval-quality figures from this run would measure word overlap, not semantics"
            : "no observations",
          retrievalPrecisionAtK: null,
        },
  };

  return report;
}

/**
 * Render a report as text. Deliberately prints `null` as "not measured"
 * rather than as a dash or a zero.
 */
function formatReport(report) {
  const L = [];
  const num = (v, suffix = "") => (v === null || v === undefined ? "not measured" : `${v}${suffix}`);
  const pct = (r) =>
    !r || r.value === null ? `not measured (n=${r ? r.n : 0})` : `${(r.value * 100).toFixed(1)}%  (${r.count}/${r.n})`;

  L.push("EVALUATION REPORT");
  L.push(`generated        ${report.generatedAt}`);
  L.push(`questions        ${report.sample.questions}`);
  L.push("");
  L.push("ENVIRONMENT");
  for (const [k, v] of Object.entries(report.environment)) L.push(`  ${k.padEnd(20)} ${v ?? "unset"}`);
  L.push("");
  L.push("BEHAVIOUR");
  L.push(`  intent accuracy          ${pct(report.behaviour.intentAccuracy)}`);
  L.push(`  grounded                 ${pct(report.behaviour.groundedRate)}`);
  L.push(`  insufficient evidence    ${pct(report.behaviour.insufficientEvidenceRate)}`);
  L.push(`  grounding check ran      ${pct(report.behaviour.groundingCheckRunRate)}`);
  L.push(`  LLM fallback             ${pct(report.behaviour.llmFallbackRate)}`);
  L.push(`    provider unavailable   ${report.behaviour.fallbackBreakdown.providerUnavailable}`);
  L.push(`    contradicted matcher   ${report.behaviour.fallbackBreakdown.contradictedMatcher}`);
  L.push(`    ungrounded figures     ${report.behaviour.fallbackBreakdown.ungroundedFigures}`);
  L.push("");
  L.push("RETRIEVAL");
  L.push(`  chunks per answer (mean) ${num(report.retrieval.chunksReturned.mean)}`);
  L.push(`  zero-result rate         ${pct(report.retrieval.zeroResultRate)}`);
  L.push("");
  L.push("LATENCY (ms)");
  for (const [k, v] of Object.entries(report.latency)) {
    L.push(`  ${k.padEnd(12)} n=${v.n}  mean=${num(v.meanMs)}  p50=${num(v.p50Ms)}  p95=${num(v.p95Ms)}`);
  }
  L.push("");
  L.push("QUALITY");
  if (report.quality.measurable) {
    L.push(`  precision@k              ${pct(report.quality.retrievalPrecisionAtK)}`);
  } else {
    L.push(`  WITHHELD — ${report.quality.reason}`);
  }
  return L.join("\n");
}

module.exports = {
  percentile,
  mean,
  rate,
  stats,
  latency,
  computeRetrievalHit,
  observe,
  summarise,
  formatReport,
  FALLBACK_METHODS,
  DISABLED_METHOD,
};
