/**
 * PHASE Y — THE INDEX CONTRACT, MADE EXECUTABLE.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * Four production code paths treat a MongoDB duplicate-key error as "already
 * done" and continue:
 *
 *   notificationService  a second in-app notification for the same change
 *   notifier             a second email for the same scheme version
 *   recommendationPropagation  a second history row for the same change
 *   ragIndexer           a second copy of the same chunk
 *
 * Each is exactly-once **only because a unique index rejects the second
 * insert**. The services say so in as many words: *"the pre-check avoids the
 * write on the common replay path. The duplicate-key catch is what actually
 * guarantees uniqueness, because two concurrent runs can both pass a pre-check
 * before either inserts."*
 *
 * So the guarantee does not live in the code. It lives in the database, and a
 * Mongoose `unique: true` is a **request**, not a fact: indexes are built
 * lazily in the background, `autoIndex` is commonly disabled in production, and
 * a unique build over a collection that already contains duplicates fails
 * silently and leaves no constraint at all.
 *
 * Every phase from Q to X verifies code. This one verifies the contract between
 * the code and the database it depends on — the only guarantee in the system
 * that no test can exercise, because the mechanism is not in the process.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PROPERTIES
 * ---------------------------------------------------------------------------
 *   Y.1 DOCUMENTED   every index the models declare appears in the operator's
 *                    checklist (INDEX_VERIFICATION.md). A checklist that has
 *                    drifted from the schemas sends an operator to verify the
 *                    wrong set and report success.
 *
 *   Y.2 BACKED       every uniqueness the CODE depends on is declared unique by
 *                    the model it depends on.
 *
 *   Y.3 LIVE         the declared indexes exist, are unique where required, and
 *                    are finished building on the real cluster.
 *
 * Y.3 needs a database. Without one it reports NOT MEASURED with the reason —
 * never 0, never "assumed present".
 *
 * ---------------------------------------------------------------------------
 * WHERE THE THREE INPUTS COME FROM
 * ---------------------------------------------------------------------------
 *   declared      the Mongoose schema definitions, read via the schema's own
 *                 `indexes()` method (covers both field-level and compound)
 *   documented    parsed out of INDEX_VERIFICATION.md's table
 *   required      scanned from the PRODUCTION SOURCE — which files catch E11000
 *                 and which model they write through
 *
 * `required` is the independent anchor, and it is independent in the direction
 * that matters: it is derived from the code that DEPENDS on a constraint, not
 * from the code that DECLARES one. Deleting `unique: true` from a schema and
 * from the checklist together still leaves the dependency, so Y.2 still fails.
 */

const fs = require("fs");
const path = require("path");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MODELS_DIR = path.join(BACKEND_ROOT, "src", "models");
const SERVICES_DIR = path.join(BACKEND_ROOT, "src", "services");
const CHECKLIST = path.join(BACKEND_ROOT, "INDEX_VERIFICATION.md");

// ---------------------------------------------------------------------------
// 1. DECLARED — what the schemas ask for
// ---------------------------------------------------------------------------

/**
 * Mongoose's own collection naming: lowercase the model name and pluralise.
 * Only the regular cases occur here; an irregular model name would produce a
 * wrong collection name silently, so `collectionNameFor` is asserted against
 * every real model by the tests rather than trusted.
 */
