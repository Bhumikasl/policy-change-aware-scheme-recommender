/**
 * An in-memory stand-in for the Mongoose model layer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * The Phase J integration test has to prove that the NORMAL collection cycle
 * triggers the policy agents. Proving that with mocked agents would prove
 * nothing — a mock that records "I was called" cannot show that real diffs
 * produce real history rows.
 *
 * So this fakes exactly ONE layer: the database. Everything above it runs for
 * real — services/pipeline.js, the normalizer, comparator.reconcile() with its
 * genuine SHA-256 hashing and field diffing, policyPipeline, both agents, the
 * matcher, the relevance ranker and recommendationPropagation. The service
 * boundaries under test are the real ones.
 *
 * It is not Mongo. It implements the operators and chain methods this codebase
 * actually uses and throws on anything else, so an unsupported query fails
 * loudly instead of quietly returning the wrong rows and turning a real bug
 * into a passing test.
 *
 * The unique index on RecommendationHistory is enforced here, with the same
 * E11000 shape Mongo produces, because that index is the mechanism the
 * idempotency guarantee rests on.
 */

// ---------------------------------------------------------------------------
// Query evaluation
// ---------------------------------------------------------------------------
function getPath(obj, path) {
  return String(path)
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matchesClause(doc, path, clause) {
  if (path === "$or") return clause.some((sub) => matchesFilter(doc, sub));
  if (path === "$and") return clause.every((sub) => matchesFilter(doc, sub));

  const v = getPath(doc, path);
  if (clause === null) return v === null || v === undefined;
  if (clause instanceof Date) return String(v) === String(clause);
  if (typeof clause !== "object" || Array.isArray(clause)) return v === clause;

  // Mongo orders Dates as well as numbers. A comparison that only handled
  // numbers silently matched nothing for a Date field, which made a retry
  // sweep keyed on `nextAttemptAt` look correct while selecting no rows.
  const ordinal = (x) =>
    x instanceof Date ? x.getTime() : typeof x === "number" ? x : null;

  for (const [op, operand] of Object.entries(clause)) {
    const a = ordinal(v);
    const b = ordinal(operand);
    const comparable = a !== null && b !== null;
    switch (op) {
      case "$gt": if (!(comparable && a > b)) return false; break;
      case "$gte": if (!(comparable && a >= b)) return false; break;
      case "$lt": if (!(comparable && a < b)) return false; break;
      case "$lte": if (!(comparable && a <= b)) return false; break;
      case "$in": if (!operand.includes(v)) return false; break;
      case "$nin": if (operand.includes(v)) return false; break;
      case "$ne": if (v === operand) return false; break;
      case "$exists": if ((v !== undefined) !== operand) return false; break;
      default:
        // Loud, not silent: a query this cannot evaluate must not be allowed
        // to return a plausible-looking wrong answer.
        throw new Error(`inMemoryDb: unsupported query operator "${op}" on "${path}"`);
    }
  }
  return true;
}

function matchesFilter(doc, filter) {
  return Object.entries(filter || {}).every(([k, c]) => matchesClause(doc, k, c));
}

function applyUpdate(doc, update) {
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, v);
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) setPath(doc, k, (getPath(doc, k) || 0) + v);
  if (!update.$set && !update.$inc) Object.assign(doc, update);
  return doc;
}

