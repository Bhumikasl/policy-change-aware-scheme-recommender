const { answerQuestion } = require("../agents/conversationalAgent");
const {
  classifyAgreement,
  productionGuardWouldFire,
  humanLabelIsReversal,
  classifierAgreesWithHuman,
  LABELS,
} = require("./verdictAgreement");
const { CASES, fixtureFor, retrievalOf } = require("./adversarialSet");
const { rate } = require("./metrics");

/**
 * GUARD ABLATION — the Phase P experiment runner.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR VARIANTS
 * ---------------------------------------------------------------------------
 *   A  contradiction ON,  grounding ON    the production configuration
 *   B  contradiction OFF, grounding ON
 *   C  contradiction ON,  grounding OFF
 *   D  contradiction OFF, grounding OFF   what the model alone produces
 *
 * D is the interesting one: it is the answer a user would have received with
 * no safety layer at all, and every other variant is measured as a delta
 * against it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TOGGLES CANNOT LEAK INTO PRODUCTION
 * ---------------------------------------------------------------------------
 * The only way to disable a guard is `deps.guards`, passed as a function
 * argument. There is no environment variable and no config key — grep the
 * agent for `process.env` and no guard appears. `resolveGuards` defaults
 * everything ON and only accepts the literal `false`, so a partial or
 * malformed object fails safe.
 *
 * Production never passes `deps` at all: `chatService` calls the agent with
 * exactly `{message, user, context, explicitSchemeId, language, data}`. A test
 * reads chatService's own source and asserts it, so adding a `deps`
 * passthrough later fails the suite rather than silently opening the door.
 */

const VARIANTS = Object.freeze({
  A: { id: "A", label: "full system", guards: { contradiction: true, grounding: true } },
  B: { id: "B", label: "contradiction OFF", guards: { contradiction: false, grounding: true } },
  C: { id: "C", label: "grounding OFF", guards: { contradiction: true, grounding: false } },
  D: { id: "D", label: "both OFF (model alone)", guards: { contradiction: false, grounding: false } },
});

/** Statuses a case result can carry. A failure is FAILED, never a zero. */
const CASE_STATUS = Object.freeze({
  OK: "OK",
  FAILED: "FAILED",
  NOT_MEASURED: "NOT_MEASURED",
});

/**
 * Run ONE adversarial case under ONE variant.
 *
 * @param {Object} testCase
 * @param {Object} variant
 * @param {Object} opts.llm       REQUIRED for live cases. Absent -> NOT_MEASURED.
 * @param {boolean} opts.live     true when a real provider is driving
 */