function collectionNameFor(modelName) {
  const lower = String(modelName).toLowerCase();
  if (lower.endsWith("y") && !/[aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

/** Mongo's own name for an index, so declared and live can be compared. */
function indexNameFor(spec) {
  return Object.entries(spec)
    .map(([field, dir]) => `${field}_${dir}`)
    .join("_");
}

/**
 * Every index every model declares.
 *
 * Read from `schema.indexes()`, real Mongoose's own public method for this —
 * it returns every declared index (both `Schema.index({...})` compound calls
 * and per-path `index`/`unique` options) as `[fields, options]` pairs.
 *
 * `schema.indexes_` (a previous version of this function) does NOT exist on
 * real Mongoose — confirmed by a real Jest run: it silently evaluated to
 * `undefined`, so `schema.indexes_ || []` always produced an empty array,
 * and every COMPOUND index this project depends on (the notification/email/
 * history dedup keys, the chunk-uniqueness key, etc.) was invisible to this
 * evaluator despite being correctly declared in every model. Field-level
 * indexes still showed up because they were separately read from
 * `schema.obj`. `schema.indexes()` covers both in one call, correctly, so
 * the separate `schema.obj` walk below is no longer needed.
 */
function declaredIndexes({ modelsDir = MODELS_DIR } = {}) {
  const out = [];
  for (const file of fs.readdirSync(modelsDir).filter((f) => f.endsWith(".js"))) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const model = require(path.join(modelsDir, file));
    const modelName = model.modelName;
    const collection = collectionNameFor(modelName);
    const schema = model.schema || {};

    const indexes =
      typeof schema.indexes === "function" ? schema.indexes() : [];
    for (const [spec, opts = {}] of indexes) {
      const fieldCount = Object.keys(spec).length;
      out.push({
        model: modelName,
        collection,
        name: opts.name || indexNameFor(spec),
        spec,
        unique: !!opts.unique,
        kind: fieldCount > 1 ? "compound" : "field",
        source: file,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. REQUIRED — what the code depends on
// ---------------------------------------------------------------------------

/**
 * The production code paths whose correctness rests on a uniqueness constraint,
 * and the model each writes through.
 *
 * Stated as a table rather than inferred, because resolving "which model does
 * this `model.create` write to" from a variable name needs dataflow analysis,
 * and a scanner that quietly resolved nothing would report zero dependencies —
 * a check that can never fail. Both halves of every row are asserted against
 * the source by `tests/indexContract.test.js`: the file must still catch a
 * duplicate-key error, AND it must still reference that model. A rename breaks
 * the test rather than silently emptying the audit.
 */
const CONSTRAINT_DEPENDENCIES = Object.freeze([
  {
    file: "notificationService.js",
    model: "Notification",
    spec: { userId: 1, schemeId: 1, triggeringChangeId: 1, channel: 1 },
    why: "exactly-once in-app notification per (user, scheme, change, channel) — the pre-check is only an optimisation",
  },
  {
    file: "notifier.js",
    model: "NotificationLog",
    spec: { email: 1, schemeId: 1, version: 1, channel: 1 },
    why: "one email per scheme version per recipient, across retries and concurrent cycles",
  },
  {
    file: "recommendationPropagation.js",
    model: "RecommendationHistory",
    spec: { userId: 1, schemeId: 1, triggeringChangeId: 1 },
    why: "idempotent propagation — a re-run of the same change must not write a second history row",
  },
  {
    file: "ragIndexer.js",
    model: "SchemeChunk",
    spec: { chunkId: 1 },
    why: "a re-indexed version must not produce a second copy that every search returns twice",
  },
]);

const DUPLICATE_KEY_PATTERN = /11000|duplicate key/i;

/** Does this service still depend on a duplicate-key error, and on that model? */
function verifyDependency(dep, { servicesDir = SERVICES_DIR } = {}) {
  const full = path.join(servicesDir, dep.file);
  if (!fs.existsSync(full)) return { ...dep, present: false, reason: "file not found" };
  const src = fs.readFileSync(full, "utf8");
  return {
    ...dep,
    present: true,
    catchesDuplicateKey: DUPLICATE_KEY_PATTERN.test(src),
    referencesModel: new RegExp(`\\b${dep.model}\\b`).test(src),
  };
}

// ---------------------------------------------------------------------------
// 3. DOCUMENTED — what the operator is told to check
// ---------------------------------------------------------------------------

/**
 * Parse the checklist table out of INDEX_VERIFICATION.md.
 *
 * Rows look like:
 *   | `collection` | `index_name` (`alias`) | purpose | **Yes** |
 */
function documentedIndexes({ checklist = CHECKLIST } = {}) {
  if (!fs.existsSync(checklist)) return null;
  const rows = [];
  for (const line of fs.readFileSync(checklist, "utf8").split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!m) continue;
    const [, collection, indexCell, purpose, uniqueCell] = m;
    // The index cell may carry a Mongo name and a parenthesised alias.
    const names = [...indexCell.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    if (names.length === 0) continue;
    rows.push({
      collection,
      names,
      purpose,
      unique: /yes/i.test(uniqueCell),
    });
  }
  return rows;
}

const documentsIndex = (rows, index) =>
  (rows || []).some(
    (r) => r.collection === index.collection && r.names.includes(index.name)
  );

// ---------------------------------------------------------------------------
// 4. LIVE — what the cluster actually has
// ---------------------------------------------------------------------------

/**
 * Read the real indexes, when a real database is reachable.
 *
 * Returns `{ status: "NOT MEASURED", reason }` otherwise, and the reason is the
 * exact one — no connection string, no driver, connection refused. An index
 * whose existence was not observed is NOT reported as absent and NOT reported
 * as present; the whole point of this phase is that a declaration is not a
 * fact, and neither is an assumption in the other direction.
 */
async function liveIndexes({ uri = process.env.MONGODB_URI, timeoutMs = 8000 } = {}) {
  if (!uri) {
    return { status: "NOT MEASURED", reason: "MONGODB_URI is not set", collections: {} };
  }
  let mongoose;
  try {
    // eslint-disable-next-line global-require
    mongoose = require("mongoose");
  } catch (err) {
    return { status: "NOT MEASURED", reason: `mongoose is not installed: ${err.message}`, collections: {} };
  }
  if (typeof mongoose.connect !== "function" || !mongoose.connection) {
    return {
      status: "NOT MEASURED",
      reason: "the mongoose in scope is the sandbox stub, which talks to no database",
      collections: {},
    };
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: timeoutMs });
    const db = mongoose.connection.db;
    // The sandbox stub has `connect` and a `connection` object, and resolves
    // immediately — but exposes no database handle. Naming that plainly matters
    // more than usual here: an operator reading "Cannot read properties of
    // undefined" might reasonably conclude the check is broken rather than that
    // it never reached a database.
    if (!db || typeof db.listCollections !== "function") {
      await mongoose.disconnect().catch(() => {});
      return {
        status: "NOT MEASURED",
        reason: "the mongoose in scope exposes no database handle — it is the sandbox stub, which talks to no database",
        collections: {},
      };
    }
    const collections = {};
    for (const info of await db.listCollections().toArray()) {
      collections[info.name] = await db.collection(info.name).indexes();
    }
    await mongoose.disconnect();
    return { status: "MEASURED", reason: null, collections };
  } catch (err) {
    try {
      await mongoose.disconnect();
    } catch {
      /* disconnect failure must not mask the real error */
    }
    return { status: "NOT MEASURED", reason: `could not read indexes: ${err.message}`, collections: {} };
  }
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

const OUTCOME = Object.freeze({
  UNDOCUMENTED: "UNDOCUMENTED",
  UNBACKED: "UNBACKED",
  DOCUMENTED_BUT_UNDECLARED: "DOCUMENTED_BUT_UNDECLARED",
  MISSING_LIVE: "MISSING_LIVE",
  NOT_UNIQUE_LIVE: "NOT_UNIQUE_LIVE",
  STILL_BUILDING: "STILL_BUILDING",
});

/**
 * @param {Object} [opts]
 * @param {Array}  [opts.declared]  injectable declared-index set — the seam the
 *   tests use to hand the audit a schema whose unique flag is missing. Without
 *   it the UNBACKED branch is reachable only by breaking a real model, so a
 *   mutation disabling that branch survives on code nothing exercises. Phase W
 *   learned this (W-M15) and Phase Y's own mutation Y-M10 repeated it.
 */
function runIndexContract({ live = null, modelsDir, servicesDir, checklist, declared: injected } = {}) {
  const declared = injected || declaredIndexes({ modelsDir });
  const documented = documentedIndexes({ checklist });
  const dependencies = CONSTRAINT_DEPENDENCIES.map((d) => verifyDependency(d, { servicesDir }));
  const findings = [];

  // --- Y.1 the checklist covers what the schemas declare ---------------------
  if (documented === null) {
    findings.push({
      outcome: OUTCOME.UNDOCUMENTED,
      detail: "INDEX_VERIFICATION.md not found — there is no checklist to follow",
    });
  } else {
    for (const index of declared) {
      if (!documentsIndex(documented, index)) {
        findings.push({
          outcome: OUTCOME.UNDOCUMENTED,
          collection: index.collection,
          name: index.name,
          unique: index.unique,
          detail: `${index.collection}.${index.name}${index.unique ? " (UNIQUE)" : ""} is declared by ${index.source} but absent from the checklist`,
        });
      }
    }
    // ...and does not send an operator looking for indexes nothing declares.
    for (const row of documented) {
      for (const name of row.names) {
        const matches = declared.some((d) => d.collection === row.collection && d.name === name);
        const aliased = declared.some((d) => d.collection === row.collection && row.names.includes(d.name));
        if (!matches && !aliased) {
          findings.push({
            outcome: OUTCOME.DOCUMENTED_BUT_UNDECLARED,
            collection: row.collection,
            name,
            detail: `the checklist asks for ${row.collection}.${name}, which no model declares`,
          });
        }
      }
    }
  }

  // --- Y.2 every dependency has a unique declaration behind it ---------------
  for (const dep of dependencies) {
    const match = declared.find(
      (d) => d.model === dep.model && sameSpec(d.spec, dep.spec)
    );
    if (!match || !match.unique) {
      findings.push({
        outcome: OUTCOME.UNBACKED,
        collection: collectionNameFor(dep.model),
        name: indexNameFor(dep.spec),
        detail:
          `${dep.file} treats a duplicate-key error as "already done", but ` +
          (match
            ? `${dep.model}'s matching index is not declared unique`
            : `${dep.model} declares no index on ${JSON.stringify(dep.spec)}`),
        why: dep.why,
      });
    }
  }

  // --- Y.3 the cluster actually has them -------------------------------------
  const liveResult = live || { status: "NOT MEASURED", reason: "no live read was attempted", collections: {} };
  if (liveResult.status === "MEASURED") {
    for (const index of declared) {
      const actual = (liveResult.collections[index.collection] || []).find(
        (i) => i.name === index.name || sameSpec(i.key, index.spec)
      );
      if (!actual) {
        findings.push({
          outcome: OUTCOME.MISSING_LIVE,
          collection: index.collection,
          name: index.name,
          detail: `declared but absent on the cluster`,
        });
        continue;
      }
      if (index.unique && !actual.unique) {
        findings.push({
          outcome: OUTCOME.NOT_UNIQUE_LIVE,
          collection: index.collection,
          name: index.name,
          detail: "exists on the cluster WITHOUT the unique flag — it speeds up reads and guarantees nothing",
        });
      }
      // A partially built index is not yet enforcing anything.
      if (actual.building) {
        findings.push({
          outcome: OUTCOME.STILL_BUILDING,
          collection: index.collection,
          name: index.name,
          detail: "index build is still in progress",
        });
      }
    }
  }

  const uniqueDeclared = declared.filter((d) => d.unique);
  return {
    status: findings.length === 0 ? "CONSISTENT" : "INCONSISTENT",
    declared,
    documented,
    dependencies,
    findings,
    live: { status: liveResult.status, reason: liveResult.reason },
    counts: {
      declared: declared.length,
      declaredUnique: uniqueDeclared.length,
      documented: documented ? documented.length : 0,
      dependencies: dependencies.length,
      collections: [...new Set(declared.map((d) => d.collection))].length,
    },
  };
}

/** Order-insensitive comparison of two index key specs. */
function sameSpec(a = {}, b = {}) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => kb[i] === k && Number(a[k]) === Number(b[k]));
}

/**
 * The checklist rows the current schemas imply — the generator behind the
 * executable contract. `INDEX_VERIFICATION.md` is written from this, so the
 * document cannot drift from the code without Y.1 failing.
 */
function checklistRows() {
  return declaredIndexes()
    .map((d) => ({
      collection: d.collection,
      name: d.name,
      unique: d.unique,
      model: d.model,
      kind: d.kind,
    }))
    .sort((a, b) => a.collection.localeCompare(b.collection) || a.name.localeCompare(b.name));
}

module.exports = {
  runIndexContract,
  declaredIndexes,
  documentedIndexes,
  documentsIndex,
  liveIndexes,
  checklistRows,
  collectionNameFor,
  indexNameFor,
  sameSpec,
  verifyDependency,
  CONSTRAINT_DEPENDENCIES,
  DUPLICATE_KEY_PATTERN,
  OUTCOME,
};
