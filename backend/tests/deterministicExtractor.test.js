const {
  extractDeterministic,
  extractAge,
  extractIncome,
  extractGenders,
  extractCategories,
  extractOccupations,
  extractStates,
  extractEducation,
  extractMarks,
  isProbablyUniversalLanguage,
  isProbablyUnknownText,
  parseIndianNumber,
} = require("../src/services/deterministicExtractor");

describe("parseIndianNumber", () => {
  test("plain number", () => expect(parseIndianNumber("50000")).toBe(50000));
  test("indian comma format", () => expect(parseIndianNumber("2,50,000")).toBe(250000));
  test("lakh", () => expect(parseIndianNumber("3 lakh")).toBe(300000));
  test("lakhs plural", () => expect(parseIndianNumber("2.5 lakhs")).toBe(250000));
  test("crore", () => expect(parseIndianNumber("1 crore")).toBe(10000000));
});

describe("extractAge", () => {
  test("18 to 40 years", () => expect(extractAge("Age 18 to 40 years")).toEqual({ minAge: 18, maxAge: 40 }));
  test("between 21 and 35", () => expect(extractAge("between 21 and 35 years")).toEqual({ minAge: 21, maxAge: 35 }));
  test("18-59", () => expect(extractAge("aged 18-59")).toEqual({ minAge: 18, maxAge: 59 }));
  test("min only", () => expect(extractAge("minimum age of 18 years").minAge).toBe(18));
  test("max only", () => expect(extractAge("not more than 60 years").maxAge).toBe(60));
  test("no age mentioned", () => expect(extractAge("This scheme benefits farmers.")).toEqual({ minAge: null, maxAge: null }));
});

describe("extractIncome", () => {
  test("max income lakh", () => {
    expect(extractIncome("annual family income does not exceed Rs. 3 lakh").maxAnnualIncome).toBe(300000);
  });
  test("max income exact number", () => {
    expect(extractIncome("income below ₹2,50,000").maxAnnualIncome).toBe(250000);
  });
  test("minimum income", () => {
    expect(extractIncome("minimum income of Rs 1 lakh per annum").minAnnualIncome).toBe(100000);
  });
});

describe("extractGenders", () => {
  test("women only", () => expect(extractGenders("For women applicants only")).toContain("Female"));
  test("male candidates", () => expect(extractGenders("Male candidates only")).toContain("Male"));
  test("transgender", () => expect(extractGenders("Transgender persons are eligible")).toContain("Other"));
});

describe("extractCategories", () => {
  test("SC/ST/OBC", () => {
    const c = extractCategories("SC/ST/OBC candidates from BPL families");
    expect(c).toEqual(expect.arrayContaining(["SC", "ST", "OBC", "BPL"]));
  });
  test("Person with Disability", () => {
    expect(extractCategories("persons with disability")).toContain("Person with Disability");
  });
});

describe("extractOccupations", () => {
  test("farmers", () => expect(extractOccupations("Small and marginal farmers")).toContain("Farmer"));
  test("students", () => expect(extractOccupations("Students pursuing higher education")).toContain("Student"));
});

describe("extractStates", () => {
  test("single state", () => expect(extractStates("residents of Karnataka only")).toEqual(["Karnataka"]));
  test("multiple states", () => {
    const s = extractStates("Karnataka, Tamil Nadu and Kerala");
    expect(s).toEqual(expect.arrayContaining(["Karnataka", "Tamil Nadu", "Kerala"]));
  });
  test("nationwide has no state", () => expect(extractStates("All India")).toEqual([]));
});

describe("extractEducation", () => {
  test("post graduate wins over graduate", () => expect(extractEducation("Post Graduate degree required")).toBe("Post Graduate"));
  test("12th standard", () => expect(extractEducation("Must have passed 12th Standard")).toBe("12th Standard"));
  test("matriculate → 10th", () => expect(extractEducation("matriculation pass")).toBe("10th Standard"));
  test("bachelors → graduate", () => expect(extractEducation("Bachelor's degree completed")).toBe("Graduate"));
  test("undergraduate / UG students → Undergraduate", () => expect(extractEducation("Scholarship for undergraduate students pursuing B.Tech")).toBe("Undergraduate"));
});

describe("extractMarks", () => {
  test("60%", () => expect(extractMarks("minimum 60% marks")).toBe(60));
  test("50.5%", () => expect(extractMarks("50.5% aggregate")).toBe(50.5));
  test("out of range", () => expect(extractMarks("150% growth")).toBe(null));
});

describe("universal / unknown classification", () => {
  test("open to all → universal", () => expect(isProbablyUniversalLanguage("This scheme is open to all Indian citizens")).toBe(true));
  test("every citizen → universal", () => expect(isProbablyUniversalLanguage("every citizen of India")).toBe(true));
  test("constrained wording → not universal", () => expect(isProbablyUniversalLanguage("Only SC/ST families")).toBe(false));
  test("empty text → unknown", () => expect(isProbablyUnknownText("")).toBe(true));
  test("N/A → unknown", () => expect(isProbablyUnknownText("N/A")).toBe(true));
  test("real content → not unknown", () => expect(isProbablyUnknownText("Age 18-40, SC/ST candidates only.")).toBe(false));
});

