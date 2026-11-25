/**
 * An in-memory stand-in for the Mongoose User model.
 *
 * It supports exactly the query operators policyImpactAgent emits ($gt, $gte,
 * $lt, $lte, $in, $or) and nothing else — an unsupported operator throws rather
 * than silently returning the wrong candidate set, which would turn a soundness
 * bug into a passing test.
 */
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matchesClause(doc, path, clause) {
  if (path === "$or") return clause.some((sub) => matchesFilter(doc, sub));
  if (path === "$and") return clause.every((sub) => matchesFilter(doc, sub));
  const v = getPath(doc, path);
  if (clause === null) return v === null || v === undefined;
  if (typeof clause !== "object" || Array.isArray(clause)) return v === clause;

  for (const [op, operand] of Object.entries(clause)) {
    switch (op) {
      case "$gt":
        if (!(typeof v === "number" && v > operand)) return false;
        break;
      case "$gte":
        if (!(typeof v === "number" && v >= operand)) return false;
        break;
      case "$lt":
        if (!(typeof v === "number" && v < operand)) return false;
        break;
      case "$lte":
        if (!(typeof v === "number" && v <= operand)) return false;
        break;
      case "$in":
        if (!operand.includes(v)) return false;
        break;
      default:
        throw new Error(`fakeUserModel: unsupported query operator "${op}"`);
    }
  }
  return true;
}

function matchesFilter(doc, filter) {
  return Object.entries(filter || {}).every(([k, c]) => matchesClause(doc, k, c));
}

/**
 * @param {Array} users
 * @param {Object} [spy] optional {} that records `spy.queried` / `spy.counted`
 */
function fakeUserModel(users, spy = {}) {
  return {
    find(filter) {
      spy.queried = true;
      spy.lastFilter = filter;
      const rows = users.filter((u) => matchesFilter(u, filter || {}));
      return {
        batchSize() {
          return this;
        },
        cursor() {
          let i = 0;
          return { next: async () => (i < rows.length ? rows[i++] : null) };
        },
      };
    },
    async countDocuments() {
      spy.counted = true;
      return users.length;
    },
    findById(id) {
      // NOT async: Mongoose returns a Query you can chain .lean() onto. An
      // async function here would return a Promise, which has no .lean().
      const u = users.find((x) => String(x._id) === String(id)) || null;
      return {
        lean: async () => u,
        then: (resolve, reject) => Promise.resolve(u).then(resolve, reject),
      };
    },
  };
}

/** Scheme collection stand-in. Supports find({}).lean(). */
function fakeSchemeModel(schemes, spy = {}) {
  return {
    find(filter) {
      spy.queried = true;
      const rows = schemes.filter((s) => matchesFilter(s, filter || {}));
      return {
        lean: async () => rows,
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      };
    },
  };
}

/**
 * RecommendationHistory stand-in that ENFORCES the unique index on
 * (userId, schemeId, triggeringChangeId).
 *
 * The index is the thing that actually makes propagation idempotent, so a fake
 * that ignores it would let a duplicate-writing bug pass the test suite. It
 * throws the same E11000 shape Mongo does.
 *
 * `failNextCreates` makes the store reject the next N create() calls, so the
 * caller's retry and error-reporting paths can be exercised.
 */
function fakeHistoryModel(opts = {}) {
  const rows = [];
  const state = { failNextCreates: opts.failNextCreates || 0, failFinds: !!opts.failFinds };
  const key = (d) => `${d.userId}|${d.schemeId}|${d.triggeringChangeId}`;

  return {
    rows,
    state,
    async findOne(filter) {
      if (state.failFinds) throw new Error("simulated find failure");
      return rows.find((r) => matchesFilter(r, filter)) || null;
    },
    async create(doc) {
      if (state.failNextCreates > 0) {
        state.failNextCreates--;
        throw new Error("simulated write failure");
      }
      if (rows.some((r) => key(r) === key(doc))) {
        const err = new Error(
          `E11000 duplicate key error collection: recommendationhistories index: uniq_user_scheme_change dup key: { userId: "${doc.userId}" }`
        );
        err.code = 11000;
        throw err;
      }
      rows.push({ ...doc });
      return doc;
    },
    async countDocuments(filter) {
      return rows.filter((r) => matchesFilter(r, filter || {})).length;
    },
  };
}

/** A minimal active scheme with the given rules. */
const mkScheme = (schemeId, rules, extras = {}) => ({
  schemeId,
  name: extras.name || schemeId,
  description: extras.description || "",
  eligibility: extras.eligibility || "",
  benefits: extras.benefits || "",
  documents: extras.documents || [],
  tags: extras.tags || [],
  status: extras.status || "active",
  version: extras.version ?? 1,
  eligibilityRules: rules,
  ...extras,
});

const mkUser = (i, profile) => ({
  _id: `u${i}`,
  email: `u${i}@example.com`,
  profile: { categories: [], documentsAvailable: [], ...profile },
});

const baseRules = () => ({
  minAge: null,
  maxAge: null,
  minAnnualIncome: null,
  maxAnnualIncome: null,
  minMarksPercentage: null,
  minEducationLevel: null,
  genders: [],
  categories: [],
  categoryGroups: [],
  occupations: [],
  states: [],
  eligibilityType: "constrained",
});

module.exports = {
  fakeUserModel,
  fakeSchemeModel,
  fakeHistoryModel,
  mkUser,
  mkScheme,
  baseRules,
  matchesFilter,
};
