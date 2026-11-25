/**
 * PHASE W — PUBLIC RESPONSE-SURFACE AUDIT.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * Every evaluation phase so far measures a function.
 *
 *   O  retrieval staleness      P  guard ablation        Q  candidate selection
 *   R  notification cost        S  schedule arithmetic   T  comparator stability
 *   U  the matcher              V  the change detector
 *
 * All eight call production code in process and inspect what it returns to
 * another piece of production code. **Not one of them looks at what leaves the
 * process.** A field can be correct, well-tested, exhaustively verified — and
 * still be serialized to a caller who should never have seen it. No amount of
 * strengthening those eight harnesses would reach it, because the defect is not
 * in any function's return value; it is in the boundary that publishes it.
 *
 * `tests/apiContract.test.js` (K0.3) already checks the boundary at ROUTE
 * level: it reads endpoint strings out of the frontend and the routers and
 * fails when either side moves without the other. This is the same check one
 * level deeper — at FIELD level. It exists for the same reason that one does:
 * nothing was looking at both sides at once.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PROPERTIES
 * ---------------------------------------------------------------------------
 *   W.1 CONFINEMENT   No field classified INTERNAL may appear in a response
 *                     from a route that requires no authentication.
 *
 *   W.2 SUFFICIENCY   Every field the frontend actually reads from a response
 *                     must still be present in it.
 *
 * Either property alone is trivially satisfiable and useless. Confinement is
 * satisfied by returning `{}`; sufficiency is satisfied by returning the raw
 * document. A projection is only correct when it is squeezed from both sides,
 * so both are asserted and a failure of either fails the run.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE THREE INPUTS COME FROM — AND WHY NONE IS THE PROJECTION
 * ---------------------------------------------------------------------------
 * The Phase W brief forbids an oracle that is the production mechanism run
 * twice. So none of the three inputs below is read from
 * `services/publicProjection.js`:
 *
 *   1. WHAT CAN BE EMITTED — enumerated from the Mongoose schema definitions
 *      (`schema.obj`, recursing into sub-schemas), plus the `_id` and `__v`
 *      that Mongoose adds to every document. This is the set of fields a stored
 *      row can carry, independent of any opinion about which are public.
 *
 *   2. WHAT IS INTERNAL — a declared policy table below, written from each
 *      field's own documentation in the model files. This is the judgement, and
 *      it is stated once, in the open, with a reason per field.
 *
 *   3. WHAT IS NEEDED — parsed from the FRONTEND source: the property accesses
 *      the components perform on each endpoint's response. The client is the
 *      authority on what the client needs; asking the server would be asking
 *      the projection to grade itself.
 *
 * The projection is then run over a fully-populated row and its OUTPUT is
 * judged against (2) and (3). It is the thing under test, never a source of
 * truth — which is what makes a wrong projection detectable in both directions.
 */

const fs = require("fs");
const path = require("path");

const Scheme = require("../models/Scheme");
const SchemeHistory = require("../models/SchemeHistory");
const {
  toPublicScheme,
  toPublicHistoryEntry,
} = require("../services/publicProjection");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const ROUTES_DIR = path.join(BACKEND_ROOT, "src", "routes");
const FRONTEND_SRC = path.join(BACKEND_ROOT, "..", "frontend", "src");

// ---------------------------------------------------------------------------
// 1. WHAT CAN BE EMITTED — from the schema definitions
// ---------------------------------------------------------------------------

/**
 * Mongoose adds these to every document whether or not the schema names them,
 * and `res.json(doc)` serializes both. They are the clearest possible case of a
 * field nobody declared and nobody wanted published.
 */
const MONGOOSE_IMPLICIT_FIELDS = Object.freeze(["_id", "__v"]);

/**
 * Field paths a stored document can carry.
 *
 * Read from `schema.obj`, the definition object the model file passed in.
 * `schema.paths` — populated only after Mongoose compiles the schema — would
 * also work under real Mongoose, but `schema.obj` is used deliberately so
 * this enumeration has no dependency on compilation having happened yet, and
 * matches what the model file itself declares rather than a derived,
 * post-processed structure. `tests/responseSurface.test.js` cross-checks
 * this against real `schema.paths` to make sure nothing is missed.
 */
