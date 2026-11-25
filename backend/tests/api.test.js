/**
 * API tests via supertest. Mongoose models are mocked so we don't need a
 * live database — we just want to exercise the route wiring, filters, and
 * matcher integration.
 */
jest.mock("../src/models/User");
jest.mock("../src/models/Scheme");
jest.mock("../src/models/SchemeHistory", () => ({ find: jest.fn(), create: jest.fn() }));

const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Scheme = require("../src/models/Scheme");
const { signToken, ROLES } = require("../src/middleware/auth");

/**
 * These routes became authenticated in K0.
 *
 * Before K0 they were public, and guessing an email returned that person's
 * income, age, education and caste categories — an IDOR over data that is
 * sensitive under India's DPDP Act. The tests below were written against that
 * pre-K0 API and are updated here to the secure contract.
 *
 * They send a real signed token for the account they are asking about. The
 * ownership gate compares `req.user.email` with `req.params.email`, so the
 * token must match the URL. Nothing about the production guard was relaxed to
 * make these pass.
 */
const authFor = (email, role = ROLES.USER) =>
  `Bearer ${signToken({ _id: "test-user-id", email, role })}`;
const asUser = (req, email) => req.set("Authorization", authFor(email));

function chainFind(returnValue) {
  const chain = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue(returnValue) };
  Scheme.find.mockReturnValueOnce(chain);
  return chain;
}
function chainFindNoLimit(returnValue) {
  const chain = { sort: jest.fn().mockResolvedValue(returnValue) };
  Scheme.find.mockReturnValueOnce(chain);
  return chain;
}
function fakeScheme(overrides = {}) {
  const doc = {
    schemeId: "s1", name: "Test Scheme", status: "Active", documents: [],
    eligibilityRules: {
      minAge: 18, maxAge: 40, genders: ["Female"],
      categories: [], occupations: [], states: [],
      minAnnualIncome: null, maxAnnualIncome: null,
      minMarksPercentage: null, minEducationLevel: null,
      source: "structured", eligibilityType: "constrained",
      confidence: 0.7, needsReview: false,
    },
    ...overrides,
  };
  doc.toObject = () => ({ ...doc });
  return doc;
}

