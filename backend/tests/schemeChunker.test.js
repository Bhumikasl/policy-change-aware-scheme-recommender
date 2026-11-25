const { chunkScheme, rankChunksForUser, splitSentences } = require("../src/services/schemeChunker");

describe("splitSentences", () => {
  test("splits on . ! ?", () => {
    expect(splitSentences("Hello. World! How are you?")).toEqual(["Hello.", "World!", "How are you?"]);
  });
  test("splits on newlines", () => {
    expect(splitSentences("Line one\nLine two")).toEqual(["Line one", "Line two"]);
  });
});

describe("chunkScheme", () => {
  test("small scheme → one chunk per non-empty section", () => {
    const chunks = chunkScheme({
      name: "PM-KISAN",
      description: "Income support for small farmers.",
      eligibility: "Small and marginal farmers with cultivable land.",
      benefits: "Rs 6000 per year.",
      documents: ["Aadhaar Card"],
      ministry: "Agriculture",
      state: "All India",
    });
    const sections = new Set(chunks.map((c) => c.section));
    expect(sections.has("name")).toBe(true);
    expect(sections.has("eligibility")).toBe(true);
    expect(sections.has("benefits")).toBe(true);
  });
  test("skips empty sections entirely", () => {
    const chunks = chunkScheme({ name: "X", description: "", eligibility: "eligible farmers" });
    expect(chunks.some((c) => c.section === "description")).toBe(false);
  });
  test("large eligibility text is split into multiple chunks", () => {
    const long = ("Applicant must be a farmer. ").repeat(80); // ~2400 chars
    const chunks = chunkScheme({ name: "X", eligibility: long });
    const eligChunks = chunks.filter((c) => c.section === "eligibility");
    expect(eligChunks.length).toBeGreaterThan(1);
    for (const c of eligChunks) expect(c.text.length).toBeLessThanOrEqual(700);
  });
});

describe("rankChunksForUser", () => {
  test("bumps chunks that mention profile keywords", () => {
    const chunks = chunkScheme({
      name: "Karnataka Farmer Scheme",
      description: "For all farmers in Karnataka.",
      eligibility: "Applicant must be a farmer resident of Karnataka.",
      benefits: "Rs 5000 subsidy.",
    });
    const ranked = rankChunksForUser(chunks, { profile: { state: "Karnataka", occupation: "Farmer" } }, 3);
    // The eligibility chunk mentions BOTH keywords → should rank top.
    expect(ranked[0].section).toBe("eligibility");
  });
  test("always includes at least one eligibility chunk", () => {
    const chunks = chunkScheme({
      name: "X",
      description: "some text unrelated to user",
      eligibility: "targeted at some other cohort",
      benefits: "benefit text",
    });
    const ranked = rankChunksForUser(chunks, { profile: { state: "Kerala" } }, 2);
    expect(ranked.some((c) => c.section === "eligibility")).toBe(true);
  });
});
