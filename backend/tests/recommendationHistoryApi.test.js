/**
 * K0.4 — the read side of the Phase J audit trail.
 *
 * These test the service layer and the route handler directly, with fake
 * req/res objects, rather than through supertest. That is deliberate: the
 * things worth proving here — that a caller cannot reach another user's rows,
 * that pagination is clamped, that query strings cannot become Mongo operators,
 * that the serialiser is an allow-list — are all properties of this code, not
 * of Express's routing. api.test.js already covers the HTTP layer.
 */
const {
  listUserHistory,
  buildHistoryQuery,
  buildPagination,
  serializeHistoryRow,
  MAX_LIMIT,
  DEFAULT_LIMIT,
} = require("../src/services/recommendationHistoryService");
const { makeCollection } = require("./helpers/inMemoryDb");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const row = (over = {}) => ({
  _id: over._id || "row-1",
  userId: over.userId || "user-1",
  userEmail: over.userEmail || "student@example.com",
  schemeId: over.schemeId || "scheme-a",
  schemeName: "State Merit Scholarship",
  triggeringChangeId: over.triggeringChangeId || "scheme-a:v2",
  processingJobId: "cycle-123",
  eventId: "evt-1",
  previousSchemeVersion: 1,
  newSchemeVersion: 2,
  previousEligibility: false,
  newEligibility: true,
  eligibilityTransition: over.eligibilityTransition || "INELIGIBLE_TO_ELIGIBLE",
  previousRecommendationStatus: "NOT_RECOMMENDED",
  newRecommendationStatus: "RECOMMENDED",
  recommendationTransition: over.recommendationTransition || "NOT_RECOMMENDED_TO_RECOMMENDED",
  previousRank: null,
  newRank: 3,
  previousRelevance: null,
  newRelevance: 7.42,
  topK: 10,
  reason: {
    code: "BECAME_ELIGIBLE",
    summary: "Now eligible: annualIncome",
    changedFields: [
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
    ],
    rulesNowPassing: ["annualIncome"],
    rulesNowFailing: [],
  },
  affectedAttributes: ["income"],
  changeType: "ELIGIBILITY",
  severity: "HIGH",
  explanation: "",
  createdAt: over.createdAt || new Date("2026-03-12T10:00:00Z"),
  ...over,
});

function historyStore(rows) {
  const c = makeCollection("recommendationhistories");
  c.seed(rows);
  return c;
}

// ---------------------------------------------------------------------------
describe("buildHistoryQuery", () => {
  it("always scopes to the caller's own id", () => {
    expect(buildHistoryQuery("user-1", {}).userId).toBe("user-1");
  });

  it("ignores a userId supplied in the query string", () => {
    // The id comes from the verified token. If a query parameter could
    // override it, this endpoint would be the IDOR the /users/:email routes
    // used to be.
    const f = buildHistoryQuery("user-1", { userId: "user-2" });
    expect(f.userId).toBe("user-1");
  });

  it("accepts only known transition values", () => {
    expect(
      buildHistoryQuery("u", { eligibilityTransition: "INELIGIBLE_TO_ELIGIBLE" })
        .eligibilityTransition
    ).toBe("INELIGIBLE_TO_ELIGIBLE");
    // An unrecognised value is dropped, not passed through to Mongo.
    expect(
      buildHistoryQuery("u", { eligibilityTransition: "NONSENSE" }).eligibilityTransition
    ).toBeUndefined();
  });

  describe("NoSQL injection", () => {
    // Express parses ?schemeId[$ne]=x into an OBJECT. Passed to Mongo unchecked
    // it becomes an operator and the filter stops filtering.
    it("coerces an operator object on schemeId to a string", () => {
      const f = buildHistoryQuery("u", { schemeId: { $ne: "x" } });
      expect(typeof f.schemeId).toBe("string");
      expect(f.schemeId).not.toEqual({ $ne: "x" });
    });

    it("refuses an operator object on a transition filter", () => {
      const f = buildHistoryQuery("u", { recommendationTransition: { $ne: "NO_CHANGE" } });
      expect(f.recommendationTransition).toBeUndefined();
    });

    it("ignores an unparseable date rather than building an invalid range", () => {
      // `{ $gte: Invalid Date }` matches nothing, so the user would silently
      // see an empty history instead of an error.
      expect(buildHistoryQuery("u", { since: "not-a-date" }).createdAt).toBeUndefined();
      expect(buildHistoryQuery("u", { since: "2026-01-01" }).createdAt).toBeDefined();
    });
  });
});