beforeEach(() => {
  Scheme.find.mockReset();
  Scheme.findOne = jest.fn();
  Scheme.countDocuments = jest.fn().mockResolvedValue(0);
  Scheme.distinct = jest.fn().mockResolvedValue([]);
  User.findOne = jest.fn();
  User.findOneAndUpdate = jest.fn();
});

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("POST /api/users — REMOVED in K0 (intentional contract change)", () => {
  /**
   * This route was an anonymous upsert-by-email: anyone could overwrite anyone
   * else's profile and get the saved document echoed back. K0 replaced it with
   * `POST /api/auth/register` (account creation) and `PUT /api/users/me`
   * (authenticated self-update).
   *
   * The old tests are not deleted — they are re-pointed at the replacement, so
   * the coverage survives and the removal stays deliberate rather than
   * accidental.
   */
  test("the anonymous upsert route no longer exists", async () => {
    const res = await request(app).post("/api/users").send({ email: "a@x.com" });
    expect(res.status).toBe(404);
  });

  test("its replacement, PUT /api/users/me, rejects an unauthenticated caller", async () => {
    const res = await request(app).put("/api/users/me").send({ profile: {} });
    expect(res.status).toBe(401);
  });

  test("an anonymous caller cannot overwrite someone else's profile", async () => {
    // The property the removal exists to guarantee.
    const res = await request(app).put("/api/users/me").send({ email: "victim@x.com", profile: { annualIncome: 1 } });
    expect(res.status).toBe(401);
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("authentication is enforced on personal data", () => {
  /**
   * NOTE ON THE BUG THIS TEST USED TO HAVE.
   *
   * It was written as `asUser(request(app).get(...), "a@x.com")` — which SETS a
   * valid self-signed bearer token. So the test called "no token" was sending
   * one. `requireAuth` passed, `requireSelfOrAdmin` passed (caller == target),
   * the handler ran, the mocked `User.findOne` resolved `undefined`, and the
   * route correctly returned 404 "User not found".
   *
   * The 404 was therefore never a routing fault: the route exists, is mounted
   * at `/api` + `/users/:email/matches`, and its middleware chain runs. The
   * assertion was measuring the handler's not-found path while claiming to
   * measure the auth gate.
   *
   * Sending no header at all is what the test name always meant. The three
   * assertions below make the difference observable, so this cannot silently
   * regress into "some 401 from somewhere" again.
   */
  test("no token -> 401", async () => {
    const res = await request(app).get("/api/users/a@x.com/matches?verify=false");

    expect(res.status).toBe(401);
    // It is `requireAuth` that rejected — not a catch-all, and not the handler.
    expect(res.body.error).toMatch(/bearer token/i);
    // And the request never reached the handler, so nothing was read from the
    // database on behalf of an unauthenticated caller.
    expect(User.findOne).not.toHaveBeenCalled();
  });

  /**
   * The 401 above must come from the ROUTE's auth middleware, not from a
   * blanket "deny everything" fallback. A blanket rule would return 401 for a
   * path that does not exist either; a real route returns 404 there.
   *
   * Asserting both halves is what distinguishes "authentication executes on the
   * intended route" from "something returns 401".
   */
  test("the 401 comes from the route's own guard, not a catch-all", async () => {
    const real = await request(app).get("/api/users/a@x.com/matches?verify=false");
    const bogus = await request(app).get("/api/users/a@x.com/not-a-real-endpoint");

    expect(real.status).toBe(401);
    expect(bogus.status).toBe(404);
  });

  /**
   * Ownership is decided by the TOKEN, never by the URL. `victim@x.com` in the
   * path is the target, not the credential — the gate compares it against the
   * verified claims. This is the IDOR that K0 removed, asserted directly.
   */
  test("the email path parameter is not itself authorization", async () => {
    // A token whose claims say attacker, asking for victim's data.
    const res = await request(app)
      .get("/api/users/victim@x.com/matches?verify=false")
      .set("Authorization", authFor("attacker@x.com"));

    expect(res.status).toBe(403);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  /** A token signed with the wrong key is not a token. */
  test("a tampered token -> 401", async () => {
    const jwt = require("jsonwebtoken");
    const forged = jwt.sign(
      { sub: "test-user-id", email: "a@x.com", role: ROLES.USER },
      "not-the-real-signing-secret-but-long-enough-000000"
    );
    const res = await request(app)
      .get("/api/users/a@x.com/matches?verify=false")
      .set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  /** Self with a valid token is allowed through to the handler. */
  test("valid token for own data -> reaches the handler", async () => {
    User.findOne.mockResolvedValueOnce(null);
    const res = await asUser(request(app).get("/api/users/a@x.com/matches?verify=false"), "a@x.com");

    // 404 here is the HANDLER's answer for an unknown user — which proves the
    // guards let the request through rather than blocking it.
    expect(res.status).toBe(404);
    expect(User.findOne).toHaveBeenCalled();
  });

  test("invalid token -> 401", async () => {
    const res = await request(app)
      .get("/api/users/a@x.com/matches?verify=false")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  test("valid token for a DIFFERENT user -> 403, not 404", async () => {
    // 403 because the caller is authenticated but not entitled. A 404 would
    // leak whether the target account exists.
    const res = await asUser(
      asUser(request(app).get("/api/users/victim@x.com/matches?verify=false"), "victim@x.com"),
      "attacker@x.com"
    );
    expect(res.status).toBe(403);
  });

  test("an ADMIN may read another user's data", async () => {
    User.findOne.mockResolvedValueOnce(null);
    const res = await request(app)
      .get("/api/users/someone@x.com/matches?verify=false")
      .set("Authorization", authFor("admin@x.com", ROLES.ADMIN));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe("GET /api/users/:email/matches", () => {
  test("404 when user missing", async () => {
    User.findOne.mockResolvedValueOnce(null);
    const res = await asUser(request(app).get("/api/users/none@x.com/matches?verify=false"), "none@x.com");
    expect(res.status).toBe(404);
  });
  test("returns eligible schemes with matchExplanation", async () => {
    User.findOne.mockResolvedValueOnce({ email: "a@x.com", profile: { age: 25, gender: "Female" } });
    chainFindNoLimit([fakeScheme(), fakeScheme({ schemeId: "s2", eligibilityRules: { ...fakeScheme().eligibilityRules, genders: ["Male"] } })]);
    // ?verify=false so the test never touches the verifier module's LLM path.
    const res = await asUser(request(app).get("/api/users/a@x.com/matches?verify=false"), "a@x.com");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].schemeId).toBe("s1");
    expect(res.body[0].matchExplanation.eligibilityType).toBe("constrained");
    expect(res.body[0].matchExplanation.stage).toBe("rules-only");
    expect(res.body[0].matchExplanation.recommend).toBe(true);
  });
  test("universal scheme surfaces for sparse-profile users", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: {} });
    chainFindNoLimit([fakeScheme({
      schemeId: "u1",
      eligibilityRules: {
        minAge: null, maxAge: null, genders: [], categories: [], occupations: [], states: [],
        minAnnualIncome: null, maxAnnualIncome: null,
        minMarksPercentage: null, minEducationLevel: null,
        source: "deterministic", eligibilityType: "universal", confidence: 0.6, needsReview: false,
      },
    })]);
    const res = await asUser(request(app).get("/api/users/u@x.com/matches?verify=false"), "u@x.com");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].matchExplanation.eligibilityType).toBe("universal");
  });
  test("unknown schemes excluded by default", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: { age: 25, gender: "Female" } });
    // The route filters at DB level — with the eligibilityType filter, mongoose
    // wouldn't return the unknown one. Simulate that by returning [].
    chainFindNoLimit([]);
    const res = await asUser(request(app).get("/api/users/u@x.com/matches?verify=false"), "u@x.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /api/users/:email/matches — limit & funnel", () => {
  test("limit caps how many are RETURNED (not just verified)", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: { age: 25, gender: "Female" } });
    // 5 eligible schemes, limit=2 → only 2 come back.
    const many = Array.from({ length: 5 }, (_, i) =>
      fakeScheme({ schemeId: `s${i}`, name: `Scheme ${i}` })
    );
    chainFindNoLimit(many);
    const res = await asUser(request(app).get("/api/users/u@x.com/matches?verify=false&limit=2"), "u@x.com");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  test("limit=0 returns the full eligible set", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: { age: 25, gender: "Female" } });
    const many = Array.from({ length: 5 }, (_, i) =>
      fakeScheme({ schemeId: `s${i}`, name: `Scheme ${i}` })
    );
    chainFindNoLimit(many);
    const res = await asUser(request(app).get("/api/users/u@x.com/matches?verify=false&limit=0"), "u@x.com");
    expect(res.body.length).toBe(5);
  });

  test("?meta=true returns the funnel envelope", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: { age: 25, gender: "Female" } });
    chainFindNoLimit([fakeScheme(), fakeScheme({ schemeId: "s2" })]);
    const res = await asUser(request(app).get("/api/users/u@x.com/matches?verify=false&meta=true&limit=1"), "u@x.com");
    expect(res.status).toBe(200);
    expect(res.body.funnel).toEqual(
      expect.objectContaining({
        totalActive: expect.any(Number),
        eligible: expect.any(Number),
        returned: 1,
      })
    );
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  test("results carry a relevance score", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: { age: 25, gender: "Female" } });
    chainFindNoLimit([fakeScheme()]);
    const res = await asUser(request(app).get("/api/users/u@x.com/matches?verify=false"), "u@x.com");
    expect(typeof res.body[0].matchExplanation.relevance).toBe("number");
  });

  test("?explain=true includes the relevance breakdown", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: { age: 25, gender: "Female" } });
    chainFindNoLimit([fakeScheme()]);
    const res = await asUser(request(app).get("/api/users/u@x.com/matches?verify=false&explain=true"), "u@x.com");
    expect(res.body[0].matchExplanation.relevanceBreakdown).toEqual(
      expect.objectContaining({ lexical: expect.any(Number), specificity: expect.any(Number) })
    );
  });
});

describe("GET /api/users/:email/matches/stats", () => {
  test("returns counts by source and eligibilityType", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: {} });
    Scheme.countDocuments.mockResolvedValue(10);
    const res = await asUser(request(app).get("/api/users/u@x.com/matches/stats"), "u@x.com");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("bySource");
    expect(res.body).toHaveProperty("byEligibilityType");
  });
});

describe("GET /api/users/:email/why/:schemeId", () => {
  test("explains verdict", async () => {
    User.findOne.mockResolvedValueOnce({ email: "u@x.com", profile: { age: 25, gender: "Female" } });
    Scheme.findOne.mockResolvedValueOnce(fakeScheme());
    const res = await asUser(request(app).get("/api/users/u@x.com/why/s1"), "u@x.com");
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(res.body.positiveMatches.length).toBeGreaterThan(0);
  });
});

describe("GET /api/schemes", () => {
  test("returns list with default filters", async () => {
    chainFind([fakeScheme()]);
    const res = await request(app).get("/api/schemes");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });
});