async function runCase(testCase, variant, { llm = null, live = false, provider = null, model = null } = {}) {
  const fixture = fixtureFor(testCase.fixture);
  const retrieved = testCase.retrieved || [];

  // A live case with no provider is NOT MEASURED — never silently skipped and
  // never counted as a pass.
  if (!testCase.stubAnswer && !llm) {
    return {
      caseId: testCase.id,
      variant: variant.id,
      status: CASE_STATUS.NOT_MEASURED,
      reason: "live case requires a real LLM provider; none supplied",
      category: testCase.category,
    };
  }

  // Capture the model's RAW output.
  //
  // When a guard fires, the agent replaces the prose with deterministic text —
  // so `response.answer` is the guard's output, not the model's. Classifying
  // that would measure the fallback and score every caught reversal as an
  // agreement, silently reporting a 0% false-negative rate for a guard that
  // was firing constantly. The wrapper records what the model actually said.
  let rawGeneration = null;
  const llmFn = testCase.stubAnswer
    ? async () => {
        rawGeneration = testCase.stubAnswer;
        return { answer: testCase.stubAnswer, usedOnlyProvidedFacts: true };
      }
    : async (...args) => {
        const out = await llm(...args);
        rawGeneration = out && typeof out.answer === "string" ? out.answer : null;
        return out;
      };

  let response = null;
  let error = null;
  const startedAt = Date.now();
  try {
    response = await answerQuestion({
      message: testCase.message,
      user: fixture.user,
      explicitSchemeId: fixture.scheme.schemeId,
      data: { scheme: fixture.scheme },
      deps: {
        retrieveFn: retrievalOf(retrieved),
        llm: llmFn,
        useLlm: true,
        guards: variant.guards, // the ONLY disable path
      },
    });
  } catch (err) {
    error = err.message;
  }

  if (error || !response) {
    return {
      caseId: testCase.id,
      variant: variant.id,
      status: CASE_STATUS.FAILED,
      error: error || "no response",
      category: testCase.category,
    };
  }

  const verdict = response.eligibilityDecision ? response.eligibilityDecision.eligible : null;
  // Prefer what the model actually emitted. Falls back to the delivered
  // answer only when the model was never reached (e.g. insufficient evidence),
  // and that case is visible via `method`.
  const rawAnswer = rawGeneration !== null ? rawGeneration : response.answer;
  const modelWasCalled = rawGeneration !== null;

  const classification = classifyAgreement({ answer: rawAnswer, eligible: verdict });
  const guardFired =
    response.method === "deterministic-override" || response.method === "deterministic-ungrounded";

  return {
    caseId: testCase.id,
    variant: variant.id,
    status: CASE_STATUS.OK,
    category: testCase.category,
    live,
    provider: live ? provider : "stub",
    model: live ? model : null,
    timestamp: new Date().toISOString(),

    // ---- what the system decided -------------------------------------
    deterministicVerdict: verdict === null ? null : verdict ? "ELIGIBLE" : "NOT_ELIGIBLE",
    // The prose the model produced (pre-guard).
    modelAnswer: rawAnswer,
    modelWasCalled,
    // The prose the USER would see (post-guard).
    deliveredAnswer: response.answer,

    // ---- guard outcomes -----------------------------------------------
    method: response.method,
    guardFired,
    contradictionGuardFired: response.method === "deterministic-override",
    groundingGuardFired: response.method === "deterministic-ungrounded",
    contradictionChecked: !!response.contradictionChecked,
    groundingChecked: !!response.groundingChecked,
    guardConfig: response.guardConfig,

    // ---- automatic classification (TRIAGE, not ground truth) -----------
    automaticClassification: classification.label,
    classificationSignals: classification.signals,
    isReversalByClassifier: classification.reversal,
    productionGuardPredicate: productionGuardWouldFire({ answer: rawAnswer, eligible: verdict }),

    // ---- to be filled by a human ---------------------------------------
    humanLabel: null,

    grounded: response.grounded,
    degraded: (response.degraded || []).length > 0,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run the whole matrix: every case under every variant.
 */
async function runAblation({
  cases = CASES,
  variants = Object.values(VARIANTS),
  llm = null,
  live = false,
  provider = null,
  model = null,
} = {}) {
  const results = [];
  for (const variant of variants) {
    for (const testCase of cases) {
      results.push(await runCase(testCase, variant, { llm, live, provider, model }));
    }
  }
  return results;
}

/**
 * Aggregate. Follows the Phase O honesty rules exactly.
 *
 * The headline false-negative rate is computed from HUMAN labels only.
 * Unlabelled and UNCERTAIN samples are excluded from the denominator — an
 * unreviewed sample is not evidence of safety and not evidence of failure.
 */
function summariseAblation(results) {
  const ok = results.filter((r) => r.status === CASE_STATUS.OK);
  const failed = results.filter((r) => r.status === CASE_STATUS.FAILED);
  const notMeasured = results.filter((r) => r.status === CASE_STATUS.NOT_MEASURED);

  const byVariant = {};
  for (const v of Object.values(VARIANTS)) {
    const rows = ok.filter((r) => r.variant === v.id);
    byVariant[v.id] = {
      label: v.label,
      guards: v.guards,
      n: rows.length,
      contradictionGuardFired: rows.filter((r) => r.contradictionGuardFired).length,
      groundingGuardFired: rows.filter((r) => r.groundingGuardFired).length,
      anyGuardFired: rate(rows.filter((r) => r.guardFired).length, rows.length),
      // What the reader actually receives — the ablation delta.
      reversalsDelivered: rate(
        rows.filter((r) => r.isReversalByClassifier && !r.guardFired).length,
        rows.length
      ),
    };
  }

  // ---- the primary metric, from HUMAN labels only ------------------------
  const humanLabelled = ok.filter((r) => humanLabelIsReversal(r.humanLabel) !== null);
  const humanReversals = humanLabelled.filter((r) => humanLabelIsReversal(r.humanLabel) === true);
  // A false negative: a human says this reverses the verdict, and the guard
  // did not fire. Measured on variant A — the production configuration.
  const variantA = humanReversals.filter((r) => r.variant === "A");
  const falseNegatives = variantA.filter((r) => !r.contradictionGuardFired);
  const falsePositiveBase = humanLabelled.filter(
    (r) => r.variant === "A" && humanLabelIsReversal(r.humanLabel) === false
  );
  const falsePositives = falsePositiveBase.filter((r) => r.contradictionGuardFired);

  // ---- classifier reliability, reported rather than assumed --------------
  const agreementRows = ok
    .map((r) => classifierAgreesWithHuman(r.automaticClassification, r.humanLabel))
    .filter((v) => v !== null);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      cases: results.length,
      ok: ok.length,
      failed: failed.length,
      notMeasured: notMeasured.length,
    },
    // Loud, not silent: a run with failures is not a clean run.
    runStatus:
      failed.length > 0 ? "FAILED" : notMeasured.length === results.length ? "NOT_MEASURED" : "OK",
    failures: failed.map((f) => ({ caseId: f.caseId, variant: f.variant, error: f.error })),
    notMeasuredReasons: [...new Set(notMeasured.map((r) => r.reason))],

    byVariant,

    primaryMetric: {
      name: "contradiction-guard false-negative rate (variant A, human-labelled)",
      // null, never 0, when nothing has been labelled.
      falseNegativeRate: rate(falseNegatives.length, variantA.length),
      falsePositiveRate: rate(falsePositives.length, falsePositiveBase.length),
      humanLabelledSamples: humanLabelled.length,
      unlabelledExcluded: ok.length - humanLabelled.length,
      note:
        humanLabelled.length === 0
          ? "NOT MEASURED — no human labels present. The primary metric is computed from human labels only; unlabelled and UNCERTAIN samples are excluded from the denominator."
          : null,
      workedExamples: falseNegatives.slice(0, 10).map((r) => ({
        caseId: r.caseId,
        verdict: r.deterministicVerdict,
        modelAnswer: r.modelAnswer,
        humanLabel: r.humanLabel,
        automaticClassification: r.automaticClassification,
      })),
    },

    classifierReliability: {
      name: "automatic classifier vs human label (reversal granularity)",
      agreement: rate(agreementRows.filter(Boolean).length, agreementRows.length),
      note:
        agreementRows.length === 0
          ? "NOT MEASURED — no human labels. The automatic classifier is a triage instrument and is not used for the primary metric."
          : null,
    },
  };
}

module.exports = {
  runAblation,
  runCase,
  summariseAblation,
  VARIANTS,
  CASE_STATUS,
  LABELS,
};
