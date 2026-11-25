const { answerQuestion, INTENTS } = require("../agents/conversationalAgent");
const { activeProvider, activeModel } = require("../services/embeddingService");
const { VECTOR_STRATEGY } = require("../services/ragRetriever");
const { QUESTIONS, FOLLOW_UPS, labelledCount } = require("./questionSet");
const { observe, summarise, formatReport } = require("./metrics");

/**
 * EVALUATION HARNESS — runs the question set through the real agent.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DRIVES
 * ---------------------------------------------------------------------------
 * `conversationalAgent.answerQuestion` directly, not the HTTP route. The route
 * adds authentication and serialisation, neither of which the metrics are
 * about, and driving it would require a running server and a live token — which
 * would make the harness impossible to run offline and pointless to test.
 *
 * Everything the agent depends on stays real: the matcher, the retriever, the
 * grounding check, the guards. Only the DATA is supplied by the caller, and
 * only the LLM and retrieval can be stubbed — because a harness that cannot run
 * without a paid provider cannot be tested, and an untested measuring
 * instrument is not evidence.
 *
 * ---------------------------------------------------------------------------
 * IT REPORTS THE ENVIRONMENT IT RAN IN
 * ---------------------------------------------------------------------------
 * Every report carries the embedding provider, the vector strategy and whether
 * the LLM was enabled. A latency number from a `local-hash` + `scan` + no-LLM
 * run and one from `gemini` + `atlas` + Groq are different measurements that
 * would otherwise look identical on a page.
 */

/**
 * Run one question.
 *
 * `data` and `user` come from the caller: the harness does not decide what a
 * verified fact is, it only records what the agent did with one.
 */
async function runQuestion(question, { user, data, deps = {}, context = {} } = {}) {
  const started = Date.now();
  let response;
  let error = null;
  try {
    response = await answerQuestion({
      message: question.message,
      user,
      context,
      explicitSchemeId: question.requiresScheme ? data?.scheme?.schemeId || null : null,
      data: data || {},
      deps,
    });
  } catch (err) {
    // A thrown agent is a finding, not a crash to hide. It is recorded as an
    // error observation rather than dropped, because silently skipping failed
    // questions would improve every rate in the report.
    error = err.message;
    response = null;
  }

  return {
    question,
    response,
    error,
    wallMs: Date.now() - started,
  };
}

/**
 * Run the whole set.
 *
 * @returns {Promise<{report, observations, results, followUps}>}
 */
async function runEvaluation({
  questions = QUESTIONS,
  followUps = FOLLOW_UPS,
  user,
  buildData = () => ({}),
  deps = {},
  // Derived from what the run ACTUALLY did, not from the ambient config.
  //
  // An earlier version read `process.env.CHAT_LLM` here, so a run driven with
  // `deps.useLlm = false` reported `chatLlmEnabled: true` — a report claiming
  // the model was in the loop for numbers produced without it. `deps` wins,
  // because `deps` is what the agent obeyed.
  chatLlmEnabled = deps.useLlm !== undefined ? !!deps.useLlm : process.env.CHAT_LLM !== "false",
} = {}) {
  const observations = [];
  const results = [];
  const errors = [];

  for (const question of questions) {
    const data = await buildData(question);
    const r = await runQuestion(question, { user, data, deps });
    results.push(r);

    if (r.error) {
      errors.push({ id: question.id, error: r.error });
      continue; // recorded above; excluded from rate denominators
    }

    observations.push(
      observe(r.response, {
        questionId: question.id,
        category: question.category,
        expectedIntent: question.expectedIntent,
        expectedSchemeIds: question.expectedSchemeIds,
        embeddingDegraded: activeProvider() === "local-hash",
      })
    );
  }

  // ---- follow-ups: does context actually resolve "why?" ------------------
  const followUpResults = [];
  for (const fu of followUps) {
    const data = await buildData(fu);
    const first = await runQuestion(
      { ...fu.first, id: `${fu.id}-a`, requiresScheme: fu.requiresScheme, category: "followUp", expectedSchemeIds: [] },
      { user, data, deps }
    );
    const second = await runQuestion(
      { ...fu.then, id: `${fu.id}-b`, requiresScheme: false, category: "followUp", expectedSchemeIds: [] },
      {
        user,
        data,
        deps,
        context: {
          lastIntent: first.response?.intent || null,
          lastSchemeId: data?.scheme?.schemeId || null,
        },
      }
    );
    followUpResults.push({
      id: fu.id,
      firstIntent: first.response?.intent ?? null,
      secondIntent: second.response?.intent ?? null,
      // The property: a bare "why?" resolves to the SAME intent as the turn
      // before it, rather than falling back to the default.
      resolved: !!first.response && second.response?.intent === first.response.intent,
    });
  }

  const report = summarise(observations, {
    embeddingProvider: activeProvider(),
    embeddingModel: activeModel(),
    vectorStrategy: VECTOR_STRATEGY(),
    llmProvider: process.env.LLM_PROVIDER || "groq",
    chatLlmEnabled,
  });

  // Attach what the aggregate cannot express.
  report.followUps = {
    n: followUpResults.length,
    resolved: followUpResults.filter((f) => f.resolved).length,
    detail: followUpResults,
  };
  report.refusals = refusalStats(results);
  report.errors = errors;
  report.labelling = {
    questions: questions.length,
    withRelevanceLabels: labelledCount(questions),
    // Spelled out, because "precision@k: not measured" invites the question.
    note:
      labelledCount(questions) === 0
        ? "No question carries relevance labels, so retrieval precision is not measured. Labelling requires human relevance judgements against the real corpus."
        : null,
  };

  return { report, observations, results, followUps: followUpResults };
}

/**
 * Did questions marked `expectRefusal` actually get refused?
 *
 * Reported separately from grounding, because they answer different questions:
 * grounded-rate says how often evidence was found; this says how often the
 * system correctly declined when it should have. A system that answers
 * everything scores well on the first and badly here.
 */
function refusalStats(results) {
  const expected = results.filter((r) => r.question.expectRefusal && r.response);
  const correct = expected.filter((r) => r.response.grounded === false);
  return {
    n: expected.length,
    correctlyRefused: correct.length,
    rate: expected.length ? Number((correct.length / expected.length).toFixed(4)) : null,
    missed: expected.filter((r) => r.response.grounded !== false).map((r) => r.question.id),
  };
}

module.exports = { runEvaluation, runQuestion, refusalStats, formatReport, INTENTS };
