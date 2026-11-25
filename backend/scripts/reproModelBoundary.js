/**
 * REPRODUCTION HARNESS — the test-suite model-boundary escape.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS
 * ---------------------------------------------------------------------------
 * A production service that reads a Mongoose model directly, instead of taking
 * it by injection, escapes the test suite's model boundary silently. Nothing
 * warns. Real mongoose does NOT throw when there is no connection — it BUFFERS
 * the operation for bufferTimeoutMS (10 s by default) and only then rejects.
 * Under Jest's 5 s timeout that presents as:
 *
 *     ● timeout - Async callback was not invoked within the 5000 ms timeout
 *     ReferenceError: You are trying to `import` a file after the Jest
 *     environment has been torn down.
 *
 * The timeout is the symptom; the escaped model is the cause. Two of them were
 * found this way — `SchemeChunk` (RAG indexing) and `Notification` (the
 * notification stage) — and the second was invisible until the first was fixed,
 * because the RAG stage ran first and killed the test before the notification
 * stage was reached.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NEEDS ITS OWN MONGOOSE
 * ---------------------------------------------------------------------------
 * The sandbox mongoose stub resolves every operation immediately, which is
 * exactly why no offline run ever caught this. This harness therefore installs
 * a BUFFERING-FAITHFUL stub of its own before requiring anything, and races two
 * collection cycles against a Jest-shaped 5 s deadline.
 *
 *   node scripts/reproModelBoundary.js                 # current state
 *   node scripts/reproModelBoundary.js --no-inject     # drop the deps chain
 *   node scripts/reproModelBoundary.js --no-module-mock  # drop the module mocks
 *
 * Exit code 0 means every model stayed inside the boundary and NOTHING was
 * buffered against a real Mongoose model. Any other exit code names what leaked.
 *
 * This runs standalone. It does not need Jest, a network, or a database.
 */
const path = require("path");
const Module = require("module");

const NO_INJECT = process.argv.includes("--no-inject");
const NO_MODULE_MOCK = process.argv.includes("--no-module-mock");
const DEADLINE_MS = 5000; // Jest's default testTimeout.
const BUFFER_MS = Number(process.env.STUB_BUFFER_TIMEOUT_MS || 10000); // mongoose default.

process.env.NODE_ENV = "test";
process.env.POLICY_CHANGE_LLM = "false";
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.MONGODB_URI;

// ---------------------------------------------------------------------------
// The buffering-faithful mongoose, installed before any model is loaded.
// ---------------------------------------------------------------------------
const pending = [];

function buffered(op) {
  pending.push(op);
  return new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`Operation \`${op}\` buffering timed out after ${BUFFER_MS}ms`)),
      BUFFER_MS
    );
  });
}

function makeBufferingMongoose() {
  class Schema {
    constructor(definition, options) {
      this.obj = definition;
      this.opts = options;
      this.methods = {};
      this.statics = {};
      this.virtuals = {};
    }
    index() { return this; }
    pre() { return this; }
    post() { return this; }
    virtual(name) {
      const v = { get() { return v; }, set() { return v; } };
      this.virtuals[name] = v;
      return v;
    }
    method(n, f) { this.methods[n] = f; return this; }
    static(n, f) { this.statics[n] = f; return this; }
    set() { return this; }
    plugin() { return this; }
  }
  Schema.Types = { Mixed: "Mixed", ObjectId: String };

  const query = (op) => ({
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    skip() { return this; },
    lean() { return this; },
    batchSize() { return this; },
    cursor: () => ({ next: async () => null }),
    then(resolve, reject) { return buffered(op).then(resolve, reject); },
  });

  const model = (name, schema) => {
    function Model(doc) { Object.assign(this, doc); }
    if (schema && schema.methods) Object.assign(Model.prototype, schema.methods);
    Model.prototype.save = function save() { return buffered(`${name}.save`); };
    Model.prototype.toObject = function toObject() { return { ...this }; };
    Object.assign(Model, {
      modelName: name,
      schema,
      find: () => query(`${name}.find`),
      findOne: () => query(`${name}.findOne`),
      findById: () => query(`${name}.findById`),
      create: () => buffered(`${name}.create`),
      countDocuments: () => buffered(`${name}.countDocuments`),
      updateOne: () => buffered(`${name}.updateOne`),
      updateMany: () => buffered(`${name}.updateMany`),
      deleteMany: () => buffered(`${name}.deleteMany`),
      insertMany: () => buffered(`${name}.insertMany`),
      aggregate: () => query(`${name}.aggregate`),
      collection: {},
    });
    if (schema && schema.statics) Object.assign(Model, schema.statics);
    return Model;
  };

  return {
    Schema,
    model,
    connect: async () => {},
    disconnect: async () => {},
    connection: { readyState: 0, close: async () => {} },
    Types: { ObjectId: String },
    set() {},
  };
}

const BUFFERING_MONGOOSE = makeBufferingMongoose();

// ---------------------------------------------------------------------------
// Module substitution — the same set tests/pipelineIntegration.test.js mocks.
// ---------------------------------------------------------------------------
const { makeDb } = require(path.join(__dirname, "..", "tests", "helpers", "inMemoryDb"));
const db = makeDb();
const SRC = path.join(__dirname, "..", "src");

let collectorItems = [];

const substitutions = new Map([
  [path.join(SRC, "models", "Scheme.js"), db.Scheme],
  [path.join(SRC, "models", "SchemeHistory.js"), db.SchemeHistory],
  [path.join(SRC, "models", "User.js"), db.User],
  [path.join(SRC, "models", "RecommendationHistory.js"), db.RecommendationHistory],
  [path.join(SRC, "collectors", "index.js"), { collectAll: async () => collectorItems }],
  [path.join(SRC, "services", "aiSummary.js"), { generateChangeSummary: async () => "synthetic summary" }],
]);
if (!NO_MODULE_MOCK) {
  substitutions.set(path.join(SRC, "models", "SchemeChunk.js"), db.SchemeChunk);
  substitutions.set(path.join(SRC, "models", "Notification.js"), db.Notification);
}

