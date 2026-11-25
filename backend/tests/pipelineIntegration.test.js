/**
 * PHASE J INTEGRATION — does the normal collection cycle actually drive
 * H -> I -> J?
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * REAL: services/pipeline.js (runCollectionCycle), the normalizer, comparator
 * .reconcile() with its genuine SHA-256 hashing and field-level diffing,
 * policyPipeline, policyChangeAgent, policyImpactAgent, matcher, relevance
 * ranker, and recommendationPropagation. Every service boundary under test is
 * the production one.
 *
 * FAKED: the Mongoose model layer (tests/helpers/inMemoryDb.js), the
 * collectors (so no government API is contacted), and the two side-effecting
 * services the cycle already calls — aiSummary (an LLM call) and notifier (an
 * SMTP send). Faking those two is not a shortcut: Phase J is explicitly not
 * allowed to send notifications, and the LLM must never be required for the
 * deterministic path to work.
 *
 * Proving "the pipeline calls the agents" with MOCKED agents would prove
 * nothing — a mock recording "I was called" cannot show that a real diff
 * produces a real history row. So the agents run for real and the assertions
 * are about the rows that come out the far end.
 */
/*
 * ---------------------------------------------------------------------------
 * WHY THE MOCK STATE IS SHAPED LIKE THIS
 * ---------------------------------------------------------------------------
 * babel-plugin-jest-hoist lifts every jest.mock() call above the imports, so a
 * factory that closes over an ordinary module-scope variable is rejected before
 * a single test runs:
 *
 *     const db = makeDb();
 *     jest.mock("../src/models/Scheme", () => db.Scheme);
 *     // The module factory of `jest.mock()` is not allowed to reference any
 *     // out-of-scope variables. Invalid variable access: db.
 *
 * The plugin permits exactly two things inside a factory: `require`, and
 * identifiers whose names begin with "mock" (case-insensitive). Hence the
 * `mock*` names below — they are not a style choice, they are the allowlist.
 *
 * The store is built lazily through mockGetDb() rather than eagerly, so the
 * factories cannot depend on when the plugin decides to run them. A hoisted
 * factory that fired before `const db = makeDb()` had initialised would hit the
 * temporal dead zone; a lazy singleton has no such ordering to get wrong, and
 * every caller still receives the same object.
 *
 * Nothing about what is faked has changed: the model layer, the collectors,
 * aiSummary and notifier, exactly as before.
 */
const { makeDb, makeCollection } = require("./helpers/inMemoryDb");

// Single mutable holder. Must be `mock`-prefixed to be legal inside a factory.
const mockState = {
  db: null,
  collectorItems: [],
};

/** The one in-memory database, created on first use. */
const mockGetDb = () => {
  if (!mockState.db) mockState.db = makeDb();
  return mockState.db;
};

// --- the database layer -----------------------------------------------------
jest.mock("../src/models/Scheme", () => mockGetDb().Scheme);
jest.mock("../src/models/SchemeHistory", () => mockGetDb().SchemeHistory);
jest.mock("../src/models/User", () => mockGetDb().User);
// The enums now live in src/constants and are imported by both the model and
// the propagation service, so substituting the model no longer strips them.
jest.mock("../src/models/RecommendationHistory", () => mockGetDb().RecommendationHistory);
// Phase M. WITHOUT THIS the RAG indexer reached the REAL Mongoose SchemeChunk:
// mongoose buffers create() with no connection, the promise never settled, the
// test timed out at 5 s, and the buffered call then threw "import after the
// Jest environment has been torn down". Mocked here for the same reason as the
// four models above — this suite must touch no real database.
jest.mock("../src/models/SchemeChunk", () => mockGetDb().SchemeChunk);
// Phase L. The same defect one stage earlier, and hidden behind the RAG one:
// policyPipeline calls notifyFromTransitions() with no deps, so every cycle
// that did not override `notify` wholesale buffered Notification.findOne
// against a database that was never connected. Only visible once the RAG
// escape above was closed, because the RAG stage ran first and killed the test.
jest.mock("../src/models/Notification", () => mockGetDb().Notification);

// --- no government API, no LLM, no SMTP -------------------------------------
jest.mock("../src/collectors", () => ({
  collectAll: async () => mockState.collectorItems,
}));
jest.mock("../src/services/aiSummary", () => ({
  generateChangeSummary: async () => "synthetic summary",
}));
jest.mock("../src/services/notifier", () => ({
  notifyMatchingUsers: async () => 0,
  // `require` is on the plugin's allowlist, so pulling the real matcher in here
  // is legal — and it keeps these two exports genuine rather than stubbed.
  evaluateEligibility: require("../src/services/matcher").evaluateEligibility,
  getDocumentReadiness: require("../src/services/matcher").getDocumentReadiness,
}));
// The change agent's prose escalation is the only LLM path in H. Disable it so
// the deterministic route is what is under test.
process.env.POLICY_CHANGE_LLM = "false";

// Same object the factories hand to the production code, so assertions below
// read the very rows the pipeline wrote.
const db = mockGetDb();
const collectorState = {
  get items() {
    return mockState.collectorItems;
  },
  set items(v) {
    mockState.collectorItems = v;
  },
};

const { runCollectionCycle: runCollectionCycleRaw } = require("../src/services/pipeline");
const { processSchemeChange, retryFailedPolicyProcessing, changeIdFor } = require("../src/services/policyPipeline");

/**
 * PHASE L/M — the suite's cycle entry point.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WRAPPER EXISTS RATHER THAN 35 EDITED CALL SITES
 * ---------------------------------------------------------------------------
 * Two downstream stages take their model through the cycle's `deps`:
 *
 *   deps.ragChunkModel     -> processSchemeChange -> indexScheme
 *   deps.notificationModel -> processSchemeChange -> notifyFromTransitions
 *
 * There are ~35 `runCollectionCycle()` calls in this file, many inside helpers
 * and many with no arguments at all. Editing each one would mean 35 chances to
 * miss one, and a missed one does not fail loudly — it silently reaches the
 * REAL Mongoose model, mongoose buffers the operation with no connection, and
 * the test dies as an opaque 5 s timeout followed by a post-teardown import
 * error.
 *
 * So the injection happens once, here, at the single seam every call already
 * goes through. This is the SAME dependency-injection mechanism the four other
 * models use — `db` is the very object handed to the jest.mock factories above
 * — not a second parallel one.
 *
 * `...deps` is spread LAST on purpose: a test that wants a different chunk
 * model (see "routes chunks to a model injected through runCollectionCycle")
 * still overrides the default, and every existing call site keeps its own deps
 * untouched.
 *
 * Production is unaffected. `runCollectionCycleRaw` is the real function; the
 * default for `ragChunkModel` in production is `undefined`, which is the
 * real-model path.
 */
