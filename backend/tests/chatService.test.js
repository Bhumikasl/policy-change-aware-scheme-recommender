/**
 * Phase N — the chat service: verified data gathering and user isolation.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING DEFENDED HERE
 * ---------------------------------------------------------------------------
 * The conversational agent is a pure function of what it is handed. That makes
 * it testable, and it moves the entire authorization surface of the feature
 * into this one service: whatever decides WHICH user's profile and history get
 * loaded decides who can read whose data.
 *
 * The profile involved is not incidental. It carries income, age, category and
 * education — data that is sensitive under India's DPDP Act, and exactly the
 * IDOR the project already had to fix once on `GET /api/users/:email`. A chat
 * endpoint reintroduces the same risk in a friendlier shape: "am I eligible"
 * is a question about a specific person, and if the person can be named in the
 * request body, anyone can ask about anyone.
 *
 * So the tests below are less about the happy path than about proving a
 * negative: there is no field in the payload that can change whose data is
 * read.
 */
const {
  handleChat,
  buildContext,
  toPublicResponse,
  loadHistoryRows,
  loadRecommendationContext,
  describeRankingSignals,
  MAX_CONTEXT_TURNS,
  MAX_MESSAGE_CHARS,
} = require("../src/services/chatService");
const { INTENTS } = require("../src/agents/conversationalAgent");
const { makeCollection } = require("./helpers/inMemoryDb");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = "user-alice";
const BOB = "user-bob";

function makeModels() {
  const userModel = makeCollection("users");
  const schemeModel = makeCollection("schemes");
  const historyModel = makeCollection("recommendationhistories");
  // PHASE M/N — the fourth model, and the one that used to escape.
  //
  // Most tests here inject a recording agent, but several deliberately run the
  // REAL `answerQuestion`, which calls the REAL `retrieve`, which defaults to
  // the REAL Mongoose SchemeChunk. With no connection mongoose BUFFERS the
  // find() for 10 s rather than throwing, so those tests blew Jest's 5 s
  // timeout and the buffered call resumed after teardown. Injected here through
  // the SAME `deps` bag as the other three models.
  const ragChunkModel = makeCollection("schemechunks", { uniqueKeys: [["chunkId"]] });
  ragChunkModel.CHUNK_STATUS = Object.freeze({ ACTIVE: "ACTIVE", SUPERSEDED: "SUPERSEDED" });

  userModel.seed([
    {
      _id: ALICE,
      email: "alice@example.com",
      profile: { age: 22, annualIncome: 150000, state: "Karnataka", categories: [], documentsAvailable: [] },
    },
    {
      _id: BOB,
      email: "bob@example.com",
      profile: { age: 45, annualIncome: 900000, state: "Kerala", categories: [], documentsAvailable: [] },
    },
  ]);

  schemeModel.seed([
    {
      schemeId: "merit-scholarship",
      name: "State Merit Scholarship",
      version: 2,
      documents: ["Aadhaar Card", "Income Certificate"],
      benefits: "A tuition grant of Rs 50000 per academic year.",
      lastDate: "2026-03-31",
      eligibilityRules: {
        minAge: 18, maxAge: 25, maxAnnualIncome: 200000,
        minAnnualIncome: null, minMarksPercentage: null, minEducationLevel: null,
        genders: [], categories: [], occupations: [], states: [],
        source: "structured", eligibilityType: "constrained",
        confidence: 0.7, needsReview: false,
      },
    },
  ]);

  historyModel.seed([
    {
      _id: "hist-alice",
      userId: ALICE,
      schemeId: "merit-scholarship",
      schemeName: "State Merit Scholarship",
      previousSchemeVersion: 1,
      newSchemeVersion: 2,
      eligibilityTransition: "INELIGIBLE_TO_ELIGIBLE",
      explanation: "ALICE PRIVATE EXPLANATION",
      reason: { changedFields: [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 100000, newValue: 200000 }] },
      createdAt: new Date("2026-02-01"),
    },
    {
      _id: "hist-bob",
      userId: BOB,
      schemeId: "merit-scholarship",
      schemeName: "State Merit Scholarship",
      previousSchemeVersion: 1,
      newSchemeVersion: 2,
      eligibilityTransition: "ELIGIBLE_TO_INELIGIBLE",
      explanation: "BOB PRIVATE EXPLANATION",
      reason: { changedFields: [] },
      createdAt: new Date("2026-02-02"),
    },
  ]);

  return { userModel, schemeModel, historyModel, ragChunkModel };
}