function schemaFieldPaths(model, prefix = "") {
  const definition = model?.schema?.obj || {};
  const paths = [];
  for (const [key, spec] of Object.entries(definition)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const nested = spec && spec.type && spec.type.obj ? spec.type : null;
    if (nested) {
      paths.push(full);
      paths.push(...schemaFieldPaths({ schema: nested }, full));
    } else {
      paths.push(full);
    }
  }
  // `{ timestamps: true }` is a SCHEMA OPTION, not a field in `schema.obj` —
  // Mongoose compiles `createdAt`/`updatedAt` paths from it at schema-build
  // time, so a document under such a schema really carries them even though
  // no field definition ever names them. Real Jest confirms `Scheme.schema
  // .paths` has both. That makes them the same kind of gap `_id`/`__v` are:
  // implicit, but here they are PER-MODEL (only schemas that opt in get
  // them), so they belong in this per-model enumeration rather than in the
  // global `MONGOOSE_IMPLICIT_FIELDS` every model shares. Only applied at the
  // top level: an embedded sub-schema (e.g. EligibilityRulesSchema) never
  // receives its own timestamps regardless of the parent schema's setting.
  if (!prefix) {
    paths.push(...timestampFieldNames(model));
  }
  return paths;
}

/**
 * The `createdAt`/`updatedAt` (or custom-named equivalents) paths a schema's
 * `{ timestamps: ... }` option compiles in, or `[]` if the schema didn't ask
 * for them (e.g. `{ timestamps: false }`, the default for every model here
 * except `Scheme` and `User`).
 */
function timestampFieldNames(model) {
  const opt = model?.schema?.options?.timestamps;
  if (!opt) return [];
  if (opt === true) return ["createdAt", "updatedAt"];
  const names = [];
  if (opt.createdAt !== false) names.push(typeof opt.createdAt === "string" ? opt.createdAt : "createdAt");
  if (opt.updatedAt !== false) names.push(typeof opt.updatedAt === "string" ? opt.updatedAt : "updatedAt");
  return names;
}

function documentFieldUniverse(model) {
  return [...MONGOOSE_IMPLICIT_FIELDS, ...schemaFieldPaths(model)];
}

// ---------------------------------------------------------------------------
// 2. WHAT IS INTERNAL — the declared policy
// ---------------------------------------------------------------------------

/**
 * Classification of every field a Scheme or SchemeHistory row can carry.
 *
 * Written from the model files' own comments, not from the projection. Where
 * the model says a field exists "for the admin dashboard and for auditing", or
 * is "the RAG sweep's own flag", that is the documentation classifying it —
 * this table only writes it down.
 *
 * A field absent from this table is UNDECLARED, which the audit reports rather
 * than assumes. Defaulting an unknown field to PUBLIC would rebuild the exact
 * hazard Phase W is fixing; defaulting it to INTERNAL would let the table rot
 * quietly. Reporting it makes the next person decide.
 */
const INTERNAL = "INTERNAL";
const PUBLIC = "PUBLIC";
/**
 * A path that holds other paths rather than a value of its own. Judged by its
 * members, never by itself — otherwise "the container is internal" would
 * condemn a projection that correctly narrows it, and "the container is public"
 * would bless one that passes the whole thing through.
 */
const CONTAINER = "CONTAINER";