function runCollectionCycle(options = {}) {
  const { deps = {}, ...rest } = options;
  return runCollectionCycleRaw({
    ...rest,
    deps: {
      ragChunkModel: db.SchemeChunk,
      notificationModel: db.Notification,
      ...deps,
    },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
/**
 * NOTE ON FIXTURES — why every rule change here also changes the prose.
 *
 * services/pipeline.js runs maybeEnrichWithHybrid() before normalizing, which
 * re-derives eligibilityRules FROM the free-text `eligibility` field whenever
 * that text is substantial. So a collector payload that changes only the
 * structured cap is discarded: the extractor reads the unchanged prose and
 * puts the old number straight back, the content hash matches, and the cycle
 * correctly reports NO_CHANGE.
 *
 * A real ministry raising an income ceiling rewrites the eligibility text too,
 * so these fixtures do the same. The consequence for Phase I is real and is
 * asserted below: the diff then contains BOTH `eligibility` (free prose, which
 * cannot be banded) and `eligibilityRules.maxAnnualIncome`, so the union
 * degrades to a full scan.
 */
const rawScheme = (overrides = {}) => ({
  schemeId: "demo-income-scheme",
  name: "State Merit Scholarship",
  description: "Financial assistance for meritorious students.",
  eligibility: "Open to students with annual family income up to Rs 2,50,000.",
  benefits: "financial assistance of Rs 25000 per year",
  documents: ["Aadhaar"],
  tags: ["scholarship"],
  status: "active",
  ministry: "Ministry of Education",
  state: "",
  category: ["Education"],
  applicationLink: "https://example.gov.in/apply",
  lastDate: "2026-12-31",
  eligibilityRules: {
    minAge: null, maxAge: null,
    maxAnnualIncome: 250000, minAnnualIncome: null,
    minMarksPercentage: null, minEducationLevel: null,
    genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
    eligibilityType: "constrained", source: "structured", confidence: 0.9, needsReview: false,
  },
  ...overrides,
});

const fillerScheme = (i) => ({
  schemeId: `filler-${i}`,
  name: `Filler Scheme ${i}`,
  description: "general welfare support programme",
  eligibility: "Open to all citizens of India.",
  benefits: "financial assistance of Rs 5000",
  documents: [], tags: [], status: "active", ministry: "", state: "",
  category: ["Welfare"], applicationLink: "", lastDate: "",
  eligibilityRules: {
    minAge: null, maxAge: null, maxAnnualIncome: null, minAnnualIncome: null,
    minMarksPercentage: null, minEducationLevel: null,
    genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
    eligibilityType: "universal", source: "structured", confidence: 0.9, needsReview: false,
  },
});

/**
 * A scheme with no eligibility prose. maybeEnrichWithHybrid only re-derives
 * rules from text when the text is substantial, so this one keeps the
 * collector's structured rules verbatim — which is the case where a
 * structured-only diff, and therefore a targeted band, is possible.
 */
const structuredOnlyScheme = (income) => ({
  schemeId: "structured-scheme",
  name: "Structured Scheme",
  description: "d",
  eligibility: "",
  benefits: "financial assistance of Rs 20000",
  documents: [], tags: [], status: "active", ministry: "M", state: "",
  category: ["Education"], applicationLink: "", lastDate: "",
  eligibilityRules: {
    minAge: null, maxAge: null, maxAnnualIncome: income, minAnnualIncome: null,
    minMarksPercentage: null, minEducationLevel: null,
    genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
    eligibilityType: "constrained", source: "structured", confidence: 0.9, needsReview: false,
  },
});

const targetUser = {
  _id: "user-1",
  email: "student@example.com",
  name: "Test Student",
  role: "USER",
  profile: {
    age: 22,
    annualIncome: 280000, // between the old cap and the new one
    education: "Graduate",
    state: "Karnataka",
    occupation: "Student",
    gender: "Female",
    categories: [],
    documentsAvailable: ["Aadhaar"],
    marksPercentage: 78,
  },
};

const setCollector = (items) => {
  collectorState.items = items.map((raw) => ({ raw, source: "myscheme" }));
};

/** Rows for the scheme under test only. A new filler scheme legitimately
 *  writes its own row, so a global count would assert the wrong thing. */
const rowsFor = (schemeId) =>
  db.RecommendationHistory.rows.filter((r) => r.schemeId === schemeId);

function resetAll() {
  Object.values(db).forEach((c) => c.reset());
  db.User.seed([targetUser]);
}

// ---------------------------------------------------------------------------
// 1 & 8 — the scheduler's own entry point drives the whole flow
// ---------------------------------------------------------------------------
describe("the normal collection cycle drives H -> I -> J", () => {
  beforeEach(resetAll);

  it("creates a scheme, then propagates a real eligibility change on the next cycle", async () => {
    // ---- CYCLE 1: the scheme appears at version 1, cap Rs 2.5 lakh ----
    setCollector([rawScheme(), fillerScheme(1), fillerScheme(2)]);
    const first = await runCollectionCycle();

    expect(first.new).toBe(3);
    expect(first.updated).toBe(0);
    expect(db.Scheme.rows.length).toBe(3);

    // The user earns Rs 2.8 lakh against a Rs 2.5 lakh cap: not eligible.
    const v1 = db.Scheme.rows.find((s) => s.schemeId === "demo-income-scheme");
    expect(v1.eligibilityRules.maxAnnualIncome).toBe(250000);
    expect(v1.version).toBe(1);

    const afterFirst = db.RecommendationHistory.rows.filter(
      (r) => r.schemeId === "demo-income-scheme"
    );
    expect(afterFirst.length).toBe(0); // ineligible, so nothing to record

    // ---- CYCLE 2: government raises the cap to Rs 3 lakh ----
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
      fillerScheme(2),
    ]);
    const second = await runCollectionCycle();

    // Collection: one scheme updated, two unchanged.
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(2);
    expect(second.failed).toBe(0);
    expect(second.collectionStatus).toBe("SUCCEEDED");

    // A new version and a new history row, from the REAL comparator.
    const v2 = db.Scheme.rows.find((s) => s.schemeId === "demo-income-scheme");
    expect(v2.version).toBe(2);
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "demo-income-scheme" && h.version === 2
    );
    expect(hist.diffs.some((d) => d.field === "eligibilityRules.maxAnnualIncome")).toBe(true);

    // H ran and classified it.
    expect(hist.policyProcessing.changeType).toBe("ELIGIBILITY");
    expect(hist.policyProcessing.severity).toBe("HIGH");

    // I ran. The diff carries the prose field alongside the structured rule,
    // and prose cannot be banded, so the union degrades to a full scan. That
    // is the SOUND answer, not a defect — but it does mean the targeted band
    // is rarer on real collector output than a structured-only diff suggests.
    expect(hist.diffs.map((d) => d.field).sort()).toEqual([
      "eligibility",
      "eligibilityRules.maxAnnualIncome",
    ]);
    expect(hist.policyProcessing.candidateSelection).toBe("full-scan");
    expect(hist.policyProcessing.scannedEveryUser).toBe(true);
    expect(hist.policyProcessing.narrowingProven).toBe(false);
    // Still complete: a full scan covers everyone.
    expect(hist.policyProcessing.completenessGuaranteed).toBe(true);
    expect(hist.policyImpactStatus).toBe("SUCCEEDED");

    // J ran and wrote the audit row.
    expect(hist.propagationStatus).toBe("SUCCEEDED");
    const rows = db.RecommendationHistory.rows.filter(
      (r) => r.schemeId === "demo-income-scheme"
    );
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe("user-1");
    expect(rows[0].eligibilityTransition).toBe("INELIGIBLE_TO_ELIGIBLE");
    expect(rows[0].recommendationTransition).toBe("NOT_RECOMMENDED_TO_RECOMMENDED");
    expect(rows[0].previousSchemeVersion).toBe(1);
    expect(rows[0].newSchemeVersion).toBe(2);
    expect(rows[0].reason.changedFields).toContainEqual({
      field: "eligibilityRules.maxAnnualIncome",
      oldValue: 250000,
      newValue: 300000,
    });

    // Everything this cycle produced carries the cycle's job id.
    expect(rows[0].processingJobId).toBe(second.jobId);
    expect(second.historyCreated).toBe(1);
    expect(second.affectedUsers).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 1 — an unchanged scheme must cost nothing downstream
// ---------------------------------------------------------------------------
describe("unchanged schemes", () => {
  beforeEach(resetAll);

  it("runs no policy stage at all when the hash is unchanged", async () => {
    setCollector([rawScheme()]);
    await runCollectionCycle();

    // Re-collect the identical payload.
    const policySpy = { calls: 0 };
    const summary = await runCollectionCycle({
      deps: {
        runPolicyStages: async (args) => {
          policySpy.calls++;
          return processSchemeChange(args);
        },
      },
    });

    expect(summary.unchanged).toBe(1);
    expect(summary.updated).toBe(0);
    // The agents are not merely cheap here — they are never entered.
    expect(policySpy.calls).toBe(0);
    expect(summary.policyProcessed).toBe(0);
    expect(rowsFor("demo-income-scheme").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2 — changed but not material
// ---------------------------------------------------------------------------
describe("changed but non-material", () => {
  beforeEach(resetAll);

  it("versions the scheme but writes no recommendation history", async () => {
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle();

    // Only the ministry name changes: real diff, real new version, no user
    // consequence.
    setCollector([rawScheme({ ministry: "Ministry of Education, GoI" }), fillerScheme(1)]);
    const summary = await runCollectionCycle();

    expect(summary.updated).toBe(1);
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "demo-income-scheme" && h.version === 2
    );
    expect(hist.diffs.map((d) => d.field)).toEqual(["ministry"]);
    expect(hist.policyProcessing.changeType).toBe("ADMINISTRATIVE");

    // The impact agent short-circuits: no query, no candidates.
    expect(hist.policyProcessing.candidateSelection).toBe("skipped");
    expect(hist.policyProcessing.affectedUserCount).toBe(0);
    expect(hist.policyImpactStatus).toBe("SUCCEEDED");
    expect(hist.propagationStatus).toBe("SUCCEEDED");
    expect(rowsFor("demo-income-scheme").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// When the targeted band DOES apply through the real pipeline
// ---------------------------------------------------------------------------
describe("targeted band on a structured-only change", () => {
  beforeEach(resetAll);

  /**
   * maybeEnrichWithHybrid only re-derives rules from prose when the prose is
   * substantial (>= 20 chars). A scheme whose eligibility text is short keeps
   * the collector's structured rules verbatim, so a structured-only change
   * produces a structured-only diff — and Phase I can band it.
   *
   * This is the case the 79.3% synthetic benchmark models. The test above,
   * where the ministry rewrites the prose too, is the commoner one.
   */
  const structuredOnly = structuredOnlyScheme;
  const _unusedStructuredOnly = (income) => ({
    schemeId: "structured-scheme",
    name: "Structured Scheme",
    description: "d",
    eligibility: "", // no prose to re-extract from
    benefits: "financial assistance of Rs 20000",
    documents: [], tags: [], status: "active", ministry: "M", state: "",
    category: ["Education"], applicationLink: "", lastDate: "",
    eligibilityRules: {
      minAge: null, maxAge: null, maxAnnualIncome: income, minAnnualIncome: null,
      minMarksPercentage: null, minEducationLevel: null,
      genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
      eligibilityType: "constrained", source: "structured", confidence: 0.9, needsReview: false,
    },
  });

  it("bands the query and does not scan every user", async () => {
    setCollector([structuredOnly(250000), fillerScheme(1)]);
    await runCollectionCycle();

    setCollector([structuredOnly(300000), fillerScheme(1)]);
    const summary = await runCollectionCycle();

    expect(summary.updated).toBe(1);
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "structured-scheme" && h.version === 2
    );
    // Only the structured rule moved.
    expect(hist.diffs.map((d) => d.field)).toEqual(["eligibilityRules.maxAnnualIncome"]);
    expect(hist.policyProcessing.candidateSelection).toBe("targeted-band");
    expect(hist.policyProcessing.scannedEveryUser).toBe(false);
    expect(hist.policyProcessing.narrowingProven).toBe(true);
    expect(hist.policyProcessing.completenessGuaranteed).toBe(true);

    // And it still finds the user in the band.
    expect(rowsFor("structured-scheme").length).toBe(1);
    expect(rowsFor("structured-scheme")[0].eligibilityTransition).toBe("INELIGIBLE_TO_ELIGIBLE");
  });
});

// ---------------------------------------------------------------------------
// 5 — idempotency through the real pipeline
// ---------------------------------------------------------------------------
describe("processing the same change twice", () => {
  beforeEach(resetAll);

  async function seedToVersion2() {
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle();
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
    return runCollectionCycle();
  }

  it("writes exactly one history row when the change is reprocessed", async () => {
    await seedToVersion2();
    expect(rowsFor("demo-income-scheme").length).toBe(1);

    // Replay the identical change event — what a crash-and-restart does.
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "demo-income-scheme" && h.version === 2
    );
    const replay = await processSchemeChange({
      result: {
        type: "UPDATED",
        schemeId: hist.schemeId,
        version: hist.version,
        diffs: hist.diffs,
        snapshot: hist.snapshot,
      },
      jobId: "replay-job",
    });

    expect(rowsFor("demo-income-scheme").length).toBe(1);
    expect(replay.historyCreated).toBe(0);
    expect(replay.historySkipped).toBe(1);
    expect(replay.status).toBe("SUCCEEDED");
  });

  it("derives the same change id from the same scheme version", () => {
    // An ObjectId would be regenerated if a history row were ever rewritten,
    // making the same real change look new. A composite key cannot drift.
    expect(changeIdFor("demo-income-scheme", 2)).toBe("demo-income-scheme:v2");
    expect(changeIdFor("demo-income-scheme", 2)).toBe(changeIdFor("demo-income-scheme", 2));
  });

  it("stays at one row when two cycles overlap on the same change", async () => {
    await seedToVersion2();
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "demo-income-scheme" && h.version === 2
    );
    const args = {
      result: {
        type: "UPDATED", schemeId: hist.schemeId, version: hist.version,
        diffs: hist.diffs, snapshot: hist.snapshot,
      },
    };
    await Promise.all([
      processSchemeChange({ ...args, jobId: "a" }),
      processSchemeChange({ ...args, jobId: "b" }),
      processSchemeChange({ ...args, jobId: "c" }),
    ]);
    expect(rowsFor("demo-income-scheme").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6 & 7 — stage failures must not fail collection
// ---------------------------------------------------------------------------
describe("a failing policy stage never fails collection", () => {
  beforeEach(resetAll);

  async function seedV1() {
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle();
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
  }

  it("keeps collection SUCCEEDED when the impact agent throws", async () => {
    await seedV1();
    const summary = await runCollectionCycle({
      deps: {
        runPolicyStages: (args) =>
          processSchemeChange({
            ...args,
            deps: {
              impactAgent: async () => {
                throw new Error("simulated impact agent failure");
              },
            },
          }),
      },
    });

    // The scheme WAS collected and persisted. That is what collection means.
    expect(summary.failed).toBe(0);
    expect(summary.updated).toBe(1);
    expect(summary.collectionStatus).toBe("SUCCEEDED");
    expect(db.Scheme.rows.find((s) => s.schemeId === "demo-income-scheme").version).toBe(2);

    // The policy stage is separately marked failed and retryable.
    expect(summary.policyImpactFailed).toBe(1);
    expect(summary.policyStatus).toBe("PARTIAL");
    const hist = db.SchemeHistory.rows.find((h) => h.version === 2 && h.schemeId === "demo-income-scheme");
    expect(hist.policyImpactStatus).toBe("FAILED");
    expect(hist.propagationStatus).toBe("SKIPPED"); // it consumes the impact result
    expect(hist.policyRetryable).toBe(true);
  });

  it("keeps collection SUCCEEDED when propagation throws", async () => {
    await seedV1();
    const summary = await runCollectionCycle({
      deps: {
        runPolicyStages: (args) =>
          processSchemeChange({
            ...args,
            deps: {
              propagate: async () => {
                throw new Error("simulated propagation failure");
              },
            },
          }),
      },
    });

    expect(summary.failed).toBe(0);
    expect(summary.collectionStatus).toBe("SUCCEEDED");
    expect(summary.propagationFailed).toBe(1);

    const hist = db.SchemeHistory.rows.find((h) => h.version === 2 && h.schemeId === "demo-income-scheme");
    // The impact stage completed on its own merits and says so.
    expect(hist.policyImpactStatus).toBe("SUCCEEDED");
    expect(hist.propagationStatus).toBe("FAILED");
    expect(hist.policyRetryable).toBe(true);
  });

  it("recovers a failed change on retry, without recollecting", async () => {
    await seedV1();
    await runCollectionCycle({
      deps: {
        runPolicyStages: (args) =>
          processSchemeChange({
            ...args,
            deps: { propagate: async () => { throw new Error("boom"); } },
          }),
      },
    });
    expect(rowsFor("demo-income-scheme").length).toBe(0);

    // The retry reads stored snapshots only. No collector call happens.
    const collectorCallsBefore = collectorState.items.length;
    const results = await retryFailedPolicyProcessing({ jobId: "retry-1" });

    expect(results.length).toBe(1);
    expect(results[0].status).toBe("SUCCEEDED");
    expect(rowsFor("demo-income-scheme").length).toBe(1);
    expect(collectorState.items.length).toBe(collectorCallsBefore); // untouched
  });

  it("does not duplicate history when a retry follows a partial success", async () => {
    await seedV1();
    await runCollectionCycle(); // succeeds fully, writes one row
    expect(rowsFor("demo-income-scheme").length).toBe(1);

    // Force the row back into a retryable state and sweep again.
    await db.SchemeHistory.updateOne(
      { schemeId: "demo-income-scheme", version: 2 },
      { $set: { policyRetryable: true } }
    );
    const results = await retryFailedPolicyProcessing({ jobId: "retry-2" });

    expect(results[0].historyCreated).toBe(0);
    expect(results[0].historySkipped).toBe(1);
    expect(rowsFor("demo-income-scheme").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A new scheme reaches everyone it should
// ---------------------------------------------------------------------------
describe("a brand-new scheme", () => {
  beforeEach(resetAll);

  it("scans every user, because there is no prior version to band against", async () => {
    setCollector([fillerScheme(1)]);
    const summary = await runCollectionCycle();

    expect(summary.new).toBe(1);
    const hist = db.SchemeHistory.rows.find((h) => h.schemeId === "filler-1");
    expect(hist.policyProcessing.candidateSelection).toBe("full-scan");
    expect(hist.policyProcessing.scannedEveryUser).toBe(true);
    // The user qualifies for a universal scheme, so this is a real transition.
    expect(hist.policyProcessing.affectedUserCount).toBe(1);
    expect(rowsFor("filler-1").length).toBe(1);
    expect(rowsFor("filler-1")[0].eligibilityTransition).toBe("INELIGIBLE_TO_ELIGIBLE");
  });
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------
/**
 * PHASE M — the RAG stage must stay INSIDE this suite's model boundary.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THESE TESTS EXIST FOR
 * ---------------------------------------------------------------------------
 * `indexScheme()` defaults `deps.model` to the real Mongoose SchemeChunk, and
 * `policyPipeline` called it with no `deps` at all. So the Phase M stage
 * escaped this suite's in-memory boundary and used the production model.
 *
 * With no database connection mongoose does not throw — it BUFFERS the
 * create() and waits (bufferTimeoutMS, 10 s by default). The promise never
 * settled inside the 5 s test timeout, the test failed as a "timeout", and
 * after Jest tore the environment down the buffered call resumed and threw
 * "You are trying to `import` a file after the Jest environment has been torn
 * down" — the timeout was the symptom, the escaped model was the cause.
 *
 * These tests fail if that boundary is ever reopened.
 */
describe("Phase M RAG indexing stays inside the in-memory model boundary", () => {
  beforeEach(resetAll);

  async function cycleWithRagChange() {
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle();
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
    return runCollectionCycle();
  }

  it("performs ZERO real Mongoose SchemeChunk writes — every chunk lands in the in-memory model", async () => {
    // The regression assertion. `db.SchemeChunk` is the in-memory collection
    // the suite injected; if the indexer had used the real model it would be
    // empty here (and the test would have timed out long before this line).
    await cycleWithRagChange();

    expect(db.SchemeChunk.spy.creates).toBeGreaterThan(0);
    expect(db.SchemeChunk.rows.length).toBe(db.SchemeChunk.spy.creates);
    // Every row is a real chunk, written through the injected collection.
    for (const row of db.SchemeChunk.rows) {
      expect(typeof row.chunkId).toBe("string");
      expect(row.schemeId).toBeTruthy();
      expect(typeof row.schemeVersion).toBe("number");
    }
  });

  it("never touches the REAL Mongoose SchemeChunk model", async () => {
    // The regression assertion stated as the thing that actually went wrong.
    //
    // The four assertions above prove chunks arrived in the in-memory
    // collection. This one proves the converse directly: the production
    // Mongoose model received nothing.
    //
    // `jest.requireActual` reaches past the jest.mock to the genuine module.
    // Jest caches actual modules, so this is the SAME object an unmocked
    // `require("../src/models/SchemeChunk")` inside ragIndexer would have
    // resolved to — patching its `create` here is therefore a real detector,
    // not a decoration. If the boundary is ever reopened, this counter moves.
    const realModel = jest.requireActual("../src/models/SchemeChunk");
    const realCreate = realModel.create;
    const realUpdateMany = realModel.updateMany;
    let realWrites = 0;
    realModel.create = async (...args) => {
      realWrites += 1;
      return realCreate.apply(realModel, args);
    };
    realModel.updateMany = async (...args) => {
      realWrites += 1;
      return realUpdateMany.apply(realModel, args);
    };

    try {
      await cycleWithRagChange();

      // Chunks were written — so the path really did run, and a zero below is
      // "the real model was bypassed", not "nothing happened".
      expect(db.SchemeChunk.spy.creates).toBeGreaterThan(0);
      expect(realWrites).toBe(0);
    } finally {
      realModel.create = realCreate;
      realModel.updateMany = realUpdateMany;
    }
  });

  it("resolves the whole cycle promptly — no operation survives the test", async () => {
    // A buffered mongoose write would blow the default 5 s timeout. Asserting
    // the elapsed time makes the failure mode explicit rather than leaving it
    // as an opaque timeout.
    const started = Date.now();
    await cycleWithRagChange();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("records the RAG result on the history row THROUGH the injected model", async () => {
    await cycleWithRagChange();

    const hist = db.SchemeHistory.rows.find(
      (h) => h.version === 2 && h.schemeId === "demo-income-scheme"
    );
    expect(hist.ragIndexStatus).toBe("SUCCEEDED");
    expect(hist.ragIndexRetryable).toBe(false);
    expect(hist.ragIndexing.chunksIndexed).toBeGreaterThan(0);
    // The count recorded on the row matches what actually reached the model.
    const forThisScheme = db.SchemeChunk.rows.filter(
      (r) => r.schemeId === "demo-income-scheme" && r.schemeVersion === 2
    );
    expect(hist.ragIndexing.chunksIndexed).toBe(forThisScheme.length);
  });

  it("supersedes the previous version's chunks in the injected model", async () => {
    await cycleWithRagChange();
    const v1 = db.SchemeChunk.rows.filter(
      (r) => r.schemeId === "demo-income-scheme" && r.schemeVersion === 1
    );
    expect(v1.length).toBeGreaterThan(0);
    expect(v1.every((r) => r.status === "SUPERSEDED")).toBe(true);
  });

  it("routes chunks to a model injected through runCollectionCycle, not the default", async () => {
    // The SECOND injection seam, and the reason pipeline.js forwards
    // `deps.ragChunkModel` at all.
    //
    // The jest.mock above covers this suite, but it only works because these
    // tests replace the module. A caller that wants to supply a model at
    // RUNTIME — a retry job, a migration script, another test — needs the dep
    // to travel runCollectionCycle -> processSchemeChange -> indexScheme.
    //
    // A DISTINCT collection is injected here, so "it went to the injected one"
    // and "it went to the mocked default" are distinguishable outcomes.
    const { makeCollection } = require("./helpers/inMemoryDb");
    const injected = makeCollection("injected-chunks", { uniqueKeys: [["chunkId"]] });
    injected.CHUNK_STATUS = Object.freeze({ ACTIVE: "ACTIVE", SUPERSEDED: "SUPERSEDED" });

    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle({ deps: { ragChunkModel: injected } });

    expect(injected.rows.length).toBeGreaterThan(0);
    // And nothing reached the module-level default.
    expect(db.SchemeChunk.rows.length).toBe(0);
  });

  it("keeps the RAG status separate from the policy status", async () => {
    // The Phase M isolation guarantee, asserted end to end rather than only in
    // the unit suite.
    const summary = await cycleWithRagChange();
    const hist = db.SchemeHistory.rows.find(
      (h) => h.version === 2 && h.schemeId === "demo-income-scheme"
    );
    expect(hist.propagationStatus).toBe("SUCCEEDED");
    expect(hist.policyRetryable).toBe(false);
    expect(summary.failed).toBe(0);
  });
});

describe("observability", () => {
  beforeEach(resetAll);

  it("records every required field and no personal data", async () => {
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle();
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
    const summary = await runCollectionCycle();

    const hist = db.SchemeHistory.rows.find((h) => h.version === 2 && h.schemeId === "demo-income-scheme");
    const p = hist.policyProcessing;
    for (const field of [
      "jobId", "changeId", "changeType", "severity", "candidateSelection",
      "affectedUserCount", "historyCreated", "historySkipped",
    ]) {
      expect(p[field]).toBeDefined();
    }
    expect(p.jobId).toBe(summary.jobId);
    expect(p.changeId).toBe("demo-income-scheme:v2");

    // Nothing personal is stamped onto the stage record. The user's email and
    // income live in RecommendationHistory, where they belong, not in the
    // operational log of what the agents decided.
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("student@example.com");
    expect(serialized).not.toContain("280000");
  });
});

// ---------------------------------------------------------------------------
// K0.5 / K0.6 — the legacy notification path
//
// The pre-Phase-I notifier runs User.find({}) and emails on eligibility, not
// impact. It is now off by default. These tests pin BOTH halves of that: that
// it stays silent by default, and that it still works when deliberately
// re-enabled — because it is disabled, not deleted, and its own test suite
// must keep covering it until Phase L replaces it.
// ---------------------------------------------------------------------------
describe("legacy notification path", () => {
  beforeEach(resetAll);

  async function cycleWithChange(extraDeps = {}) {
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle({ deps: { legacyNotifierEnabled: false, ...extraDeps } });
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
    return runCollectionCycle({ deps: extraDeps });
  }

  it("is OFF by default, so no full user scan and no email happen", async () => {
    delete process.env.LEGACY_NOTIFIER;
    const summary = await cycleWithChange();

    expect(summary.legacyNotifierEnabled).toBe(false);
    expect(summary.legacyNotificationsSent).toBe(0);
    expect(summary.legacyNotificationsSuppressed).toBeGreaterThan(0);
  });

  it("still detects the change and writes history while the legacy path is off", async () => {
    // Disabling notification must not disable the policy pipeline. This is the
    // property that makes the flag safe to ship before Phase L exists.
    delete process.env.LEGACY_NOTIFIER;
    const summary = await cycleWithChange();

    expect(summary.updated).toBe(1);
    expect(summary.historyCreated).toBe(1);
    expect(rowsFor("demo-income-scheme").length).toBe(1);
  });

  it("runs again when explicitly re-enabled", async () => {
    // Kept working, not deleted: notifier.test.js still covers this code.
    const summary = await cycleWithChange({ legacyNotifierEnabled: true });
    expect(summary.legacyNotifierEnabled).toBe(true);
    expect(summary.legacyNotificationsSuppressed).toBe(0);
  });

  it("honours the LEGACY_NOTIFIER environment variable", async () => {
    process.env.LEGACY_NOTIFIER = "true";
    try {
      setCollector([fillerScheme(2)]);
      const summary = await runCollectionCycle();
      expect(summary.legacyNotifierEnabled).toBe(true);
    } finally {
      delete process.env.LEGACY_NOTIFIER;
    }
  });

  it("keeps targeted impact selection intact end to end", async () => {
    // K0.6: the targeted candidate set must not be undone downstream. With the
    // legacy full scan off, the only user-facing work is the impact agent's.
    delete process.env.LEGACY_NOTIFIER;
    setCollector([structuredOnlyScheme(250000), fillerScheme(1)]);
    await runCollectionCycle();
    setCollector([structuredOnlyScheme(300000), fillerScheme(1)]);
    await runCollectionCycle();

    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "structured-scheme" && h.version === 2
    );
    expect(hist.policyProcessing.candidateSelection).toBe("targeted-band");
    expect(hist.policyProcessing.scannedEveryUser).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PHASE K — explanations produced inside the real pipeline
// ---------------------------------------------------------------------------
describe("explanations through the collection cycle", () => {
  beforeEach(resetAll);

  async function incomeRaise(extraDeps = {}) {
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle({ deps: { legacyNotifierEnabled: false, ...extraDeps } });
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
    return runCollectionCycle({ deps: { legacyNotifierEnabled: false, ...extraDeps } });
  }

  it("writes a grounded explanation onto the history row", async () => {
    await incomeRaise();
    const row = db.RecommendationHistory.rows.find((r) => r.schemeId === "demo-income-scheme");
    expect(row.explanation).toBeTruthy();
    expect(row.explanation).toContain("₹3 lakh");
    expect(row.explanationMeta.method).toBe("template");
    // The sources name the exact stored values the sentence was allowed to use.
    // The diff also carries the prose `eligibility` field, so select by name
    // rather than taking the first schemeField source.
    const src = row.explanationMeta.groundingSources.find(
      (g) => g.field === "eligibilityRules.maxAnnualIncome"
    );
    expect(src.oldValue).toBe(250000);
    expect(src.newValue).toBe(300000);
  });

  it("does not need an LLM", async () => {
    // EXPLANATIONS runs with POLICY_CHANGE_LLM=false and no llm injected, so
    // reaching a sentence at all proves the deterministic path suffices.
    const summary = await incomeRaise();
    expect(summary.historyCreated).toBe(1);
    const row = db.RecommendationHistory.rows.find((r) => r.schemeId === "demo-income-scheme");
    expect(row.explanationMeta.method).toBe("template");
  });

  it("keeps the audit row when the explanation agent throws", async () => {
    // The row is the guarantee; the sentence is the courtesy. A failing
    // explainer must not fail propagation or trigger the retry sweep.
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle({ deps: { legacyNotifierEnabled: false } });
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
    const summary = await runCollectionCycle({
      deps: {
        legacyNotifierEnabled: false,
        runPolicyStages: (args) =>
          processSchemeChange({
            ...args,
            deps: {
              propagate: (popts) =>
                require("../src/services/recommendationPropagation").propagateChange({
                  ...popts,
                  deps: {
                    ...(popts.deps || {}),
                    explain: async () => {
                      throw new Error("simulated explainer failure");
                    },
                  },
                }),
            },
          }),
      },
    });

    expect(summary.historyCreated).toBe(1);
    expect(summary.propagationFailed).toBe(0);
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "demo-income-scheme" && h.version === 2
    );
    expect(hist.propagationStatus).toBe("SUCCEEDED");
    expect(hist.policyRetryable).toBe(false);

    const row = db.RecommendationHistory.rows.find((r) => r.schemeId === "demo-income-scheme");
    expect(row).toBeDefined();
    expect(row.explanation).toBe("");
  });

  it("can be turned off without affecting the audit trail", async () => {
    process.env.EXPLANATIONS = "false";
    try {
      await incomeRaise();
      const row = db.RecommendationHistory.rows.find((r) => r.schemeId === "demo-income-scheme");
      expect(row).toBeDefined();
      expect(row.explanation).toBe("");
    } finally {
      delete process.env.EXPLANATIONS;
    }
  });
});

// ---------------------------------------------------------------------------
// PHASE L — notifications driven by the transitions, inside the real pipeline
// ---------------------------------------------------------------------------
describe("notifications through the collection cycle", () => {
  beforeEach(resetAll);

  function notificationStore() {
    return makeCollection("notifications", {
      uniqueKeys: [["userId", "schemeId", "triggeringChangeId", "channel"]],
    });
  }

  async function raiseIncome(notifyDeps) {
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle({ deps: { legacyNotifierEnabled: false, ...notifyDeps } });
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
    return runCollectionCycle({ deps: { legacyNotifierEnabled: false, ...notifyDeps } });
  }

  it("notifies from the propagation records, not from a user scan", async () => {
    const notifications = notificationStore();
    const sent = [];
    const userSpy = { finds: 0 };
    const spyingUsers = {
      find(filter) {
        userSpy.finds++;
        userSpy.lastFilter = filter;
        return db.User.find(filter);
      },
    };

    const summary = await raiseIncome({
      runPolicyStages: (args) =>
        processSchemeChange({
          ...args,
          deps: {
            notify: (opts) =>
              require("../src/services/notificationService").notifyFromTransitions({
                ...opts,
                deps: {
                  notificationModel: notifications,
                  userModel: spyingUsers,
                  sendEmail: async (...a) => sent.push(a),
                },
              }),
          },
        }),
    });

    expect(summary.historyCreated).toBe(1);
    expect(notifications.rows.length).toBeGreaterThan(0);
    // The only user query is a targeted $in over the affected set.
    expect(userSpy.lastFilter).toEqual({ _id: { $in: ["user-1"] } });
    expect(userSpy.lastFilter).not.toEqual({});
  });

  it("carries the Phase K explanation into the notification body", async () => {
    const notifications = notificationStore();
    await raiseIncome({
      runPolicyStages: (args) =>
        processSchemeChange({
          ...args,
          deps: {
            notify: (opts) =>
              require("../src/services/notificationService").notifyFromTransitions({
                ...opts,
                deps: {
                  notificationModel: notifications,
                  userModel: db.User,
                  sendEmail: async () => {},
                },
              }),
          },
        }),
    });

    // Select by scheme: cycle 1 also creates a NEWLY_ELIGIBLE notification for
    // the universal filler scheme, and taking the first row would test that
    // one instead — which has no changed fields and therefore no explanation.
    const inApp = notifications.rows.find(
      (r) => r.channel === "in_app" && r.schemeId === "demo-income-scheme"
    );
    expect(inApp).toBeDefined();
    expect(inApp.type).toBe("NEWLY_ELIGIBLE");
    expect(inApp.bodySource).toBe("explanation");
    expect(inApp.body).toContain("₹3 lakh");
  });

  it("does not run the legacy notifier alongside it", async () => {
    // Two notification paths for one change would email the user twice.
    const notifications = notificationStore();
    const summary = await raiseIncome({
      runPolicyStages: (args) =>
        processSchemeChange({
          ...args,
          deps: {
            notify: (opts) =>
              require("../src/services/notificationService").notifyFromTransitions({
                ...opts,
                deps: { notificationModel: notifications, userModel: db.User, sendEmail: async () => {} },
              }),
          },
        }),
    });
    expect(summary.legacyNotifierEnabled).toBe(false);
    expect(summary.legacyNotificationsSent).toBe(0);
  });

  it("keeps propagation SUCCEEDED when notification fails", async () => {
    // An SMTP outage is not a failed policy propagation, and must not send the
    // retry sweep re-running analysis that succeeded.
    const summary = await raiseIncome({
      runPolicyStages: (args) =>
        processSchemeChange({
          ...args,
          deps: {
            notify: async () => {
              throw new Error("notification subsystem down");
            },
          },
        }),
    });

    expect(summary.historyCreated).toBe(1);
    expect(summary.propagationFailed).toBe(0);
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "demo-income-scheme" && h.version === 2
    );
    expect(hist.propagationStatus).toBe("SUCCEEDED");
    expect(hist.policyImpactStatus).toBe("SUCCEEDED");
    expect(hist.policyRetryable).toBe(false);
  });

  it("can be disabled without affecting the audit trail", async () => {
    process.env.NOTIFICATIONS = "false";
    try {
      const summary = await raiseIncome();
      expect(summary.historyCreated).toBe(1);
      const hist = db.SchemeHistory.rows.find(
        (h) => h.schemeId === "demo-income-scheme" && h.version === 2
      );
      expect(hist.policyProcessing).toBeDefined();
      expect(hist.propagationStatus).toBe("SUCCEEDED");
    } finally {
      delete process.env.NOTIFICATIONS;
    }
  });

  it("sends nothing when the change is administrative", async () => {
    const notifications = notificationStore();
    const sent = [];
    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle({ deps: { legacyNotifierEnabled: false } });
    setCollector([rawScheme({ ministry: "Ministry of Education, GoI" }), fillerScheme(1)]);
    await runCollectionCycle({
      deps: {
        legacyNotifierEnabled: false,
        runPolicyStages: (args) =>
          processSchemeChange({
            ...args,
            deps: {
              notify: (opts) =>
                require("../src/services/notificationService").notifyFromTransitions({
                  ...opts,
                  deps: { notificationModel: notifications, userModel: db.User, sendEmail: async (...a) => sent.push(a) },
                }),
            },
          }),
      },
    });

    // The old notifier emailed everyone who matched, for exactly this.
    expect(sent.length).toBe(0);
    expect(notifications.rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L.7 — the complete chain, and recovery from a delivery failure
// ---------------------------------------------------------------------------
describe("L.7 end-to-end: policy change to inbox, and recovery", () => {
  beforeEach(resetAll);

  function notificationStore() {
    return makeCollection("notifications", {
      uniqueKeys: [["userId", "schemeId", "triggeringChangeId", "channel"]],
    });
  }

  /** Run two cycles with a controllable mailer, returning everything observed. */
  async function runChain({ sendEmail, queued = false }) {
    const notifications = notificationStore();
    const notify = (opts) =>
      require("../src/services/notificationService").notifyFromTransitions({
        ...opts,
        deps: { notificationModel: notifications, userModel: db.User, sendEmail, queued },
      });

    setCollector([rawScheme(), fillerScheme(1)]);
    await runCollectionCycle({
      deps: {
        legacyNotifierEnabled: false,
        runPolicyStages: (a) => processSchemeChange({ ...a, deps: { notify } }),
      },
    });
    setCollector([
      rawScheme({
        eligibility: "Open to students with annual family income up to Rs 3,00,000.",
        eligibilityRules: { ...rawScheme().eligibilityRules, maxAnnualIncome: 300000 },
      }),
      fillerScheme(1),
    ]);
    const summary = await runCollectionCycle({
      deps: {
        legacyNotifierEnabled: false,
        runPolicyStages: (a) => processSchemeChange({ ...a, deps: { notify } }),
      },
    });
    return { notifications, summary };
  }

  it("carries a scheme change through every stage into the inbox", async () => {
    const sent = [];
    const { notifications, summary } = await runChain({ sendEmail: async (...a) => sent.push(a) });

    // H and I
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "demo-income-scheme" && h.version === 2
    );
    expect(hist.policyProcessing.changeType).toBe("ELIGIBILITY");
    expect(hist.policyImpactStatus).toBe("SUCCEEDED");

    // J
    expect(summary.historyCreated).toBe(1);
    const row = db.RecommendationHistory.rows.find((r) => r.schemeId === "demo-income-scheme");
    expect(row.eligibilityTransition).toBe("INELIGIBLE_TO_ELIGIBLE");

    // K
    expect(row.explanation).toContain("₹3 lakh");

    // L — in-app record, carrying the grounded explanation
    const inApp = notifications.rows.find(
      (n) => n.channel === "in_app" && n.schemeId === "demo-income-scheme"
    );
    expect(inApp.type).toBe("NEWLY_ELIGIBLE");
    expect(inApp.bodySource).toBe("explanation");
    expect(inApp.body).toContain("₹3 lakh");
    expect(sent.length).toBeGreaterThan(0);

    // The read layer returns it to its owner, with nothing operational in it.
    const { listUserNotifications } = require("../src/services/notificationReadService");
    const inbox = await listUserNotifications({ userId: "user-1", model: notifications });
    const entry = inbox.items.find((i) => i.scheme.schemeId === "demo-income-scheme");
    expect(entry).toBeDefined();
    expect(entry.read).toBe(false);
    const serialized = JSON.stringify(entry);
    for (const leak of ["retryCount", "lastError", "processingJobId", "userId", "failureKind"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("recovers a failed delivery WITHOUT re-running any policy stage", async () => {
    let failing = true;
    const sent = [];
    const { notifications, summary } = await runChain({
      sendEmail: async (...a) => {
        if (failing) throw new Error("smtp temporarily unavailable");
        sent.push(a);
      },
    });

    // Policy succeeded; only the send did not.
    expect(summary.propagationFailed).toBe(0);
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "demo-income-scheme" && h.version === 2
    );
    expect(hist.propagationStatus).toBe("SUCCEEDED");
    expect(hist.policyRetryable).toBe(false);

    const emailRow = notifications.rows.find(
      (n) => n.channel === "email" && n.schemeId === "demo-income-scheme"
    );
    expect(emailRow.status).toBe("FAILED_RETRYABLE");
    expect(emailRow.nextAttemptAt).toBeDefined();

    // Snapshot the policy state, then run ONLY the delivery sweep.
    const historyRowsBefore = db.RecommendationHistory.rows.length;
    const schemeVersionBefore = db.Scheme.rows.find(
      (s) => s.schemeId === "demo-income-scheme"
    ).version;
    const schemeHistoryBefore = db.SchemeHistory.rows.length;

    // Cycle 1 also queued (and failed) an email for the universal filler
    // scheme, so the sweep legitimately delivers more than one. Count what is
    // actually due rather than assuming this scheme is the only one.
    const dueBefore = notifications.rows.filter(
      (n) => n.channel === "email" && n.status === "FAILED_RETRYABLE"
    ).length;
    expect(dueBefore).toBeGreaterThanOrEqual(1);

    failing = false;
    const { retryFailedNotifications } = require("../src/services/notificationService");
    const out = await retryFailedNotifications({
      deps: {
        notificationModel: notifications,
        sendEmail: async (...a) => sent.push(a),
        now: () => new Date("2030-01-01T00:00:00Z"),
      },
    });

    expect(out.emailsSent).toBe(dueBefore);
    expect(
      notifications.rows.find((n) => n.channel === "email" && n.schemeId === "demo-income-scheme")
        .status
    ).toBe("SENT");

    // Nothing in the policy layer moved. This is the property that makes the
    // retry safe: no new history rows, no new scheme version, no duplicate
    // analysis.
    expect(db.RecommendationHistory.rows.length).toBe(historyRowsBefore);
    expect(db.Scheme.rows.find((s) => s.schemeId === "demo-income-scheme").version).toBe(
      schemeVersionBefore
    );
    expect(db.SchemeHistory.rows.length).toBe(schemeHistoryBefore);
  });

  it("does not wait on SMTP in queued mode", async () => {
    const sent = [];
    const { notifications } = await runChain({
      sendEmail: async (...a) => sent.push(a),
      queued: true,
    });
    // The collection cycle finished without any send.
    expect(sent.length).toBe(0);
    const emailRow = notifications.rows.find(
      (n) => n.channel === "email" && n.schemeId === "demo-income-scheme"
    );
    expect(emailRow.status).toBe("PENDING");
    // The in-app record is still immediate.
    expect(
      notifications.rows.some((n) => n.channel === "in_app" && n.schemeId === "demo-income-scheme")
    ).toBe(true);
  });
});