/** Captures exactly what the agent was handed. */
function recordingAgent(store) {
  return async (args) => {
    store.push(args);
    return {
      answer: "ok",
      intent: args.data?.historyRows ? INTENTS.POLICY_CHANGE : INTENTS.ELIGIBILITY,
      intentConfidence: 0.9,
      confidence: 0.9,
      grounded: true,
      sources: [],
      schemeIds: [],
      schemeVersions: [],
      eligibilityDecision: null,
      recommendationContext: null,
      metrics: { totalMs: 1, retrievalMs: 0, llmMs: 0, retrievedChunks: 0 },
      degraded: [],
      method: "deterministic",
    };
  };
}

// ---------------------------------------------------------------------------
// N.9 — user isolation
// ---------------------------------------------------------------------------

describe("user isolation", () => {
  it("loads the caller's own profile, and only that one", async () => {
    const models = makeModels();
    const seen = [];
    await handleChat({
      userId: ALICE,
      message: "Am I eligible for this scheme?",
      schemeId: "merit-scholarship",
      deps: { ...models, agent: recordingAgent(seen) },
    });

    expect(seen[0].user._id).toBe(ALICE);
    expect(seen[0].user.email).toBe("alice@example.com");
  });

  it("IGNORES a userId in the payload — it is not a field this code reads", async () => {
    // The strong form of the property. Not "rejects a userId field" — a
    // rejection list has to guess the field name — but "there is nowhere for
    // one to go": handleChat's only source of identity is its userId argument,
    // and the route passes the verified token subject.
    const models = makeModels();
    const seen = [];
    await handleChat({
      userId: ALICE,
      message: "Am I eligible?",
      schemeId: "merit-scholarship",
      // Every shape an attacker might try, all inert.
      userIdOverride: BOB,
      user: { _id: BOB },
      email: "bob@example.com",
      as: BOB,
      deps: { ...models, agent: recordingAgent(seen) },
    });

    expect(seen[0].user._id).toBe(ALICE);
    expect(seen[0].user._id).not.toBe(BOB);
  });

  it("queries recommendation history WITH the userId in the filter, not after", async () => {
    // Filtering after the read would mean another user's rows were loaded into
    // this process and then discarded — one refactor away from being returned.
    const models = makeModels();
    const seen = [];
    await handleChat({
      userId: ALICE,
      message: "What changed in this scheme?",
      schemeId: "merit-scholarship",
      deps: { ...models, agent: recordingAgent(seen) },
    });

    expect(models.historyModel.spy.lastFilter.userId).toBe(ALICE);
    const rows = seen[0].data.historyRows;
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.userId === ALICE)).toBe(true);
  });

  it("never surfaces another user's explanation text", async () => {
    const models = makeModels();
    const seen = [];
    await handleChat({
      userId: ALICE,
      message: "What changed in this scheme?",
      schemeId: "merit-scholarship",
      deps: { ...models, agent: recordingAgent(seen) },
    });

    const serialized = JSON.stringify(seen[0].data.historyRows);
    expect(serialized).toContain("ALICE PRIVATE EXPLANATION");
    expect(serialized).not.toContain("BOB PRIVATE EXPLANATION");
  });

  it("gives the two users different eligibility verdicts for the same scheme", async () => {
    // Proves the verdict is computed from the CALLER's profile rather than
    // from anything in the request — the same message and schemeId, two
    // answers.
    const models = makeModels();
    const alice = await handleChat({
      userId: ALICE,
      message: "Am I eligible?",
      schemeId: "merit-scholarship",
      deps: { ...models, agent: undefined },
    });
    const bob = await handleChat({
      userId: BOB,
      message: "Am I eligible?",
      schemeId: "merit-scholarship",
      deps: { ...models },
    });

    expect(alice.response.eligibilityDecision.eligible).toBe(true);
    expect(bob.response.eligibilityDecision.eligible).toBe(false);
  });

  it("refuses without a userId rather than falling back to some default user", async () => {
    const models = makeModels();
    const out = await handleChat({ userId: null, message: "Am I eligible?", deps: models });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/authentication required/);
  });

  it("refuses for a token subject that no longer exists", async () => {
    const models = makeModels();
    const out = await handleChat({ userId: "deleted-user", message: "Am I eligible?", deps: models });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/user not found/);
  });

  it("loadHistoryRows always puts userId in the filter", async () => {
    const models = makeModels();
    await loadHistoryRows({ userId: BOB, schemeId: null, model: models.historyModel });
    expect(models.historyModel.spy.lastFilter.userId).toBe(BOB);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION — the recommendation-context defects found in the Phase O audit
// ---------------------------------------------------------------------------

/**
 * Three real defects lived in `loadRecommendationContext`, and all 24 tests
 * above passed with every one of them present. They passed because they tested
 * `handleRecommendation` with a hand-built context object — the HANDLER, never
 * the WIRING that produces the context. That is the same class of gap that let
 * an eligibility mutant survive earlier: testing the unit and not the seam.
 */
describe("recommendation context matches the rest of the application", () => {
  function withSchemes(extra = []) {
    const models = makeModels();
    models.schemeModel.seed(extra);
    return models;
  }

  const rankable = (over = {}) => ({
    schemeId: over.schemeId,
    name: over.name || over.schemeId,
    version: 1,
    status: over.status || "active",
    documents: over.documents || [],
    benefits: over.benefits || "",
    eligibilityRules: {
      minAge: 18, maxAge: 25, maxAnnualIncome: 200000,
      minAnnualIncome: null, minMarksPercentage: null, minEducationLevel: null,
      genders: [], categories: [], occupations: [], states: [],
      source: "structured", eligibilityType: "constrained",
      confidence: 0.7, needsReview: false,
      ...(over.eligibilityRules || {}),
    },
  });

  it("DEFECT 1: rankingReasons is no longer permanently empty", async () => {
    // `rankCandidates` returns {scheme, verdict, relevance, relevanceBreakdown}
    // — there is NO `reasons` field. The old code read `hit.reasons`, so
    // rankingReasons was `[]` for every scheme forever, and the "why is this
    // recommended?" answer had no signals to explain.
    const models = makeModels();
    const ctx = await loadRecommendationContext({
      user: { _id: ALICE, profile: { age: 22, annualIncome: 150000, categories: [], documentsAvailable: ["Aadhaar Card"] } },
      schemeId: "merit-scholarship",
      schemeModel: models.schemeModel,
    });

    expect(ctx.eligible).toBe(true);
    expect(ctx.rankingReasons.length > 0).toBe(true);
    expect(ctx.rankingReasons.some((r) => /eligibility condition/.test(r))).toBe(true);
  });

  it("DEFECT 2: an inactive scheme no longer takes a rank", async () => {
    // matcher.js does not look at status. recommendationPropagation gates on
    // it explicitly; this did not. A closed scheme could therefore be counted
    // in the eligible set, shifting every rank below it — and could itself be
    // described as recommended.
    const models = withSchemes([rankable({ schemeId: "closed-scheme", status: "closed" })]);
    const u = { _id: ALICE, profile: { age: 22, annualIncome: 150000, categories: [], documentsAvailable: [] } };

    const closed = await loadRecommendationContext({
      user: u, schemeId: "closed-scheme", schemeModel: models.schemeModel,
    });
    expect(closed.eligible).toBe(false);
    expect(closed.rank).toBe(null);

    // And it does not displace the active one.
    const open = await loadRecommendationContext({
      user: u, schemeId: "merit-scholarship", schemeModel: models.schemeModel,
    });
    expect(open.rank).toBe(1);
  });

  it("DEFECT 3: documentReadiness feeds the ranker, as it does at the other call sites", async () => {
    // The ranker's document term is `(have / required) * 1.5`. Omitting
    // documentReadiness silently zeroed it, so chat could order two schemes
    // differently from GET /recommendations and quote a rank the UI disagreed
    // with.
    const models = withSchemes([
      rankable({ schemeId: "needs-docs", name: "Needs Docs", documents: ["Aadhaar Card", "Income Certificate"] }),
    ]);
    const withDocs = {
      _id: ALICE,
      profile: { age: 22, annualIncome: 150000, categories: [], documentsAvailable: ["Aadhaar Card", "Income Certificate"] },
    };

    const ctx = await loadRecommendationContext({
      user: withDocs, schemeId: "needs-docs", schemeModel: models.schemeModel,
    });
    expect(ctx.rankingReasons.some((r) => /documents on file/.test(r))).toBe(true);
  });

  it("reports the relevance score alongside the rank, as N.4 asks", async () => {
    const models = makeModels();
    const ctx = await loadRecommendationContext({
      user: { _id: ALICE, profile: { age: 22, annualIncome: 150000, categories: [], documentsAvailable: [] } },
      schemeId: "merit-scholarship",
      schemeModel: models.schemeModel,
    });
    expect(typeof ctx.relevance).toBe("number");
  });

  it("pads nothing — a signal that contributed zero produces no sentence", () => {
    // The rule is "do not invent a ranking reason". Padding here would be the
    // same invention, just moved out of the model.
    expect(describeRankingSignals({}, null)).toEqual([]);
    expect(describeRankingSignals({ specificity: 0, deadline: 0, benefit: 0, lexical: 0 }, null)).toEqual([]);
  });

  it("reports the universal downweight as honestly as an upweight", () => {
    // Hiding it would make the ranking look more personalised than it is.
    const out = describeRankingSignals({ universalPenalty: -2 }, null);
    expect(out.some((r) => /open to everyone/.test(r))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("rejects an empty message", async () => {
    const out = await handleChat({ userId: ALICE, message: "   ", deps: makeModels() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/message is required/);
  });

  it("rejects an oversized message rather than embedding it", async () => {
    const out = await handleChat({
      userId: ALICE,
      message: "a".repeat(MAX_MESSAGE_CHARS + 1),
      deps: makeModels(),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/characters or fewer/);
  });

  it("accepts a message exactly at the limit", async () => {
    const models = makeModels();
    const out = await handleChat({
      userId: ALICE,
      message: "a".repeat(MAX_MESSAGE_CHARS),
      deps: { ...models, agent: recordingAgent([]) },
    });
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N.6 — bounded conversation context
// ---------------------------------------------------------------------------

describe("conversation context is bounded and carries no message text", () => {
  it("keeps only the last intent and scheme id", () => {
    const ctx = buildContext([
      { intent: INTENTS.DOCUMENTS, schemeId: "s-1", message: "what documents" },
      { intent: INTENTS.ELIGIBILITY, schemeId: "s-2", message: "am i eligible" },
    ]);
    expect(ctx).toEqual({ lastIntent: INTENTS.ELIGIBILITY, lastSchemeId: "s-2" });
    // The transcript is deliberately not carried: it is not needed to resolve
    // "why?", and echoing it back through the API is a second place personal
    // details could leak from.
    expect(JSON.stringify(ctx)).not.toContain("am i eligible");
  });

  it("truncates a long history to the bound", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      intent: INTENTS.DOCUMENTS,
      schemeId: `s-${i}`,
    }));
    const ctx = buildContext(many);
    // Only the last MAX_CONTEXT_TURNS are read, so the surviving scheme id
    // comes from within that window.
    expect(ctx.lastSchemeId).toBe(`s-${49}`);
    expect(buildContext(many.slice(0, 10)).lastSchemeId).toBe("s-9");
  });

  it("ignores a fabricated intent value from the client", () => {
    const ctx = buildContext([{ intent: "SUPER_ADMIN_MODE", schemeId: "s-1" }]);
    expect(ctx.lastIntent).toBe(null);
    expect(ctx.lastSchemeId).toBe("s-1");
  });

  it("tolerates junk history without throwing", () => {
    expect(buildContext(null)).toEqual({ lastIntent: null, lastSchemeId: null });
    expect(buildContext(["nonsense", 42, null])).toEqual({ lastIntent: null, lastSchemeId: null });
  });

  it("resolves a follow-up to the remembered scheme end to end", async () => {
    const models = makeModels();
    const seen = [];
    await handleChat({
      userId: ALICE,
      message: "why?",
      history: [{ intent: INTENTS.ELIGIBILITY, schemeId: "merit-scholarship" }],
      deps: { ...models, agent: recordingAgent(seen) },
    });

    expect(seen[0].explicitSchemeId).toBe("merit-scholarship");
    expect(seen[0].data.scheme.schemeId).toBe("merit-scholarship");
    expect(seen[0].context.lastIntent).toBe(INTENTS.ELIGIBILITY);
  });

  it("returns a turn the client can replay as the next history entry", async () => {
    const models = makeModels();
    const out = await handleChat({
      userId: ALICE,
      message: "Am I eligible?",
      schemeId: "merit-scholarship",
      deps: models,
    });
    expect(out.turn.schemeId).toBe("merit-scholarship");
    expect(out.turn.intent).toBe(INTENTS.ELIGIBILITY);
  });
});

// ---------------------------------------------------------------------------
// N.8 — response shape
// ---------------------------------------------------------------------------

describe("the public response withholds internal fields", () => {
  const agentOut = {
    answer: "You are eligible.",
    intent: INTENTS.ELIGIBILITY,
    intentConfidence: 0.9,
    confidence: 0.9,
    grounded: true,
    method: "deterministic-override",
    sources: [
      { schemeId: "s1", schemeVersion: 2, field: "eligibility", score: 0.7412, excerpt: "text" },
    ],
    schemeIds: ["s1"],
    schemeVersions: [2],
    eligibilityDecision: {
      schemeId: "s1", schemeName: "S", schemeVersion: 2, eligible: true,
      satisfied: [], unsatisfied: [], source: "deterministic-matcher",
    },
    recommendationContext: null,
    metrics: { retrievalMs: 12, llmMs: 340, totalMs: 355, retrievedChunks: 4 },
    degraded: ["llm: 429 quota exhausted on key ...abcd"],
  };

  it("drops latency metrics from the wire", () => {
    const pub = toPublicResponse(agentOut);
    expect(pub.metrics).toBe(undefined);
    expect(JSON.stringify(pub)).not.toContain("355");
  });

  it("reduces degraded detail to a boolean, so provider errors do not leak", () => {
    const pub = toPublicResponse(agentOut);
    expect(pub.degraded).toBe(true);
    // Error strings are where internal hostnames, key fragments and quota
    // details escape.
    expect(JSON.stringify(pub)).not.toContain("quota exhausted");
    expect(JSON.stringify(pub)).not.toContain("abcd");
  });

  it("names the CAUSE as a code, so the UI need not guess at an outage", () => {
    // The boolean alone made the UI say "some services were unavailable" for
    // every degradation — false whenever the cause is local-hash embeddings,
    // which is the default configuration.
    const pub = toPublicResponse(agentOut);
    expect(pub.degradedReasons).toEqual(["LLM_UNAVAILABLE"]);
    // Still no provider text: the code is a constant, not a summary of the
    // error it stands for.
    expect(JSON.stringify(pub.degradedReasons)).not.toMatch(/quota|abcd|429/);
  });

  it("says lexical embeddings are a quality limit, not an unavailable service", () => {
    const pub = toPublicResponse({
      ...agentOut,
      degraded: ["embeddings are lexical, not semantic"],
    });
    expect(pub.degraded).toBe(true);
    expect(pub.degradedReasons).toEqual(["EMBEDDINGS_LEXICAL"]);
  });

  it("reports an empty reason list when nothing degraded", () => {
    const pub = toPublicResponse({ ...agentOut, degraded: [] });
    expect(pub.degraded).toBe(false);
    expect(pub.degradedReasons).toEqual([]);
  });

  it("drops the routing internals", () => {
    const pub = toPublicResponse(agentOut);
    expect(pub.intentConfidence).toBe(undefined);
    expect(pub.method).toBe(undefined);
  });

  it("keeps the deterministic verdict AND labels its source", () => {
    const pub = toPublicResponse(agentOut);
    expect(pub.eligibilityDecision.eligible).toBe(true);
    // The UI has to be able to say "this came from the rules engine". A
    // separation the user cannot see does not help the user.
    expect(pub.eligibilityDecision.source).toBe("deterministic-matcher");
  });

  it("keeps citations, because a grounded answer nobody can check is not much better", () => {
    const pub = toPublicResponse(agentOut);
    expect(pub.sources.length).toBe(1);
    expect(pub.sources[0].schemeId).toBe("s1");
    expect(pub.sources[0].excerpt).toBe("text");
    // The similarity score is an internal ranking artefact.
    expect(pub.sources[0].score).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("data-gathering failure degrades to a refusal, never to a guess", () => {
  it("a history lookup failure leaves the agent with no facts", async () => {
    const models = makeModels();
    models.historyModel.state.failFind = true;
    const seen = [];
    const out = await handleChat({
      userId: ALICE,
      message: "What changed in this scheme?",
      schemeId: "merit-scholarship",
      deps: { ...models, agent: recordingAgent(seen) },
    });

    expect(out.ok).toBe(true);
    expect(seen[0].data.historyRows).toBe(undefined);
  });

  it("an unknown schemeId produces an insufficient-evidence answer, not a 500", async () => {
    const models = makeModels();
    const out = await handleChat({
      userId: ALICE,
      message: "Am I eligible?",
      schemeId: "no-such-scheme",
      deps: models,
    });
    expect(out.ok).toBe(true);
    expect(out.response.eligibilityDecision).toBe(null);
    expect(out.response.grounded).toBe(false);
  });
});