const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "mongoose") return BUFFERING_MONGOOSE;
  if (parent) {
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      resolved = null;
    }
    if (resolved && substitutions.has(resolved)) return substitutions.get(resolved);
  }
  return origLoad.apply(this, arguments);
};

// notifier keeps its real matcher exports, exactly as the suite does.
const matcher = require(path.join(SRC, "services", "matcher"));
substitutions.set(path.join(SRC, "services", "notifier.js"), {
  notifyMatchingUsers: async () => 0,
  evaluateEligibility: matcher.evaluateEligibility,
  getDocumentReadiness: matcher.getDocumentReadiness,
});

const { runCollectionCycle } = require(path.join(SRC, "services", "pipeline"));

// ---------------------------------------------------------------------------
// Fixtures — trimmed from tests/pipelineIntegration.test.js.
// ---------------------------------------------------------------------------
const rules = (income) => ({
  minAge: null, maxAge: null, maxAnnualIncome: income, minAnnualIncome: null,
  minMarksPercentage: null, minEducationLevel: null,
  genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
  eligibilityType: "constrained", source: "structured", confidence: 0.9, needsReview: false,
});

const scheme = (income, text) => ({
  schemeId: "demo-income-scheme",
  name: "State Merit Scholarship",
  description: "Financial assistance for meritorious students.",
  eligibility: text,
  benefits: "financial assistance of Rs 25000 per year",
  documents: ["Aadhaar"], tags: ["scholarship"], status: "active",
  ministry: "Ministry of Education", state: "", category: ["Education"],
  applicationLink: "https://example.gov.in/apply", lastDate: "2026-12-31",
  eligibilityRules: rules(income),
});

db.User.seed([
  {
    _id: "user-1", email: "student@example.com", name: "Test Student", role: "USER",
    profile: {
      age: 22, annualIncome: 280000, education: "Graduate", state: "Karnataka",
      occupation: "Student", gender: "Female", categories: [],
      documentsAvailable: ["Aadhaar"], marksPercentage: 78,
    },
  },
]);

const setCollector = (items) => {
  collectorItems = items.map((raw) => ({ raw, source: "myscheme" }));
};

const cycleDeps = NO_INJECT
  ? {}
  : { ragChunkModel: db.SchemeChunk, notificationModel: db.Notification };

/** Race the work against a Jest-shaped deadline, exactly as Jest would. */
function withDeadline(promise) {
  let timer;
  const deadline = new Promise((_r, reject) => {
    timer = setTimeout(
      () => reject(new Error(`TIMEOUT — exceeded ${DEADLINE_MS} ms (Jest default testTimeout)`)),
      DEADLINE_MS
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

(async () => {
  const line = "=".repeat(74);
  console.log(line);
  console.log("MODEL BOUNDARY REPRODUCTION — buffering-faithful mongoose, no database");
  console.log(line);
  console.log(`mongoose bufferTimeoutMS   : ${BUFFER_MS} ms   (connection.readyState = 0)`);
  console.log(`Jest-shaped deadline       : ${DEADLINE_MS} ms`);
  console.log(`cycle deps                 : ${NO_INJECT ? "{}   <-- injection chain DISABLED" : "{ ragChunkModel, notificationModel }"}`);
  console.log(`module mocks               : ${NO_MODULE_MOCK ? "SchemeChunk + Notification REMOVED" : "present"}`);
  console.log("-".repeat(74));

  const problems = [];
  try {
    setCollector([scheme(250000, "Open to students with annual family income up to Rs 2,50,000.")]);
    await withDeadline(runCollectionCycle({ deps: cycleDeps }));

    setCollector([scheme(300000, "Open to students with annual family income up to Rs 3,00,000.")]);
    await withDeadline(runCollectionCycle({ deps: cycleDeps }));

    const hist = db.SchemeHistory.rows.find((h) => h.version === 2);
    console.log(`in-memory SchemeChunk.create() calls : ${db.SchemeChunk.spy.creates}`);
    console.log(`in-memory SchemeChunk rows           : ${db.SchemeChunk.rows.length}`);
    console.log(`in-memory Notification rows          : ${db.Notification.rows.length}`);
    console.log(`history.ragIndexStatus               : ${hist && hist.ragIndexStatus}`);
    console.log(`history.propagationStatus            : ${hist && hist.propagationStatus}`);
    console.log(`history.notificationStatus           : ${hist && hist.notificationStatus}`);

    if (db.SchemeChunk.spy.creates === 0) problems.push("no chunk reached the in-memory model");
    if (hist && hist.ragIndexStatus !== "SUCCEEDED") problems.push(`ragIndexStatus ${hist.ragIndexStatus}`);
  } catch (err) {
    problems.push(err.message);
  }

  console.log(`buffered REAL-mongoose operations    : ${pending.length}`);
  if (pending.length) {
    const counts = pending.reduce((a, op) => ((a[op] = (a[op] || 0) + 1), a), {});
    for (const [op, n] of Object.entries(counts)) console.log(`    ${op} x${n}`);
    problems.push(`${pending.length} operation(s) escaped to a real Mongoose model`);
  }

  console.log("-".repeat(74));
  if (problems.length === 0) {
    console.log("VERDICT: PASS — every model stayed inside the test boundary");
  } else {
    console.log("VERDICT: FAIL");
    for (const p of problems) console.log(`  - ${p}`);
  }
  console.log(line);
  process.exit(problems.length === 0 ? 0 : 1);
})();
