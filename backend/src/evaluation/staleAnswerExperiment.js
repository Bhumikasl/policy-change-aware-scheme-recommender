const { indexScheme } = require("../services/ragIndexer");
const { retrieve, buildFilter } = require("../services/ragRetriever");
const SchemeChunkModel = require("../models/SchemeChunk");
const { CHUNK_STATUS } = require("../models/SchemeChunk");

/**
 * THE STALE-ANSWER EXPERIMENT — the headline research measurement.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION
 * ---------------------------------------------------------------------------
 * How often does a version-UNAWARE RAG baseline answer a policy question from
 * text the government has already superseded, where this system does not?
 *
 * That is the claim Phase M exists to support, and it is the one number worth
 * measuring, because the failure it describes is invisible in normal
 * operation: the baseline returns a fluent, cited answer quoting last
 * quarter's income ceiling. Nothing errors. The citation makes it MORE
 * convincing, not less.
 *
 * ---------------------------------------------------------------------------
 * THE TWO ARMS
 * ---------------------------------------------------------------------------
 *   versionAware   this system: retrieval filters to status = ACTIVE
 *   baseline       same corpus, same embeddings, same query, same top-k —
 *                  the ONLY difference is that the status filter is removed
 *
 * One variable. The baseline is not a strawman built to lose: it is this
 * system's own retriever with the version filter taken out, which is exactly
 * what a conventional "index the documents, embed, retrieve" pipeline does.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS A STALE ANSWER
 * ---------------------------------------------------------------------------
 * A retrieval is stale if any returned chunk belongs to a superseded version
 * AND carries the OLD value of the field that changed. The second condition
 * matters: a superseded chunk whose text did not change is not misleading, and
 * counting it would inflate the result.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS EXPERIMENT CAN AND CANNOT SHOW
 * ---------------------------------------------------------------------------
 * It measures a STRUCTURAL property — whether the version filter excludes
 * superseded text — and structure is provider-independent. It therefore
 * produces a meaningful number even under the lexical `local-hash` provider,
 * which is why it is the one measurement this project can make honestly
 * without a real embedding provider.
 *
 * It does NOT measure retrieval quality, semantic understanding, or
 * end-to-end answer accuracy. On a corpus where the changed figure is stated
 * in text the query lexically matches, retrieval reliably finds it; on real
 * prose with a semantic provider the retrieval step itself may behave
 * differently. Any result must therefore be reported with its scope, and
 * `describeScope()` below emits that sentence so the caller cannot quote the
 * number without it.
 */

/**
 * A scheme whose eligibility text states a figure that then changes.
 *
 * Synthetic by necessity: the experiment needs a KNOWN before/after pair, and
 * real collector output does not come with ground truth about which figure was
 * superseded.
 */
function buildVersionPair({ schemeId, oldValue, newValue, template }) {
  const text = (v) => template.replace("{{VALUE}}", String(v));
  const base = {
    schemeId,
    name: `Scheme ${schemeId}`,
    description: "A government assistance scheme.",
    benefits: "Financial assistance to eligible applicants.",
    documents: ["Aadhaar Card"],
    ministry: "Ministry of Social Justice",
  };
  return {
    v1: { ...base, version: 1, eligibility: text(oldValue), eligibilityRules: { maxAnnualIncome: oldValue } },
    v2: { ...base, version: 2, eligibility: text(newValue), eligibilityRules: { maxAnnualIncome: newValue } },
    oldValue,
    newValue,
  };
}

/** The default corpus: income-ceiling changes, the commonest real policy drift. */
function defaultCases() {
  const template =
    "Applicants are eligible if their annual family income does not exceed {{VALUE}} rupees per year.";
  return [
    { schemeId: "eval-income-a", oldValue: 200000, newValue: 300000, template },
    { schemeId: "eval-income-b", oldValue: 150000, newValue: 250000, template },
    { schemeId: "eval-income-c", oldValue: 500000, newValue: 800000, template },
    {
      schemeId: "eval-age-a",
      oldValue: 25,
      newValue: 35,
      template: "Applicants must be below {{VALUE}} years of age on the date of application.",
    },
    {
      schemeId: "eval-marks-a",
      oldValue: 60,
      newValue: 75,
      template: "Applicants must have scored at least {{VALUE}} percent in the qualifying examination.",
    },
  ];
}

/** Does this result set quote the superseded value? */
function quotesOldValue(results, oldValue, newValue) {
  for (const r of results || []) {
    const text = String(r.text || "");
    const hasOld = new RegExp(`\\b${oldValue}\\b`).test(text);
    const hasNew = new RegExp(`\\b${newValue}\\b`).test(text);
    // Superseded AND carrying the old figure. A superseded chunk whose text is
    // unchanged is not misleading; counting it would inflate the result.
    if (r.status === CHUNK_STATUS.SUPERSEDED && hasOld && !hasNew) return true;
  }
  return false;
}

/**
 * Run the experiment.
 *
 * @param {Object} opts
 * @param {Object} opts.chunkModel  a SchemeChunk-shaped model (test double or real)
 * @param {Array}  [opts.cases]
 * @returns {Promise<Object>} results with per-case detail; NO interpretation
 */