describe("buildPagination", () => {
  it("defaults sensibly", () => {
    const p = buildPagination({});
    expect(p.page).toBe(1);
    expect(p.limit).toBe(DEFAULT_LIMIT);
    expect(p.skip).toBe(0);
  });

  it("clamps an oversized limit", () => {
    // Otherwise ?limit=100000 returns the whole collection in one response.
    expect(buildPagination({ limit: "100000" }).limit).toBe(MAX_LIMIT);
  });

  it("rejects nonsense rather than producing a negative skip", () => {
    expect(buildPagination({ page: "-5" }).page).toBe(1);
    expect(buildPagination({ page: "abc" }).skip).toBe(0);
    expect(buildPagination({ limit: "0" }).limit).toBe(DEFAULT_LIMIT);
  });

  it("computes skip from page and limit", () => {
    expect(buildPagination({ page: "3", limit: "10" }).skip).toBe(20);
  });
});

describe("serializeHistoryRow", () => {
  const out = serializeHistoryRow(row());

  it("returns the fields the UI needs", () => {
    expect(out.scheme.schemeId).toBe("scheme-a");
    expect(out.versions).toEqual({ previous: 1, current: 2 });
    expect(out.eligibility.transition).toBe("INELIGIBLE_TO_ELIGIBLE");
    expect(out.recommendation.transition).toBe("NOT_RECOMMENDED_TO_RECOMMENDED");
    expect(out.recommendation.previousRank).toBeNull();
    expect(out.recommendation.currentRank).toBe(3);
    expect(out.createdAt).toBeDefined();
  });

  it("keeps the grounded changed fields, so the row is auditable by its subject", () => {
    expect(out.reason.changedFields).toEqual([
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
    ]);
  });

  it("reports an ungenerated explanation as null, not an empty string", () => {
    // Phase K fills this. Null lets the UI say "not available yet" instead of
    // rendering a blank where a sentence should be.
    expect(out.explanation).toBeNull();
    expect(serializeHistoryRow(row({ explanation: "Because..." })).explanation).toBe("Because...");
  });

  describe("allow-list", () => {
    // A serialiser that copies the document and deletes a few fields leaks
    // every field added later. This one names what leaves.
    const leaked = JSON.stringify(out);

    it("does not expose internal job or event ids", () => {
      expect(leaked).not.toContain("cycle-123");
      expect(leaked).not.toContain("evt-1");
    });

    it("does not expose the denormalised email", () => {
      expect(leaked).not.toContain("student@example.com");
    });

    it("does not expose raw relevance scores or matcher rule lists", () => {
      expect(leaked).not.toContain("7.42");
      expect(leaked).not.toContain("rulesNowPassing");
    });

    it("keeps a newly added internal field internal until it is named here", () => {
      const withSecret = serializeHistoryRow(row({ internalDebugNote: "do-not-ship" }));
      expect(JSON.stringify(withSecret)).not.toContain("do-not-ship");
    });
  });
});

describe("listUserHistory", () => {
  const mine = [
    row({ _id: "a", userId: "user-1", schemeId: "s1", createdAt: new Date("2026-03-01") }),
    row({ _id: "b", userId: "user-1", schemeId: "s2", createdAt: new Date("2026-03-05") }),
    row({ _id: "c", userId: "user-1", schemeId: "s3", createdAt: new Date("2026-03-10") }),
  ];
  const theirs = [row({ _id: "z", userId: "user-2", schemeId: "s9" })];

  it("returns only the caller's rows", async () => {
    const model = historyStore([...mine, ...theirs]);
    const res = await listUserHistory({ userId: "user-1", model });
    expect(res.total).toBe(3);
    expect(res.items.map((i) => i.scheme.schemeId).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("cannot be tricked into returning another user's rows", async () => {
    const model = historyStore([...mine, ...theirs]);
    const res = await listUserHistory({
      userId: "user-1",
      query: { userId: "user-2" },
      model,
    });
    expect(res.items.some((i) => i.scheme.schemeId === "s9")).toBe(false);
  });

  it("paginates and reports the totals", async () => {
    const model = historyStore(mine);
    const page1 = await listUserHistory({ userId: "user-1", query: { page: "1", limit: "2" }, model });
    expect(page1.items.length).toBe(2);
    expect(page1.total).toBe(3);
    expect(page1.pages).toBe(2);

    const page2 = await listUserHistory({ userId: "user-1", query: { page: "2", limit: "2" }, model });
    expect(page2.items.length).toBe(1);
  });

  it("filters by scheme", async () => {
    const model = historyStore(mine);
    const res = await listUserHistory({ userId: "user-1", query: { schemeId: "s2" }, model });
    expect(res.total).toBe(1);
    expect(res.items[0].scheme.schemeId).toBe("s2");
  });

  it("returns an empty page rather than failing when there is no history", async () => {
    const res = await listUserHistory({ userId: "nobody", model: historyStore(mine) });
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("refuses to run without a caller id", async () => {
    // A missing id must not degrade into an unfiltered query returning
    // everyone's history.
    await expect(listUserHistory({ model: historyStore(mine) })).rejects.toThrow(/userId/);
  });
});