describe("extractDeterministic — end to end classification", () => {
  test("constrained: sc/st age income", () => {
    const r = extractDeterministic("SC/ST candidates aged 18 to 40 with family income below Rs. 2 lakh");
    expect(r.eligibilityType).toBe("constrained");
    expect(r.minAge).toBe(18);
    expect(r.maxAge).toBe(40);
    expect(r.maxAnnualIncome).toBe(200000);
    expect(r.categories).toEqual(expect.arrayContaining(["SC", "ST"]));
    expect(r.confidence).toBeGreaterThan(0.5);
  });
  test("universal: open to all", () => {
    const r = extractDeterministic("This scheme is open to all Indian citizens without any income limit.");
    expect(r.eligibilityType).toBe("universal");
    expect(r.signals).toBe(0);
  });
  test("unknown: placeholder text", () => {
    const r = extractDeterministic("N/A");
    expect(r.eligibilityType).toBe("unknown");
  });
  test("women farmers in Karnataka", () => {
    const r = extractDeterministic("Women farmers in Karnataka aged 21-50 with annual income up to 3 lakh");
    expect(r.eligibilityType).toBe("constrained");
    expect(r.genders).toContain("Female");
    expect(r.occupations).toContain("Farmer");
    expect(r.states).toContain("Karnataka");
    expect(r.maxAnnualIncome).toBe(300000);
  });
});

describe("extractAge — tenure vs personal age (regression: award schemes)", () => {
  // "N years of experience/service" is NOT an age. Before this guard the
  // National Metallurgist Award (20 yrs experience) matched a 25-year-old.
  test("pure tenure text yields no age rule", () => {
    expect(extractAge("The applicant should have completed a minimum 25 years of service."))
      .toEqual({ minAge: null, maxAge: null });
  });
  test("'N years of <non-age>' is treated as tenure", () => {
    expect(extractAge("The applicant should have at least 10 years of ACR/APAR records under review."))
      .toEqual({ minAge: null, maxAge: null });
  });
  test("association tenure is not an age", () => {
    expect(extractAge("they have been associated with an athlete for at least 5 years during the 20-year period"))
      .toEqual({ minAge: null, maxAge: null });
  });
  test("continuous-operation tenure is not an age", () => {
    expect(extractAge("the unit necessity is to have a continuous operation for a minimum of 2 years"))
      .toEqual({ minAge: null, maxAge: null });
  });
  test("MIXED tenure + age keeps the age number, discards the tenure number", () => {
    expect(extractAge("The applicant should have at least 20 years of experience, be minimum 50 years of age, and hold a Bachelors degree."))
      .toEqual({ minAge: 50, maxAge: null });
  });
  test("a real range survives an adjacent tenure clause", () => {
    expect(extractAge("aged 18 to 40 years with at least 2 years of experience"))
      .toEqual({ minAge: 18, maxAge: 40 });
  });
});

describe("extractAge — ministry drafting typo (regression: Biponi Scheme)", () => {
  // "not less than 18 and MORE than 50" is a drafting error for "not more
  // than 50". Read literally it left maxAge null, so a 75-year-old matched.
  test("'not less than X and more than Y' parses as the range X..Y", () => {
    expect(extractAge("The age of the applicant should be not less than 18 years and more than 50 years to apply for this scheme."))
      .toEqual({ minAge: 18, maxAge: 50 });
  });
  test("the correctly-drafted form still parses", () => {
    expect(extractAge("not less than 18 years and not more than 50 years"))
      .toEqual({ minAge: 18, maxAge: 50 });
  });
  test("'not more than N' does not leak into minAge via 'more than'", () => {
    expect(extractAge("not more than 60 years")).toEqual({ minAge: null, maxAge: 60 });
  });
});

describe("extractAge — forms found in the live corpus", () => {
  test.each([
    ["Age 18 to 40 years", 18, 40],
    ["aged 18-59", 18, 59],
    ["between 21 and 35 years", 21, 35],
    ["Applicant must be between 18 and 40 years old", 18, 40],
    ["Individual bank account holders aged between 18 years and 70 years", 18, 70],
    ["Between the age of 15- 29 years as of the first January", 15, 29],
    ["Residents of Assam above 18 years of age.", 18, null],
    ["Upper age limit is 50 years to apply.", null, 50],
    ["be maximum 35 years of age", null, 35],
    ["minimum age of 18 years", 18, null],
    ["This scheme benefits farmers.", null, null],
  ])("%s -> {min:%s, max:%s}", (text, min, max) => {
    expect(extractAge(text)).toEqual({ minAge: min, maxAge: max });
  });
});