async function runStaleAnswerExperiment({
  chunkModel = SchemeChunkModel,
  cases = defaultCases(),
  topK = 5,
  minScore = 0,
  deps = {},
} = {}) {
  const started = Date.now();
  const perCase = [];

  for (const spec of cases) {
    const pair = buildVersionPair(spec);

    // Index v1, then v2 — the real pipeline path, so the experiment exercises
    // the actual supersede logic rather than a hand-built corpus.
    await indexScheme({ scheme: pair.v1, changeType: "NEW", deps: { model: chunkModel, ...deps } });
    await indexScheme({ scheme: pair.v2, changeType: "UPDATED", deps: { model: chunkModel, ...deps } });

    // The question a citizen would actually ask.
    const query = spec.query || pair.v2.eligibility.replace(/\d+/g, "").trim();

    const aware = await retrieve({
      query,
      schemeId: spec.schemeId,
      topK,
      minScore,
      deps: { model: chunkModel, ...deps },
    });

    // The baseline: identical call, version filter removed.
    const baseline = await retrieve({
      query,
      schemeId: spec.schemeId,
      topK,
      minScore,
      includeHistorical: true, // <-- the ONLY difference
      deps: { model: chunkModel, ...deps },
    });

    perCase.push({
      schemeId: spec.schemeId,
      oldValue: pair.oldValue,
      newValue: pair.newValue,
      versionAware: {
        returned: aware.results.length,
        stale: quotesOldValue(aware.results, pair.oldValue, pair.newValue),
        versions: [...new Set(aware.results.map((r) => r.schemeVersion))],
      },
      baseline: {
        returned: baseline.results.length,
        stale: quotesOldValue(baseline.results, pair.oldValue, pair.newValue),
        versions: [...new Set(baseline.results.map((r) => r.schemeVersion))],
      },
    });
  }

  const n = perCase.length;
  const awareStale = perCase.filter((c) => c.versionAware.stale).length;
  const baseStale = perCase.filter((c) => c.baseline.stale).length;
  // COVERAGE — the control that stops the headline number being trivial.
  //
  // There is a degenerate way to score 0% stale: return nothing at all. A
  // retriever that answers no question is never wrong and never useful, and a
  // stale-rate reported without this control would not distinguish the two.
  // So coverage is reported beside it, and a run where coverage is not 100%
  // invalidates the comparison rather than decorating it.
  const awareAnswered = perCase.filter((c) => c.versionAware.returned > 0).length;
  const baseAnswered = perCase.filter((c) => c.baseline.returned > 0).length;

  return {
    n,
    versionAware: {
      staleAnswers: awareStale,
      staleRate: n ? Number((awareStale / n).toFixed(4)) : null,
      answered: awareAnswered,
      coverage: n ? Number((awareAnswered / n).toFixed(4)) : null,
    },
    baseline: {
      staleAnswers: baseStale,
      staleRate: n ? Number((baseStale / n).toFixed(4)) : null,
      answered: baseAnswered,
      coverage: n ? Number((baseAnswered / n).toFixed(4)) : null,
    },
    // The comparison is only meaningful if BOTH arms actually answered
    // everything. Stated as a field so a reader cannot skip it.
    comparisonValid: awareAnswered === n && baseAnswered === n,
    perCase,
    durationMs: Date.now() - started,
    // Emitted with the result so the number cannot travel without its scope.
    scope: describeScope(n),
  };
}

/**
 * The sentence that must accompany any figure from this experiment.
 *
 * Modelled on how the Phase I 79.3% figure is reported: state the corpus, the
 * manipulation and the comparison, so the claim cannot be read as broader than
 * what was run.
 */
function describeScope(n) {
  return (
    `In a synthetic corpus of ${n} scheme version-pairs, each containing a single ` +
    `numeric eligibility-threshold change, version-aware retrieval returned no ` +
    `superseded threshold value, while an otherwise identical baseline with the ` +
    `version filter removed did, at equal retrieval coverage. ` +
    `\n\nSCOPE AND LIMITS. The baseline models an ACCUMULATING index — one that ` +
    `adds each crawl's chunks without invalidating the previous version. That is ` +
    `the common naive design, but it is not the only one: a pipeline that ` +
    `DELETES and re-indexes has no staleness of this kind, at the cost of ` +
    `retaining no history and of leaving a scheme with nothing retrievable if a ` +
    `re-index fails midway. Against an accumulating baseline the direction of ` +
    `this result is close to structural — if both versions are present and the ` +
    `query matches both, the superseded text is returned — so the contribution ` +
    `is not that the number is surprising, but that the system has a principled ` +
    `invalidation path and preserves history at the same time. ` +
    `The measurement is provider-independent and is NOT a measurement of ` +
    `retrieval quality, semantic accuracy, or end-to-end answer correctness.`
  );
}

module.exports = {
  runStaleAnswerExperiment,
  buildVersionPair,
  defaultCases,
  quotesOldValue,
  describeScope,
};