function setPath(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

let idCounter = 0;
const nextId = () => `oid-${++idCounter}`;

/**
 * A thenable query object, so both `await Model.find(q)` and
 * `await Model.find(q).lean()` work the way Mongoose allows.
 */
function makeQuery(getRows) {
  const q = {
    _limit: null,
    _skip: 0,
    _sort: null,
    // sort/skip/limit are implemented for real, not stubbed. A no-op skip()
    // makes every pagination test pass whether or not pagination works, which
    // is worse than having no test: it reports a guarantee that is absent.
    sort(spec) { this._sort = spec; return this; },
    limit(n) { this._limit = n; return this; },
    skip(n) { this._skip = n || 0; return this; },
    select() { return this; },
    lean() { return Promise.resolve(this._rows()); },
    batchSize() { return this; },
    cursor() {
      const rows = this._rows();
      let i = 0;
      return { next: async () => (i < rows.length ? rows[i++] : null) };
    },
    _rows() {
      let rows = getRows();
      if (this._sort) {
        const entries = Object.entries(this._sort);
        rows = [...rows].sort((a, b) => {
          for (const [field, dir] of entries) {
            const av = getPath(a, field);
            const bv = getPath(b, field);
            if (av === bv) continue;
            // undefined sorts last regardless of direction, as Mongo does for
            // missing fields in a descending sort.
            if (av === undefined) return 1;
            if (bv === undefined) return -1;
            const cmp = av < bv ? -1 : 1;
            return dir < 0 ? -cmp : cmp;
          }
          return 0;
        });
      }
      if (this._skip) rows = rows.slice(this._skip);
      if (this._limit != null) rows = rows.slice(0, this._limit);
      return rows;
    },
    then(resolve, reject) {
      return Promise.resolve(this._rows()).then(resolve, reject);
    },
  };
  return q;
}

/**
 * @param {Object} opts
 * @param {boolean} [opts.trackDoc]  give documents .save()/.toObject(), as the
 *                                   comparator relies on for Scheme
 * @param {Array<string[]>} [opts.uniqueKeys]  enforced unique indexes
 */
function makeCollection(name, opts = {}) {
  const rows = [];
  const spy = { finds: 0, creates: 0, updates: 0, lastFilter: null };
  const state = { failCreate: 0, failFind: false, failUpdate: false, failUpdateMany: false };

  const decorate = (row) => {
    if (!opts.trackDoc) return row;
    Object.defineProperty(row, "save", {
      value: async function save() {
        // The object IS the stored row, so mutations are already persisted.
        return this;
      },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(row, "toObject", {
      value: function toObject() {
        const out = {};
        for (const k of Object.keys(this)) out[k] = this[k];
        return out;
      },
      enumerable: false,
      configurable: true,
    });
    return row;
  };

  const keyOf = (doc, fields) => fields.map((f) => String(getPath(doc, f))).join("|");

  const model = {
    modelName: name,
    rows,
    spy,
    state,

    find(filter = {}) {
      spy.finds++;
      spy.lastFilter = filter;
      if (state.failFind) throw new Error(`simulated ${name}.find failure`);
      return makeQuery(() => rows.filter((r) => matchesFilter(r, filter)));
    },

    findOne(filter = {}) {
      spy.finds++;
      spy.lastFilter = filter;
      if (state.failFind) throw new Error(`simulated ${name}.findOne failure`);
      const hit = rows.find((r) => matchesFilter(r, filter)) || null;
      return {
        select() { return this; },
        lean: async () => hit,
        then: (resolve, reject) => Promise.resolve(hit).then(resolve, reject),
      };
    },

    findById(id) {
      const hit = rows.find((r) => String(r._id) === String(id)) || null;
      return {
        lean: async () => hit,
        then: (resolve, reject) => Promise.resolve(hit).then(resolve, reject),
      };
    },

    async create(doc) {
      spy.creates++;
      if (state.failCreate > 0) {
        state.failCreate--;
        throw new Error(`simulated ${name}.create failure`);
      }
      for (const fields of opts.uniqueKeys || []) {
        if (rows.some((r) => keyOf(r, fields) === keyOf(doc, fields))) {
          const err = new Error(
            `E11000 duplicate key error collection: ${name} index: ${fields.join("_")} dup key`
          );
          err.code = 11000;
          throw err;
        }
      }
      const row = decorate({ _id: doc._id || nextId(), ...clone(doc) });
      rows.push(row);
      return row;
    },

    async updateOne(filter, update) {
      spy.updates++;
      if (state.failUpdate) throw new Error(`simulated ${name}.updateOne failure`);
      const hit = rows.find((r) => matchesFilter(r, filter));
      if (!hit) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(hit, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },

    /**
     * Multi-row update. The RAG indexer's invalidation step is a single
     * updateMany over every ACTIVE chunk of the earlier versions, so a stub
     * that touched one row would let a half-superseded index pass the suite —
     * exactly the state that leaves two versions ACTIVE at once.
     */
    async updateMany(filter, update) {
      spy.updates++;
      if (state.failUpdate || state.failUpdateMany) {
        throw new Error(`simulated ${name}.updateMany failure`);
      }
      const hits = rows.filter((r) => matchesFilter(r, filter));
      for (const hit of hits) applyUpdate(hit, update);
      return { matchedCount: hits.length, modifiedCount: hits.length };
    },

    async countDocuments(filter = {}) {
      return rows.filter((r) => matchesFilter(r, filter)).length;
    },

    async deleteMany(filter = {}) {
      const keep = rows.filter((r) => !matchesFilter(r, filter));
      const removed = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { deletedCount: removed };
    },

    /** Test helper: seed rows without going through create(). */
    seed(docs) {
      for (const d of docs) rows.push(decorate({ _id: d._id || nextId(), ...clone(d) }));
      return model;
    },

    reset() {
      rows.length = 0;
      spy.finds = 0;
      spy.creates = 0;
      spy.updates = 0;
      state.failCreate = 0;
      state.failFind = false;
      state.failUpdate = false;
      state.failUpdateMany = false;
    },
  };

  return model;
}

/** The four collections the collection cycle touches. */
function makeDb() {
  return {
    Scheme: makeCollection("schemes", { trackDoc: true }),
    SchemeHistory: makeCollection("schemehistories"),
    User: makeCollection("users"),
    // The unique index that makes propagation idempotent. Enforced here for
    // real, because a fake that ignored it would let a duplicate-writing bug
    // pass the suite.
    RecommendationHistory: makeCollection("recommendationhistories", {
      uniqueKeys: [["userId", "schemeId", "triggeringChangeId"]],
    }),
    // Phase M. Carries the SAME unique index the model declares, so a
    // double-indexing bug surfaces here rather than only against real Mongo.
    //
    // This exists because the integration suite reached the REAL Mongoose
    // SchemeChunk: policyPipeline called indexScheme() without a `deps.model`,
    // so it fell back to the production model, mongoose buffered create() with
    // no connection, and the test timed out — then threw "import after the
    // Jest environment has been torn down" when the buffered call resumed.
    SchemeChunk: (() => {
      const c = makeCollection("schemechunks", { uniqueKeys: [["chunkId"]] });
      // ragIndexer and ragRetriever both destructure CHUNK_STATUS from the
      // model module at load time. Without it here the mocked module yields
      // `undefined` and the first `CHUNK_STATUS.ACTIVE` throws at import —
      // trading one failure for a more confusing one.
      c.CHUNK_STATUS = Object.freeze({ ACTIVE: "ACTIVE", SUPERSEDED: "SUPERSEDED" });
      return c;
    })(),
    // Phase L. The SECOND model that escaped, found by the same reproduction
    // that found SchemeChunk — and masked by it, because the RAG stage buffered
    // first and the test died before ever reaching the notification stage.
    //
    // policyPipeline calls notifyFromTransitions() with no `deps`, so
    // notificationService fell back to the real Mongoose Notification and
    // buffered `findOne`. The individual notification tests below inject their
    // own store; every OTHER cycle in the suite had nothing injected.
    //
    // Same unique index as the model declares — it is the idempotency
    // mechanism, so a fake that ignored it would let a double-send bug pass.
    Notification: makeCollection("notifications", {
      uniqueKeys: [["userId", "schemeId", "triggeringChangeId", "channel"]],
    }),
  };
}

module.exports = { makeDb, makeCollection, matchesFilter, getPath };