const EXPOSURE_POLICY = Object.freeze({
  Scheme: {
    _id: [INTERNAL, "Mongoose object id — an internal identifier; schemeId is the public key"],
    __v: [INTERNAL, "Mongoose version key — storage detail"],
    schemeId: [PUBLIC, "the public identifier the frontend routes on"],
    name: [PUBLIC, "scheme fact"],
    description: [PUBLIC, "scheme fact"],
    eligibility: [PUBLIC, "scheme fact — free text, display"],
    eligibilityRules: [CONTAINER, "judged by its member rules below"],
    "eligibilityRules.minAge": [PUBLIC, "policy threshold"],
    "eligibilityRules.maxAge": [PUBLIC, "policy threshold"],
    "eligibilityRules.maxAnnualIncome": [PUBLIC, "policy threshold"],
    "eligibilityRules.minAnnualIncome": [PUBLIC, "policy threshold"],
    "eligibilityRules.minMarksPercentage": [PUBLIC, "policy threshold"],
    "eligibilityRules.minEducationLevel": [PUBLIC, "policy threshold"],
    "eligibilityRules.maxEducationLevel": [PUBLIC, "policy threshold"],
    "eligibilityRules.genders": [PUBLIC, "policy constraint"],
    "eligibilityRules.categories": [PUBLIC, "policy constraint"],
    "eligibilityRules.categoryGroups": [PUBLIC, "policy constraint"],
    "eligibilityRules.occupations": [PUBLIC, "policy constraint"],
    "eligibilityRules.applicantTypes": [PUBLIC, "policy constraint"],
    "eligibilityRules.states": [PUBLIC, "policy constraint"],
    "eligibilityRules.courses": [PUBLIC, "policy constraint"],
    "eligibilityRules.disabilityRequired": [PUBLIC, "policy constraint"],
    "eligibilityRules.minDisabilityPercentage": [PUBLIC, "policy threshold"],
    "eligibilityRules.singleGirlChildRequired": [PUBLIC, "policy constraint"],
    "eligibilityRules.eligibilityType": [PUBLIC, "which branch the matcher takes — a fact about the scheme"],
    "eligibilityRules.source": [INTERNAL, "which extractor produced the rules — our pipeline, not the policy"],
    "eligibilityRules.confidence": [INTERNAL, "our extractor's self-assessed certainty"],
    "eligibilityRules.needsReview": [INTERNAL, "model comment: 'UI/admin flow can filter on this' — an internal review queue flag"],
    "eligibilityRules.extractedAt": [INTERNAL, "when our pipeline last parsed the text"],
    benefits: [PUBLIC, "scheme fact"],
    documents: [PUBLIC, "scheme fact"],
    lastDate: [PUBLIC, "scheme fact"],
    applicationLink: [PUBLIC, "scheme fact"],
    ministry: [PUBLIC, "scheme fact"],
    state: [PUBLIC, "scheme fact"],
    category: [PUBLIC, "scheme fact"],
    tags: [PUBLIC, "scheme fact"],
    status: [PUBLIC, "scheme fact — open or closed"],
    source: [PUBLIC, "provenance; the detail page renders it"],
    sourceUrl: [PUBLIC, "provenance; the detail page links it"],
    version: [PUBLIC, "provenance; the browse page renders version dots"],
    contentHash: [INTERNAL, "the change detector's fingerprint — an artifact of the mechanism, not of the policy"],
    firstSeenAt: [PUBLIC, "provenance; the detail page renders it"],
    lastCheckedAt: [INTERNAL, "describes the crawler's schedule, not the scheme"],
    lastUpdatedAt: [PUBLIC, "provenance; the detail page renders it"],
    // `{ timestamps: true }` on SchemeSchema compiles these two paths in
    // addition to the model's own explicit `firstSeenAt`/`lastUpdatedAt`.
    // They duplicate information those two already carry and are not in
    // `SCHEME_PUBLIC_FIELDS` (services/publicProjection.js) — an artifact of
    // the schema option, not a fact about the scheme itself.
    createdAt: [INTERNAL, "Mongoose's auto timestamp — duplicates firstSeenAt; not in the projection"],
    updatedAt: [INTERNAL, "Mongoose's auto timestamp — duplicates lastUpdatedAt; not in the projection"],
  },
  SchemeHistory: {
    _id: [INTERNAL, "Mongoose object id; also the propagation idempotency key"],
    __v: [INTERNAL, "Mongoose version key — storage detail"],
    schemeId: [PUBLIC, "the public identifier the feed links on"],
    version: [PUBLIC, "which version of the scheme this row records"],
    eventType: [PUBLIC, "CREATED or UPDATED — the story of the change"],
    // `snapshot` is a whole Scheme document. Its members are therefore
    // classified by the Scheme policy above rather than re-listed here — which
    // is what makes `snapshot.contentHash` a leak if the raw snapshot is ever
    // passed through again.
    snapshot: [CONTAINER, "a full copy of the scheme document; classified member-by-member under Scheme"],
    diffs: [CONTAINER, "judged by its member fields below"],
    "diffs.field": [PUBLIC, "which field moved"],
    "diffs.oldValue": [PUBLIC, "the value before"],
    "diffs.newValue": [PUBLIC, "the value after"],
    aiSummary: [PUBLIC, "plain-language explanation written for the reader"],
    policyImpactStatus: [INTERNAL, "pipeline stage outcome — operational"],
    propagationStatus: [INTERNAL, "pipeline stage outcome — operational"],
    policyRetryable: [INTERNAL, "retry data — drives the recovery sweep"],
    policyProcessing: [INTERNAL, "job ids, candidate-selection mode, affected-user counts and provider error messages"],
    ragIndexStatus: [INTERNAL, "pipeline stage outcome — operational"],
    ragIndexRetryable: [INTERNAL, "model comment: 'the RAG sweep's own flag' — retry data"],
    ragIndexing: [INTERNAL, "embedding durations, degraded flags and provider error messages"],
    createdAt: [PUBLIC, "when the change was recorded; both feeds render it"],
  },
});

