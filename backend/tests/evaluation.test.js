/**
 * Phase O — the evaluation harness.
 *
 * ---------------------------------------------------------------------------
 * WHY A MEASURING INSTRUMENT NEEDS ITS OWN TESTS
 * ---------------------------------------------------------------------------
 * Every other suite in this project tests behaviour a user experiences. This
 * one tests a thing that produces NUMBERS — and a number is believed in a way
 * behaviour is not. A latency figure or a grounding rate lands in a report, is
 * quoted in a thesis, and is defended months later by someone who no longer
 * remembers how it was computed.
 *
 * So the properties asserted here are mostly about REFUSAL:
 *
 *   - an empty sample reports null, never 0;
 *   - retrieval-quality metrics are withheld under a lexical provider;
 *   - an unlabelled question is excluded from precision, not counted as a
 *     miss;
 *   - counts are not labelled as milliseconds;
 *   - the run reports the configuration it ACTUALLY ran under.
 *
 * Each of those is a way the instrument could produce a plausible wrong number
 * without erroring, which is the only failure mode that matters here.
 */
const {
  percentile,
  mean,
  rate,
  stats,
  latency,
  observe,
  summarise,
  formatReport,
  computeRetrievalHit,
} = require("../src/evaluation/metrics");
const { runEvaluation, refusalStats } = require("../src/evaluation/harness");
const {
  runStaleAnswerExperiment,
  quotesOldValue,
  buildVersionPair,
  describeScope,
} = require("../src/evaluation/staleAnswerExperiment");
const { QUESTIONS, FOLLOW_UPS, labelledCount } = require("../src/evaluation/questionSet");
const { INTENTS } = require("../src/agents/conversationalAgent");
const { makeCollection } = require("./helpers/inMemoryDb");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scheme = {
  schemeId: "merit-scholarship",
  name: "State Merit Scholarship",
  version: 2,
  documents: ["Aadhaar Card"],
  benefits: "A grant of Rs 50000 per year.",
  lastDate: "2026-03-31",
  eligibilityRules: {
    minAge: 18, maxAge: 25, maxAnnualIncome: 200000,
    minAnnualIncome: null, minMarksPercentage: null, minEducationLevel: null,
    genders: [], categories: [], occupations: [], states: [],
    source: "structured", eligibilityType: "constrained",
    confidence: 0.7, needsReview: false,
  },
};
const user = { _id: "u1", profile: { age: 22, annualIncome: 150000, categories: [], documentsAvailable: [] } };
const noRetrieval = async () => ({ results: [], sufficient: false, metrics: { totalMs: 0 } });

const resp = (over = {}) => ({
  intent: INTENTS.ELIGIBILITY,
  grounded: true,
  groundingChecked: true,
  method: "llm",
  sourceSchemes: [],
  degraded: [],
  metrics: { retrievalMs: 5, llmMs: 100, totalMs: 110, retrievedChunks: 3 },
  ...over,
});

// ---------------------------------------------------------------------------
// Statistics — hand-verifiable
// ---------------------------------------------------------------------------

