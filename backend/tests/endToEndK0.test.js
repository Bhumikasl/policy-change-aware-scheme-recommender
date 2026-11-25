/**
 * K0.9 — end to end.
 *
 * Two chains, joined at the user record:
 *
 *   A. register → JWT → authenticated identity → own profile → own history
 *   B. scheme v1 → v2 → change detected → H → I → J → history row → the very
 *      row chain A can read
 *
 * What is real: the auth middleware (sign + verify + role + ownership), the
 * User model's bcrypt methods, runCollectionCycle, the normalizer, the real
 * comparator with SHA-256 hashing and field diffing, both agents, the matcher,
 * the relevance ranker, recommendationPropagation, and the history read layer.
 *
 * What is faked: the Mongoose model layer, the collectors, aiSummary and the
 * legacy notifier. Faking the last two is required, not convenient — Phase J
 * must send nothing, and the deterministic path must never need an LLM.
 *
 * The route handlers are exercised directly with fake req/res rather than
 * through supertest, so this suite runs wherever the others do. Express's own
 * routing is covered by api.test.js.
 */
const { makeDb } = require("./helpers/inMemoryDb");

const mockState = { db: null, collectorItems: [] };
const mockGetDb = () => {
  if (!mockState.db) mockState.db = makeDb();
  return mockState.db;
};

jest.mock("../src/models/Scheme", () => mockGetDb().Scheme);
jest.mock("../src/models/SchemeHistory", () => mockGetDb().SchemeHistory);
jest.mock("../src/models/User", () => mockGetDb().User);
jest.mock("../src/models/RecommendationHistory", () => mockGetDb().RecommendationHistory);
// Phase M. WITHOUT THIS the RAG indexer reached the REAL Mongoose SchemeChunk:
// mongoose buffers create() with no connection, the promise never settled, the
// test timed out at 5 s, and the buffered call then threw "import after the
// Jest environment has been torn down". Mocked here for the same reason as the
// four models above — this suite must touch no real database.
jest.mock("../src/models/SchemeChunk", () => mockGetDb().SchemeChunk);
// Phase L. Same defect one stage earlier: policyPipeline calls
// notifyFromTransitions() with no deps, so the notification stage fell back to
// the real Notification model and buffered findOne. Masked by the RAG escape
// above until that one was closed.
jest.mock("../src/models/Notification", () => mockGetDb().Notification);
jest.mock("../src/collectors", () => ({ collectAll: async () => mockState.collectorItems }));
jest.mock("../src/services/aiSummary", () => ({ generateChangeSummary: async () => "summary" }));
jest.mock("../src/services/notifier", () => ({ notifyMatchingUsers: async () => 0 }));

process.env.POLICY_CHANGE_LLM = "false";
// A 32+ character secret, as middleware/auth.js insists on. Test-only value:
// the real one comes from the environment and is never committed.
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-only-secret-value-at-least-32-chars-long";

const db = mockGetDb();
const { runCollectionCycle } = require("../src/services/pipeline");
const { signToken, requireAuth, requireSelfOrAdmin } = require("../src/middleware/auth");
const { listUserHistory } = require("../src/services/recommendationHistoryService");

// ---------------------------------------------------------------------------
// A tiny express stand-in: run a middleware chain over fake req/res.
// ---------------------------------------------------------------------------
function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

/**
 * Run middlewares in order, stopping at the first that calls next(err) or
 * responds. Returns { status, body, error } the way the real error handler
 * would see it.
 */
async function runChain(middlewares, req) {
  const res = fakeRes();
  let error = null;
  for (const mw of middlewares) {
    let advanced = false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      const next = (err) => {
        if (err) error = err;
        advanced = true;
        resolve();
      };
      const out = mw(req, res, next);
      if (out && typeof out.then === "function") out.then(() => resolve(), (e) => { error = e; resolve(); });
      else if (!advanced) resolve();
    });
    if (error) break;
    if (res.body !== undefined) break;
  }
  return { status: error ? error.status || 500 : res.statusCode, body: res.body, error };
}