function classify(modelName, field) {
  // A history row's `snapshot` IS a Scheme document, so its members are graded
  // by the Scheme policy. Re-listing them here would let the two copies drift,
  // and a drifted copy would grade the same field differently depending on
  // which endpoint served it.
  if (modelName === "SchemeHistory" && field.startsWith("snapshot.")) {
    return EXPOSURE_POLICY.Scheme[field.slice("snapshot.".length)] || null;
  }
  return EXPOSURE_POLICY[modelName]?.[field] || null;
}

// ---------------------------------------------------------------------------
// 3. WHAT IS NEEDED — parsed from the frontend
// ---------------------------------------------------------------------------

/**
 * Which endpoint each frontend file consumes, and under which local variable
 * name the response rows are read.
 *
 * Stated as a small map rather than inferred, because inferring "this variable
 * holds that response" from JSX requires dataflow analysis, and a scanner that
 * quietly resolves nothing would report zero required fields — a sufficiency
 * check that can never fail. The bindings are asserted against the frontend
 * source by `tests/responseSurface.test.js`, so a rename breaks the test rather
 * than silently emptying the audit.
 */
const FRONTEND_BINDINGS = Object.freeze([
  { endpoint: "GET /schemes/:schemeId/history", file: "pages/SchemeDetail.jsx", accessors: ["entry", "h", "historyRes.data"] },
  { endpoint: "GET /updates/recent", file: "pages/Admin.jsx", accessors: ["entry", "u"] },
  { endpoint: "GET /schemes/:schemeId", file: "pages/SchemeDetail.jsx", accessors: ["scheme"] },
  { endpoint: "GET /schemes", file: "pages/Browse.jsx", accessors: ["scheme", "s"] },
]);

/**
 * Every property read off the named accessors in one frontend file.
 *
 * Deliberately over-collects: optional chaining, nested reads and reads inside
 * template literals all count. Over-collecting makes the sufficiency check
 * stricter, which is the safe direction — a field wrongly believed necessary
 * survives in the response, while one wrongly believed unnecessary would be
 * dropped and break the page.
 */
function frontendFieldsUsed(relFile, accessors) {
  const full = path.join(FRONTEND_SRC, relFile);
  if (!fs.existsSync(full)) return null;
  const src = fs.readFileSync(full, "utf8");
  const used = new Set();
  for (const accessor of accessors) {
    const escaped = accessor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
    for (const m of src.matchAll(re)) {
      // `.data`, `.map`, `.length` and friends are JS, not response fields.
      if (!JS_NOISE.has(m[1])) used.add(m[1]);
    }
  }
  return [...used].sort();
}

const JS_NOISE = new Set([
  "data", "map", "filter", "find", "length", "slice", "join", "toLowerCase",
  "toUpperCase", "forEach", "some", "every", "reduce", "includes", "sort",
  "push", "then", "catch", "toString", "response", "status", "headers",
]);

// ---------------------------------------------------------------------------
// A fully-populated row, so nothing is missed by being absent
// ---------------------------------------------------------------------------

/**
 * Build a document that carries EVERY field its schema declares.
 *
 * A projection is only tested by what it is given. Auditing a sparse row would
 * let a leak hide behind an absent value, so the fixtures below set every path
 * in the universe to a non-empty marker, and the audit asserts that they do.
 */
function fullyPopulated(model, values) {
  const universe = documentFieldUniverse(model);
  const missing = universe.filter((f) => {
    const parts = f.split(".");
    let cursor = values;
    for (const part of parts) {
      if (cursor === null || cursor === undefined || !(part in cursor)) return true;
      cursor = cursor[part];
    }
    return false;
  });
  if (missing.length > 0) {
    throw new Error(
      `PHASE W: the ${model.modelName} fixture does not populate ${missing.join(", ")}. ` +
        `An unpopulated field cannot leak, so the audit would pass by not looking.`
    );
  }
  return values;
}