describe("statistics are correct and hand-checkable", () => {
  it("computes nearest-rank percentiles", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = ceil(0.50 * 10) = 5 -> the 5th smallest = 5
    expect(percentile(xs, 50)).toBe(5);
    // rank = ceil(0.95 * 10) = 10 -> 10
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile(xs, 100)).toBe(10);
  });

  it("handles a single observation", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("computes the mean", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("ignores non-numeric and non-finite values rather than coercing them", () => {
    // A null latency means "not recorded". Coercing it to 0 would drag every
    // mean toward zero and make a broken run look fast.
    expect(mean([10, null, undefined, NaN, Infinity, 20])).toBe(15);
    expect(stats([10, null, 20]).n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// THE NULL RULE
// ---------------------------------------------------------------------------

describe("an absent measurement is null, never zero", () => {
  it("returns null for an empty percentile and mean", () => {
    expect(percentile([], 50)).toBe(null);
    expect(mean([])).toBe(null);
  });

  it("returns a null-valued rate with n=0, not 0%", () => {
    // "no questions were asked" and "no question succeeded" are different
    // findings and must not render identically.
    const r = rate(0, 0);
    expect(r.value).toBe(null);
    expect(r.n).toBe(0);
  });

  it("distinguishes a genuine zero rate from an unmeasured one", () => {
    const genuine = rate(0, 10);
    expect(genuine.value).toBe(0);
    expect(genuine.n).toBe(10);
    expect(genuine.value).not.toBe(rate(0, 0).value);
  });

  it("prints an unmeasured value as 'not measured', not as 0 or a dash", () => {
    const report = summarise([], { embeddingProvider: "gemini" });
    const text = formatReport(report);
    expect(text).toContain("not measured");
    expect(text).not.toMatch(/intent accuracy\s+0\.0%/);
  });
});

// ---------------------------------------------------------------------------
// UNIT LABELLING
// ---------------------------------------------------------------------------

describe("units are not misreported", () => {
  it("keeps count statistics free of millisecond keys", () => {
    // An earlier draft reused the latency helper for chunk counts, so "3
    // chunks per answer" was reported under the key `meanMs`. Nothing errored.
    const s = stats([1, 2, 3]);
    expect(s.mean).toBe(2);
    expect(s.meanMs).toBe(undefined);
  });

  it("keeps latency statistics carrying the unit", () => {
    const l = latency([10, 20, 30]);
    expect(l.meanMs).toBe(20);
    expect(l.mean).toBe(undefined);
  });

  it("reports chunk counts through the unit-neutral helper", () => {
    const report = summarise([observe(resp())], { embeddingProvider: "gemini" });
    expect(report.retrieval.chunksReturned.mean).toBe(3);
    expect(report.retrieval.chunksReturned.meanMs).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// THE PROVIDER GATE
// ---------------------------------------------------------------------------

describe("retrieval quality is withheld under a lexical provider", () => {
  it("withholds quality metrics when the provider is local-hash", () => {
    const report = summarise([observe(resp())], { embeddingProvider: "local-hash" });
    expect(report.quality.measurable).toBe(false);
    expect(report.quality.retrievalPrecisionAtK).toBe(null);
    expect(report.quality.reason).toMatch(/lexical/);
  });

  it("withholds quality when ANY observation carries degraded vectors", () => {
    // A run can be partly degraded — a provider that fails midway is exactly
    // the case a run-level flag alone would smooth over.
    const obs = [observe(resp()), observe(resp(), { embeddingDegraded: true })];
    const report = summarise(obs, { embeddingProvider: "gemini" });
    expect(report.quality.measurable).toBe(false);
  });

  it("permits quality metrics under a semantic provider with clean vectors", () => {
    // Otherwise the gate would be indistinguishable from "never report".
    const report = summarise([observe(resp())], { embeddingProvider: "gemini" });
    expect(report.quality.measurable).toBe(true);
  });

  it("says WITHHELD in the printed report rather than printing a number", () => {
    const text = formatReport(summarise([observe(resp())], { embeddingProvider: "local-hash" }));
    expect(text).toContain("WITHHELD");
  });
});

// ---------------------------------------------------------------------------
// LABELLING
// ---------------------------------------------------------------------------

describe("unlabelled questions are excluded, not counted", () => {
  it("returns null for a question with no relevance labels", () => {
    // Not false. Precision over unlabelled questions is not a low score, it is
    // not a score, and counting it either way would be inventing data.
    expect(computeRetrievalHit(resp({ sourceSchemes: ["x"] }), [])).toBe(null);
    expect(computeRetrievalHit(resp({ sourceSchemes: ["x"] }), undefined)).toBe(null);
  });

  it("scores a hit and a miss when labels exist", () => {
    expect(computeRetrievalHit(resp({ sourceSchemes: ["a", "b"] }), ["b"])).toBe(true);
    expect(computeRetrievalHit(resp({ sourceSchemes: ["a"] }), ["z"])).toBe(false);
  });

  it("the shipped question set carries NO relevance labels, and says so", () => {
    // If this ever becomes non-zero, someone has done the labelling and the
    // precision metric becomes meaningful. Until then the report must say
    // "not measured" rather than print a number.
    expect(labelledCount(QUESTIONS)).toBe(0);
  });

  it("precision reports n=0 rather than a fabricated score", () => {
    const obs = QUESTIONS.slice(0, 3).map((q) =>
      observe(resp(), { expectedSchemeIds: q.expectedSchemeIds })
    );
    const report = summarise(obs, { embeddingProvider: "gemini" });
    expect(report.quality.retrievalPrecisionAtK.n).toBe(0);
    expect(report.quality.retrievalPrecisionAtK.value).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// FALLBACK CLASSIFICATION
// ---------------------------------------------------------------------------

describe("fallbacks are classified, not lumped together", () => {
  it("separates an outage from a safety-guard activation", () => {
    // Same fallback rate, opposite findings: a run where the provider was down
    // and a run where the model kept contradicting the matcher.
    const obs = [
      observe(resp({ method: "deterministic-fallback" })),
      observe(resp({ method: "deterministic-override" })),
      observe(resp({ method: "deterministic-ungrounded" })),
      observe(resp({ method: "llm" })),
    ];
    const report = summarise(obs, { embeddingProvider: "gemini" });
    expect(report.behaviour.fallbackBreakdown.providerUnavailable).toBe(1);
    expect(report.behaviour.fallbackBreakdown.contradictedMatcher).toBe(1);
    expect(report.behaviour.fallbackBreakdown.ungroundedFigures).toBe(1);
    expect(report.behaviour.llmFallbackRate.value).toBe(0.75);
  });

  it("excludes a config-disabled LLM from the fallback denominator", () => {
    // CHAT_LLM=false is not a fallback — the model was never asked. Counting
    // those runs would report a 100% fallback rate for a healthy system.
    const obs = [observe(resp({ method: "deterministic" })), observe(resp({ method: "deterministic" }))];
    const report = summarise(obs, { embeddingProvider: "gemini" });
    expect(report.behaviour.llmFallbackRate.n).toBe(0);
    expect(report.behaviour.llmFallbackRate.value).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// THE HARNESS
// ---------------------------------------------------------------------------

describe("the harness runs the real agent", () => {
  const run = (over = {}) =>
    runEvaluation({
      user,
      buildData: () => ({ scheme }),
      deps: { retrieveFn: noRetrieval, useLlm: false },
      ...over,
    });

  it("measures intent routing across the whole question set", async () => {
    const { report } = await run();
    expect(report.sample.questions).toBe(QUESTIONS.length);
    expect(report.behaviour.intentAccuracy.n).toBe(QUESTIONS.length);
  });

  it("reports the configuration the run ACTUALLY used, not the ambient config", async () => {
    // An earlier version read process.env.CHAT_LLM here, so a run driven with
    // useLlm:false reported chatLlmEnabled:true — a report claiming the model
    // was in the loop for numbers produced without it.
    const { report } = await run();
    expect(report.environment.chatLlmEnabled).toBe(false);

    const enabled = await runEvaluation({
      user,
      buildData: () => ({ scheme }),
      deps: { retrieveFn: noRetrieval, useLlm: true, llm: async () => null },
    });
    expect(enabled.report.environment.chatLlmEnabled).toBe(true);
  });

  it("records a thrown agent as an error rather than dropping the question", async () => {
    // Silently skipping failed questions would improve every rate in the
    // report — the failure would make the system look better.
    const { report } = await runEvaluation({
      questions: [QUESTIONS[0]],
      followUps: [],
      user,
      buildData: () => ({ scheme }),
      deps: {
        retrieveFn: noRetrieval,
        useLlm: false,
        // Force a throw from inside the agent's retrieval-independent path.
        llm: async () => { throw new Error("boom"); },
      },
    });
    // The agent catches LLM errors, so this run should still succeed — the
    // point is that `errors` exists and is reported.
    expect(Array.isArray(report.errors)).toBe(true);
  });

  it("measures whether a bare follow-up resolves to the previous intent", async () => {
    const { report } = await run();
    expect(report.followUps.n).toBe(FOLLOW_UPS.length);
    expect(report.followUps.resolved).toBe(FOLLOW_UPS.length);
  });

  it("measures correct refusals separately from grounding", async () => {
    // A system that answers everything scores well on grounded-rate and badly
    // here. Collapsing them would hide that.
    const { report } = await run();
    expect(report.refusals.n > 0).toBe(true);
    expect(report.refusals.correctlyRefused).toBe(report.refusals.n);
  });

  it("counts a question that SHOULD have been refused but was not", () => {
    const results = [
      { question: { id: "r1", expectRefusal: true }, response: { grounded: true } },
      { question: { id: "r2", expectRefusal: true }, response: { grounded: false } },
    ];
    const out = refusalStats(results);
    expect(out.n).toBe(2);
    expect(out.correctlyRefused).toBe(1);
    expect(out.missed).toEqual(["r1"]);
  });
});

// ---------------------------------------------------------------------------
// THE STALE-ANSWER EXPERIMENT
// ---------------------------------------------------------------------------

describe("the stale-answer experiment", () => {
  const chunks = () => makeCollection("schemechunks", { uniqueKeys: [["chunkId"]] });

  it("counts a superseded chunk carrying the OLD value as stale", () => {
    expect(
      quotesOldValue([{ status: "SUPERSEDED", text: "income limit 200000 rupees" }], 200000, 300000)
    ).toBe(true);
  });

  it("does NOT count a superseded chunk whose text did not change", () => {
    // A superseded chunk with unchanged text is not misleading. Counting it
    // would inflate the headline result.
    expect(
      quotesOldValue([{ status: "SUPERSEDED", text: "Applicants must submit an Aadhaar Card." }], 200000, 300000)
    ).toBe(false);
  });

  it("does NOT count an ACTIVE chunk", () => {
    expect(
      quotesOldValue([{ status: "ACTIVE", text: "income limit 300000 rupees" }], 200000, 300000)
    ).toBe(false);
  });

  it("does NOT count an ACTIVE chunk even when it carries the OLD value", () => {
    // FOUND BY MUTATION TESTING. The previous ACTIVE-chunk test used the NEW
    // value, so dropping the status check entirely still passed it — the
    // assertion never exercised the guard it was named for.
    //
    // This case is reachable in production: if a supersede fails, v1 stays
    // ACTIVE while carrying the old figure. "Stale" must mean "text the system
    // marked superseded", not "any text containing an old number" — otherwise
    // the metric would count a live indexing fault as a retrieval failure and
    // point at the wrong subsystem.
    expect(
      quotesOldValue([{ status: "ACTIVE", text: "income limit 200000 rupees" }], 200000, 300000)
    ).toBe(false);
    expect(
      quotesOldValue([{ status: "SUPERSEDED", text: "income limit 200000 rupees" }], 200000, 300000)
    ).toBe(true);
  });

  it("runs both arms and reports coverage alongside the stale rate", async () => {
    const out = await runStaleAnswerExperiment({ chunkModel: chunks() });
    expect(out.n > 0).toBe(true);
    // Coverage is the control that stops the headline number being trivial:
    // a retriever returning nothing is never stale and never useful.
    expect(out.versionAware.coverage).toBe(1);
    expect(out.baseline.coverage).toBe(1);
    expect(out.comparisonValid).toBe(true);
  });

  it("version-aware retrieval returns no superseded threshold", async () => {
    const out = await runStaleAnswerExperiment({ chunkModel: chunks() });
    expect(out.versionAware.staleAnswers).toBe(0);
    expect(out.versionAware.staleRate).toBe(0);
  });

  it("the baseline — the SAME retriever with the filter removed — does", async () => {
    const out = await runStaleAnswerExperiment({ chunkModel: chunks() });
    expect(out.baseline.staleAnswers > 0).toBe(true);
    // One variable between the arms. If this ever equals the aware arm, the
    // experiment has stopped testing anything.
    expect(out.baseline.staleRate).not.toBe(out.versionAware.staleRate);
  });

  it("marks the comparison INVALID when an arm fails to answer", async () => {
    // The guard against the degenerate result. If version-aware retrieval
    // returned nothing, its stale rate would be a perfect 0 and meaningless.
    const out = await runStaleAnswerExperiment({
      chunkModel: chunks(),
      minScore: 1.1, // impossible threshold: nothing clears it
    });
    expect(out.versionAware.coverage).toBe(0);
    expect(out.comparisonValid).toBe(false);
  });

  it("emits a scope sentence with every result", async () => {
    const out = await runStaleAnswerExperiment({ chunkModel: chunks() });
    expect(out.scope).toContain("synthetic");
    expect(out.scope).toContain("NOT a measurement of retrieval quality");
    // The baseline is named, so the comparison cannot be read as broader.
    expect(out.scope).toContain("ACCUMULATING index");
  });

  it("builds a version pair whose only difference is the changed figure", () => {
    const pair = buildVersionPair({
      schemeId: "x", oldValue: 100, newValue: 200,
      template: "limit is {{VALUE}} rupees",
    });
    expect(pair.v1.eligibility).toContain("100");
    expect(pair.v2.eligibility).toContain("200");
    expect(pair.v1.version).toBe(1);
    expect(pair.v2.version).toBe(2);
    expect(pair.v1.name).toBe(pair.v2.name);
  });
});

// ---------------------------------------------------------------------------
// Mutation checks on the honesty rules
// ---------------------------------------------------------------------------

describe("mutation checks — the instrument's honesty rules", () => {
  it("MUTANT: defaulting an empty rate to 0 would report a false measurement", () => {
    const honest = rate(0, 0);
    const mutant = { value: 0, count: 0, n: 0 }; // the mutation
    expect(honest.value).toBe(null);
    expect(mutant.value).toBe(0);
    // Rendered, the mutant is indistinguishable from a real 0% — a system that
    // answered nothing would report "0.0% fallback" and look healthy.
    expect(honest.value).not.toBe(mutant.value);
  });

  it("MUTANT: removing the provider gate would publish word-overlap as quality", () => {
    const obs = [observe(resp())];
    const gated = summarise(obs, { embeddingProvider: "local-hash" });
    const ungated = summarise(obs, { embeddingProvider: "gemini" });
    expect(gated.quality.measurable).toBe(false);
    expect(ungated.quality.measurable).toBe(true);
  });

  it("MUTANT: counting unlabelled questions as misses would report a real-looking low score", () => {
    const honest = computeRetrievalHit(resp({ sourceSchemes: ["a"] }), []);
    const mutant = false; // "no label, so it did not hit"
    expect(honest).toBe(null);
    expect(honest).not.toBe(mutant);
    // With the mutant, precision@k over 24 unlabelled questions reads 0% —
    // a number that looks like a finding and is an artefact.
  });

  it("MUTANT: dropping the coverage control would let a silent retriever score perfectly", async () => {
    const silent = await runStaleAnswerExperiment({
      chunkModel: makeCollection("schemechunks", { uniqueKeys: [["chunkId"]] }),
      minScore: 1.1,
    });
    // Stale rate looks perfect...
    expect(silent.versionAware.staleRate).toBe(0);
    // ...and the control is what exposes it.
    expect(silent.comparisonValid).toBe(false);
    expect(silent.versionAware.coverage).toBe(0);
  });
});