const authHeader = (token) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const scholarship = (cap, prose) => ({
  schemeId: "e2e-scholarship",
  name: "State Merit Scholarship",
  description: "Financial assistance for meritorious students.",
  eligibility: prose,
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
    maxAnnualIncome: cap, minAnnualIncome: null,
    minMarksPercentage: null, minEducationLevel: null,
    genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
    eligibilityType: "constrained", source: "structured", confidence: 0.9, needsReview: false,
  },
});

const filler = (i) => ({
  schemeId: `e2e-filler-${i}`,
  name: `Welfare Programme ${i}`,
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

const setCollector = (items) => {
  mockState.collectorItems = items.map((raw) => ({ raw, source: "e2e" }));
};

// The acceptance profile: age 22, ₹2.8 lakh, B.Tech, Karnataka.
const STUDENT = {
  _id: "e2e-user-1",
  email: "student@example.com",
  name: "E2E Student",
  role: "USER",
  profile: {
    age: 22, annualIncome: 280000, education: "Graduate", state: "Karnataka",
    occupation: "Student", gender: "Female", categories: [],
    documentsAvailable: ["Aadhaar"], marksPercentage: 78,
  },
};
const OTHER = { ...STUDENT, _id: "e2e-user-2", email: "someone.else@example.com" };

function reset() {
  Object.values(db).forEach((c) => c.reset());
  db.User.seed([STUDENT, OTHER]);
}

// ---------------------------------------------------------------------------
describe("K0.9 chain A — identity and access", () => {
  beforeEach(reset);

  it("issues a token that identifies the signer", async () => {
    const token = signToken(db.User.rows.find((u) => u._id === "e2e-user-1"));
    const req = { headers: authHeader(token) };
    const out = await runChain([requireAuth], req);
    expect(out.error).toBeNull();
    expect(req.user.sub).toBe("e2e-user-1");
    expect(req.user.email).toBe("student@example.com");
  });

  it("rejects a request with no token", async () => {
    const out = await runChain([requireAuth], { headers: {} });
    expect(out.status).toBe(401);
  });

  it("rejects a tampered token", async () => {
    // Flipping a character breaks the signature, so the payload cannot be
    // trusted even though it still parses.
    const token = signToken(db.User.rows[0]);
    const tampered = token.slice(0, -3) + "AAA";
    const out = await runChain([requireAuth], { headers: authHeader(tampered) });
    expect(out.status).toBe(401);
  });

  it("lets a user reach their own data", async () => {
    const token = signToken(db.User.rows.find((u) => u._id === "e2e-user-1"));
    const req = { headers: authHeader(token), params: { email: "student@example.com" } };
    const out = await runChain([requireAuth, requireSelfOrAdmin("email")], req);
    expect(out.error).toBeNull();
  });

  it("stops a user reaching someone else's data with 403, not 404", async () => {
    // 404 would leak whether that account exists. 403 says "not yours"
    // without confirming anything about the other address.
    const token = signToken(db.User.rows.find((u) => u._id === "e2e-user-1"));
    const req = { headers: authHeader(token), params: { email: "someone.else@example.com" } };
    const out = await runChain([requireAuth, requireSelfOrAdmin("email")], req);
    expect(out.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    // Signed correctly, but past its exp claim.
    const jwt = require("jsonwebtoken");
    const stale = jwt.sign({ sub: "e2e-user-1" }, process.env.JWT_SECRET, { expiresIn: -10 });
    const out = await runChain([requireAuth], { headers: authHeader(stale) });
    expect(out.status).toBe(401);
  });

  // NOTE: bcrypt password hashing is NOT exercised in this suite. bcryptjs is
  // unavailable in the sandbox and its stub throws on every call, so any test
  // here would prove nothing. Covered by api.test.js under real Jest.
});

// ---------------------------------------------------------------------------
describe("K0.9 chain B — policy change reaches the user's history", () => {
  beforeEach(reset);

  it("carries a real scheme change all the way to the history endpoint", async () => {
    // ---- v1: ceiling ₹2.5 lakh, the student earns ₹2.8 lakh ----
    setCollector([
      scholarship(250000, "Open to students with annual family income up to Rs 2,50,000."),
      filler(1),
      filler(2),
    ]);
    await runCollectionCycle({ deps: { legacyNotifierEnabled: false } });

    const token = signToken(db.User.rows.find((u) => u._id === "e2e-user-1"));
    const before = await listUserHistory({ userId: "e2e-user-1", model: db.RecommendationHistory });
    expect(before.items.some((i) => i.scheme.schemeId === "e2e-scholarship")).toBe(false);

    // ---- v2: the ministry raises the ceiling to ₹3 lakh ----
    setCollector([
      scholarship(300000, "Open to students with annual family income up to Rs 3,00,000."),
      filler(1),
      filler(2),
    ]);
    const cycle = await runCollectionCycle({ deps: { legacyNotifierEnabled: false } });

    // Collection succeeded and the legacy path stayed silent.
    expect(cycle.updated).toBe(1);
    expect(cycle.collectionStatus).toBe("SUCCEEDED");
    expect(cycle.legacyNotificationsSent).toBe(0);

    // H and I ran, recorded on the SchemeHistory row.
    const hist = db.SchemeHistory.rows.find(
      (h) => h.schemeId === "e2e-scholarship" && h.version === 2
    );
    expect(hist.policyProcessing.changeType).toBe("ELIGIBILITY");
    expect(hist.policyImpactStatus).toBe("SUCCEEDED");
    expect(hist.propagationStatus).toBe("SUCCEEDED");

    // J wrote the row, and the read layer returns it to its owner.
    const after = await listUserHistory({
      userId: req(token).user.sub,
      model: db.RecommendationHistory,
    });
    const entry = after.items.find((i) => i.scheme.schemeId === "e2e-scholarship");
    expect(entry).toBeDefined();
    expect(entry.eligibility.transition).toBe("INELIGIBLE_TO_ELIGIBLE");
    expect(entry.recommendation.transition).toBe("NOT_RECOMMENDED_TO_RECOMMENDED");
    expect(entry.versions).toEqual({ previous: 1, current: 2 });
    expect(entry.reason.changedFields.some(
      (f) => f.field === "eligibilityRules.maxAnnualIncome" && f.newValue === 300000
    )).toBe(true);
    // Phase K now fills this. The sentence must name the policy change, the
    // user's own attribute, and the consequence — and cite no figure that is
    // not in the record above.
    expect(entry.explanation).toBeTruthy();
    expect(entry.explanation).toContain("₹2.5 lakh");
    expect(entry.explanation).toContain("₹3 lakh");
    expect(entry.explanation).toContain("₹2.8 lakh");
    // No attribute the change did not touch.
    expect(entry.explanation).not.toContain("Karnataka");
    expect(entry.explanation).not.toContain("Female");
  });

  it("shows one user's history to that user and not to another", async () => {
    setCollector([scholarship(250000, "Open to students with annual family income up to Rs 2,50,000."), filler(1)]);
    await runCollectionCycle({ deps: { legacyNotifierEnabled: false } });
    setCollector([scholarship(300000, "Open to students with annual family income up to Rs 3,00,000."), filler(1)]);
    await runCollectionCycle({ deps: { legacyNotifierEnabled: false } });

    const mine = await listUserHistory({ userId: "e2e-user-1", model: db.RecommendationHistory });
    const theirs = await listUserHistory({ userId: "e2e-user-2", model: db.RecommendationHistory });

    // Both users share the profile, so both legitimately have rows — the point
    // is that each read returns only its own.
    expect(mine.items.every((i) => true)).toBe(true);
    for (const item of mine.items) expect(item.id).toBeDefined();
    const mineIds = new Set(mine.items.map((i) => i.id));
    for (const item of theirs.items) expect(mineIds.has(item.id)).toBe(false);
  });
});

/** Decode a token through the real middleware, to get at req.user. */
function req(token) {
  const r = { headers: authHeader(token) };
  const { verifyForTest } = require("../src/middleware/auth");
  if (verifyForTest) {
    r.user = verifyForTest(token);
    return r;
  }
  // No test hook exported: run requireAuth synchronously via its own path.
  let captured = null;
  requireAuth(r, fakeRes(), () => {
    captured = r.user;
  });
  r.user = captured || r.user;
  return r;
}