const SCHEME_FIXTURE = {
  _id: "665f1c2ab9d4e70012a4c880",
  __v: 0,
  schemeId: "vidya-scholarship",
  name: "Vidya Scholarship",
  description: "Financial assistance for students.",
  eligibility: "Students resident in the state.",
  eligibilityRules: {
    minAge: 18, maxAge: 30,
    maxAnnualIncome: 200000, minAnnualIncome: 10000,
    minMarksPercentage: 60, minEducationLevel: "12th Standard",
    maxEducationLevel: "Graduate",
    genders: ["Female"], categories: ["SC"], categoryGroups: [["SC", "ST"]],
    courses: ["Computer Science"], disabilityRequired: true, minDisabilityPercentage: 40,
    singleGirlChildRequired: false,
    occupations: ["Student"], applicantTypes: ["STUDENT"], states: ["Kerala"],
    source: "llm-extracted",
    eligibilityType: "constrained",
    confidence: 0.62,
    needsReview: true,
    extractedAt: "2026-08-20T00:00:00.000Z",
  },
  benefits: "Rs 20000 per year",
  documents: ["Aadhaar Card"],
  lastDate: "2026-12-31",
  applicationLink: "https://example.gov.in/apply",
  ministry: "Education",
  state: "Kerala",
  category: ["Education"],
  tags: ["Student"],
  status: "Active",
  source: "myScheme",
  sourceUrl: "https://example.gov.in/scheme",
  version: 7,
  contentHash: "9f2c4b1ad0e7c3f5a8b6d2e4c7091b3d5f8a2c6e4b0d9f1a3c5e7b9d1f3a5c7e",
  firstSeenAt: "2026-01-04T00:00:00.000Z",
  lastCheckedAt: "2026-08-29T03:00:00.000Z",
  lastUpdatedAt: "2026-08-29T03:00:12.000Z",
  createdAt: "2026-01-04T00:00:00.000Z",
  updatedAt: "2026-08-29T03:00:12.000Z",
};

/**
 * The history fixture reproduces what `policyPipeline.persistStatus` actually
 * writes, including the provider error strings — a quota message carrying a
 * Google project number, and an embedding failure carrying an internal IP.
 * Those are the concrete reason this phase exists, so the audit is run against
 * them rather than against a placeholder.
 */
const HISTORY_FIXTURE = {
  _id: "665f1c2ab9d4e70012a4c881",
  __v: 0,
  schemeId: "vidya-scholarship",
  version: 7,
  eventType: "UPDATED",
  snapshot: SCHEME_FIXTURE,
  diffs: [
    { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 200000 },
  ],
  aiSummary: "The income ceiling was lowered to Rs 2,00,000.",
  policyImpactStatus: "FAILED",
  propagationStatus: "PENDING",
  policyRetryable: true,
  policyProcessing: {
    jobId: "cycle-2026-08-29T03:00:12Z",
    changeId: "vidya-scholarship:v7",
    changeType: "ELIGIBILITY",
    severity: "CRITICAL",
    candidateSelection: "targeted-band",
    scannedEveryUser: false,
    narrowingProven: true,
    completenessGuaranteed: true,
    affectedUserCount: 1843,
    historyCreated: 1843,
    historySkipped: 0,
    durationMs: 41207,
    processedAt: "2026-08-29T03:00:53.114Z",
    errors: [
      {
        stage: "explanation",
        error:
          "GoogleGenerativeAI Error: [429] Quota exceeded for quota metric 'Generate requests' " +
          "for consumer 'project_number:918273645500'.",
      },
    ],
  },
  ragIndexStatus: "FAILED",
  ragIndexRetryable: true,
  ragIndexing: {
    chunksIndexed: 0,
    chunksSuperseded: 0,
    embeddingDegraded: true,
    durationMs: 1201,
    indexedAt: "2026-08-29T03:00:54.900Z",
    errors: [{ stage: "embedding", error: "connect ETIMEDOUT 10.0.4.19:443" }],
  },
  createdAt: "2026-08-29T03:00:12.004Z",
};

// ---------------------------------------------------------------------------
// Route inventory — which endpoints are unauthenticated
// ---------------------------------------------------------------------------

/**
 * Read each route's declaration out of the router source and record whether
 * `requireAuth` appears in it, and whether its `res.json(...)` goes through a
 * projection.
 *
 * Parsed rather than hardcoded, following `tests/apiContract.test.js`: a route
 * that loses its guard must show up here as newly public, and a hardcoded list
 * would keep reporting the old answer.
 */
/**
 * Remove comments before scanning a handler body.
 *
 * Not cosmetic: the Phase W comment inside `GET /schemes` explains the defect
 * by quoting `res.json(doc)`, and without this the scanner read that quotation
 * as a real response and reported the fixed route as unprojected. A checker
 * that cannot tell code from prose about code produces exactly the kind of
 * false alarm that trains people to ignore it.
 *
 * Block comments and whole-line comments only, so a `//` inside a URL string
 * is left alone.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/**
 * Does every response in a handler go through a projection?
 *
 * EVERY, not SOME. A handler with two exits — an early raw one and a projected
 * one — leaks on the path nobody looked at, and that is the more likely shape
 * of a future regression than a wholly unprojected route. Mutation W-M14
 * weakened this to `some` and survived the audit, because every current handler
 * has exactly one exit; it is killed by testing this predicate directly on a
 * mixed list rather than by waiting for such a handler to exist.
 *
 * An inline object literal is a projection by construction: an error body or an
 * { ok: true } acknowledgement names its own fields.
 */
function isProjectedResponse(responses) {
  return responses.every(
    (arg) => arg.startsWith("{") || /^toPublic|toSafeJSON|\bserialize\(|^await |^list|^mark/.test(arg)
  );
}

function routeInventory() {
  const routes = [];
  for (const file of fs.readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    const re = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]([\s\S]*?)(?=\n(?:router\.|module\.exports|function |const |\/\*\*))/g;
    for (const m of src.matchAll(re)) {
      const body = stripComments(m[3]);
      // Every `res.json(...)` in the handler that is not an inline literal
      // (an error, an { ok: true } acknowledgement) must go through a
      // projection. Without this the audit could be satisfied while the route
      // quietly went back to `res.json(doc)` — it grades the projection
      // function, and a route that does not call it is not covered by it.
      const responses = [...body.matchAll(/res\.json\(\s*([^)]*)/g)].map((r) => r[1].trim());
      routes.push({
        method: m[1].toUpperCase(),
        route: m[2],
        file,
        authenticated: /requireAuth|ownData/.test(body),
        responses,
        projected: isProjectedResponse(responses),
      });
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/** Flatten an object into dotted paths, so a nested leak is visible. */
function flattenPaths(value, prefix = "", out = []) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenPaths(item, prefix, out);
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    out.push(full);
    flattenPaths(v, full, out);
  }
  return out;
}

const SURFACES = [
  {
    endpoint: "GET /updates/recent",
    model: "SchemeHistory",
    project: toPublicHistoryEntry,
    fixtureName: "HISTORY_FIXTURE",
  },
  {
    endpoint: "GET /schemes/:schemeId/history",
    model: "SchemeHistory",
    project: toPublicHistoryEntry,
    fixtureName: "HISTORY_FIXTURE",
  },
  {
    endpoint: "GET /schemes",
    model: "Scheme",
    project: toPublicScheme,
    fixtureName: "SCHEME_FIXTURE",
  },
  {
    endpoint: "GET /schemes/:schemeId",
    model: "Scheme",
    project: toPublicScheme,
    fixtureName: "SCHEME_FIXTURE",
  },
];

const MODELS = { Scheme, SchemeHistory };
const FIXTURES = { SCHEME_FIXTURE, HISTORY_FIXTURE };

/**
 * @param {Object} [opts]
 * @param {Array}  [opts.surfaces]  injectable surface list — the DI seam the
 *   tests use to hand the audit a deliberately-broken projection. Without it
 *   the emptied-field and leak branches can only be exercised by breaking
 *   production, so a mutation that disables them survives on a branch nothing
 *   reaches (that is exactly what W-M15 did).
 */
function runResponseSurfaceAudit({ surfaces: surfaceList = SURFACES } = {}) {
  // Refuse to run against a sparse fixture — see fullyPopulated().
  fullyPopulated(Scheme, SCHEME_FIXTURE);
  fullyPopulated(SchemeHistory, HISTORY_FIXTURE);

  const inventory = routeInventory();
  const surfaces = [];
  const leaks = [];
  const missing = [];
  const undeclared = [];
  const unprojected = [];

  for (const surface of surfaceList) {
    const model = MODELS[surface.model];
    const fixture = FIXTURES[surface.fixtureName];
    const declared = inventory.find(
      (r) => r.method === "GET" && `GET ${r.route}` === surface.endpoint
    );
    const isPublic = declared ? !declared.authenticated : true;

    // --- W.3 wiring ----------------------------------------------------------
    // The projection can be perfect and still not be called. This is the only
    // check that fails when a route reverts to res.json(doc).
    if (!declared) {
      unprojected.push({ endpoint: surface.endpoint, reason: "route not found in any router" });
    } else if (!declared.projected) {
      unprojected.push({
        endpoint: surface.endpoint,
        reason: `responds with ${declared.responses.join(", ")} — not a projection`,
      });
    }

    const projected = surface.project(fixture);
    const emitted = flattenPaths(projected);

    // --- W.1 confinement -----------------------------------------------------
    for (const field of emitted) {
      const policy = classify(surface.model, field);
      if (!policy) {
        undeclared.push({ endpoint: surface.endpoint, model: surface.model, field });
        continue;
      }
      if (policy[0] === CONTAINER) continue; // graded by its members
      if (policy[0] === INTERNAL && isPublic) {
        leaks.push({
          endpoint: surface.endpoint,
          model: surface.model,
          field,
          reason: policy[1],
          value: readPath(projected, field),
        });
      }
    }

    // --- W.2 sufficiency -----------------------------------------------------
    const binding = FRONTEND_BINDINGS.find((b) => b.endpoint === surface.endpoint);
    const required = binding ? frontendFieldsUsed(binding.file, binding.accessors) : null;
    if (required) {
      for (const field of required) {
        // Only fields the model can actually supply are required of it; the
        // components also read local state off the same variable names.
        if (!classify(surface.model, field)) continue;
        if (!(field in projected)) {
          missing.push({ endpoint: surface.endpoint, field, file: binding.file, why: "absent" });
          continue;
        }
        // Present but emptied is the same failure with a better disguise.
        // Mutation W-M5 replaced the diff list with [] — the key survived, the
        // timeline rendered nothing, and a key-presence check called that
        // sufficient. So a field the SOURCE row carries must still carry
        // something after projection.
        if (!isEmptyish(fixture[field]) && isEmptyish(projected[field])) {
          missing.push({ endpoint: surface.endpoint, field, file: binding.file, why: "emptied by the projection" });
        }
      }
    }

    const universe = documentFieldUniverse(model);
    surfaces.push({
      endpoint: surface.endpoint,
      model: surface.model,
      authenticated: !isPublic,
      fieldsInDocument: universe.length,
      fieldsEmitted: emitted.length,
      internalFieldsWithheld: universe.filter(
        (f) => classify(surface.model, f)?.[0] === INTERNAL && !emitted.includes(f)
      ).length,
      internalFieldsInDocument: universe.filter(
        (f) => classify(surface.model, f)?.[0] === INTERNAL
      ).length,
      frontendFieldsRequired: required ? required.filter((f) => classify(surface.model, f)).length : null,
    });
  }

  const status =
    leaks.length === 0 &&
    missing.length === 0 &&
    undeclared.length === 0 &&
    unprojected.length === 0
      ? "CONFINED"
      : "EXPOSED";

  return {
    status,
    surfaces,
    leaks,
    missing,
    undeclared,
    unprojected,
    routes: inventory,
    publicRoutes: inventory.filter((r) => !r.authenticated).length,
    frontendAvailable: fs.existsSync(FRONTEND_SRC),
  };
}

/** Absent, empty array, empty object, or empty string — nothing a page can render. */
function isEmptyish(value) {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function readPath(obj, dotted) {
  let cursor = obj;
  for (const part of dotted.split(".")) {
    if (Array.isArray(cursor)) cursor = cursor[0];
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

module.exports = {
  runResponseSurfaceAudit,
  documentFieldUniverse,
  schemaFieldPaths,
  routeInventory,
  isProjectedResponse,
  isEmptyish,
  stripComments,
  frontendFieldsUsed,
  flattenPaths,
  fullyPopulated,
  readPath,
  classify,
  EXPOSURE_POLICY,
  FRONTEND_BINDINGS,
  MONGOOSE_IMPLICIT_FIELDS,
  SCHEME_FIXTURE,
  HISTORY_FIXTURE,
  SURFACES,
  INTERNAL,
  PUBLIC,
  CONTAINER,
};
