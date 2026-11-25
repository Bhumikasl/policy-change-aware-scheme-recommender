/**
 * Deterministic (regex + keyword) eligibility extractor.
 *
 * This runs BEFORE the LLM. Its job is to give us high-confidence,
 * auditable signals from the free-text eligibility blob so that:
 *
 *   1. When the LLM contradicts these signals, we can flag / override it.
 *      An LLM is NOT the final authority on eligibility — a regex that
 *      finds "annual family income does not exceed Rs. 2,50,000" is more
 *      trustworthy than an LLM guess.
 *
 *   2. When Gemini is disabled (no key, quota exhausted, error), we still
 *      get *some* structured rules instead of falling back to legacy
 *      tag-only matching.
 *
 *   3. We can classify the scheme's eligibilityType (universal /
 *      constrained / unknown) purely from these signals + a small
 *      universal-language keyword set.
 *
 * Everything here is transparent: given the same input string, the same
 * output comes out — no network, no model, no drift.
 */

const { EDUCATION_LEVELS } = require("./eligibilityLevels");

// Indian states + union territories the platform recognises.
const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
  "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram",
  "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
  "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
  "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir",
  "Ladakh", "Lakshadweep", "Puducherry",
];

// Language patterns that signal "this scheme is open to everyone (in a
// given jurisdiction)". Matching one of these — AND finding no restrictive
// numeric / categorical constraints — is what lets us confidently classify
// a scheme as `universal`.
const UNIVERSAL_PATTERNS = [
  /\ball\s+(indian\s+)?citizens?\b/i,
  /\bevery\s+(indian\s+)?citizen\b/i,
  /\bopen\s+to\s+all\b/i,
  /\bany\s+(indian\s+)?citizen\b/i,
  /\ball\s+residents?\s+of\s+india\b/i,
  /\bapplicable\s+to\s+all\b/i,
  /\bavailable\s+to\s+all\b/i,
  /\bany\s+person\b/i,
  /\bfor\s+all\b/i,
  /\bwithout\s+any\s+(income|age|caste)\s+(limit|restriction|criteria)\b/i,
  /\ball\s+beneficiaries\b/i,
  /\bwhole\s+(country|nation)\b/i,
];

// Language that signals we simply don't know — the eligibility blob is
// missing, empty, or a placeholder.
const UNKNOWN_PATTERNS = [
  /^\s*(n\/?a|na|none|not\s+specified|refer\s+to|see\s+website|as\s+per\s+guidelines)\s*\.?\s*$/i,
  /^\s*to\s+be\s+announced\s*\.?\s*$/i,
  /^\s*details?\s+(will\s+be|to\s+be)\s+(added|updated)\s*\.?\s*$/i,
];

function parseIndianNumber(str) {
  // "2.5 lakh" / "2,50,000" / "5 lakhs" / "1 crore" / "50000"
  if (!str) return null;
  const s = String(str).toLowerCase().replace(/[,\s]/g, "");
  const lakhMatch = s.match(/^([\d.]+)lakhs?$/);
  if (lakhMatch) return Math.round(parseFloat(lakhMatch[1]) * 100000);
  const croreMatch = s.match(/^([\d.]+)crores?$/);
  if (croreMatch) return Math.round(parseFloat(croreMatch[1]) * 10000000);
  const plain = parseFloat(s);
  return Number.isFinite(plain) ? plain : null;
}

/**
 * Look for phrases like:
 *   "18 to 40 years"                → { minAge:18, maxAge:40 }
 *   "between 21 and 35"             → { minAge:21, maxAge:35 }
 *   "aged 18-59"                    → { minAge:18, maxAge:59 }
 *   "minimum age 18 years"          → { minAge:18 }
 *   "not more than 60 years"        → { maxAge:60 }
 */
// Phrases that mean "years accrued doing something", NOT "age of a person".
// Award and fellowship schemes are full of these: "at least 20 years of
// experience", "minimum 25 years of service", "associated for 5 years".
// Without this guard the age extractor reads the tenure number as a personal
// age and a 25-year-old matches a Lifetime Achievement Award.
const TENURE_CONTEXT_RE =
  /\b(experience|service|tenure|coaching|contribut\w*|associat\w*|standing|practice|employment|work\w*|career|enrol\w*|operation|continuous)\b/i;
// Phrases that unambiguously mean a person's age.
const AGE_CONTEXT_RE = /\b(age|aged|years?\s+old|age\s+limit|years\s+of\s+age)\b/i;

function extractAge(text) {
  const out = { minAge: null, maxAge: null };

  // --- Guard: tenure language with no age language at all -> no age rule. ---
  // Checked first so no downstream regex can pick up a tenure number.
  if (!AGE_CONTEXT_RE.test(text) && TENURE_CONTEXT_RE.test(text)) {
    return out;
  }

  // --- Ministry typo: "not less than X years and more than Y years". ---
  // Read literally this is contradictory (>=X AND >Y). It is a very common
  // drafting error for "not less than X and NOT more than Y", i.e. a range.
  // Handled before the generic patterns because the `min` regex below would
  // otherwise capture X and leave the upper bound unset, making every older
  // applicant pass. (Biponi Scheme: 18..50 was read as 18..null.)
  const negRange = text.match(
    /\bnot\s+less\s+than\s+(\d{1,3})\s*(?:years?)?\s+and\s+(?:not\s+)?more\s+than\s+(\d{1,3})\s*years?\b/i
  );
  if (negRange) {
    const a = parseInt(negRange[1], 10);
    const b = parseInt(negRange[2], 10);
    if (a <= b && a >= 0 && b <= 120) {
      out.minAge = a;
      out.maxAge = b;
      return out;
    }
  }

  // --- Mixed tenure + age text: keep only the age-bearing clauses. ---
  // "at least 20 years of experience, be minimum 50 years of age" must yield
  // 50, not 20. Split into clauses and drop any that talks about tenure
  // without also talking about age; run every later pattern on what remains.
  // "<N> years of <something>" is tenure unless that something is "age".
  // This generalises past a keyword list — "10 years of ACR records",
  // "5 years of standing", "3 years of continuous operation" all fall out.
  const YEARS_OF_NON_AGE_RE = /\d{1,3}\s*years?\s+of\s+(?!age\b)/i;
  // Split on punctuation ONLY. Splitting on "and" would tear apart
  // "aged between 18 and 70 years", which is a single range expression.
  const scoped = text
    .split(/[,;.]/)
    .filter((clause) => {
      if (AGE_CONTEXT_RE.test(clause)) return true;      // explicitly about age
      if (TENURE_CONTEXT_RE.test(clause)) return false;  // explicitly tenure
      if (YEARS_OF_NON_AGE_RE.test(clause)) return false; // "N years of <x>"
      return true;
    })
    .join(" . ");
  // No fallback to the raw text here on purpose. If every clause was tenure,
  // then "this scheme states no age rule" is the CORRECT answer — falling
  // back would re-admit the tenure numbers the filter just removed.
  const src = scoped;

  // `(?:years?\s+)?` between the first number and the separator handles
  // "aged between 18 years and 70 years", which government text uses freely.
  const RANGE_ANCHORED =
    /\b(?:age(?:d)?|between)\s+(?:of\s+)?(\d{1,3})\s*(?:years?|yrs?)?\s*(?:to|-|and|–|—)\s*(\d{1,3})\s*(?:years?|yrs?)?\b/i;
  const RANGE_BARE = /\b(\d{1,3})\s*(?:to|-|–|—)\s*(\d{1,3})\s*years?\b/i;
  const range = src.match(RANGE_ANCHORED) || text.match(RANGE_ANCHORED) || src.match(RANGE_BARE);
  if (range) {
    const a = parseInt(range[1], 10);
    const b = parseInt(range[2], 10);
    if (a <= b && a >= 0 && b <= 120) {
      out.minAge = a;
      out.maxAge = b;
      return out;
    }
  }

  // Age-anchored forms first — "<qualifier> N years of age" is unambiguous,
  // whereas the generic patterns below can pick up a tenure number that
  // survived clause filtering.
  const ageAnchoredMin = src.match(
    /\b(?:minimum|min\.?|at\s+least|not\s+less\s+than|above|over)\s+(?:of\s+)?(\d{1,3})\s*years?\s+of\s+age\b/i
  );
  if (ageAnchoredMin) out.minAge = parseInt(ageAnchoredMin[1], 10);

  const ageAnchoredMax = src.match(
    /\b(?:maximum|max\.?|upper\s+age\s+limit\s+is|not\s+more\s+than|below|under|up\s*to)\s+(?:of\s+|age\s+(?:limit\s+)?(?:is\s+)?)?(\d{1,3})\s*years?(?:\s+of\s+age)?\b/i
  );
  if (ageAnchoredMax) out.maxAge = parseInt(ageAnchoredMax[1], 10);

  if (out.minAge === null) {
    const min = src.match(/\b(?:minimum\s+age|min\.?\s+age|at\s+least|not\s+less\s+than)\s*(?:of\s+)?(\d{1,3})\s*years?\b/i);
    if (min) out.minAge = parseInt(min[1], 10);
  }

  if (out.maxAge === null) {
    const max = src.match(/\b(?:maximum\s+age|max\.?\s+age|upper\s+age\s+limit(?:\s+is)?|not\s+(?:more|greater)\s+than|below|under|upto|up\s+to)\s*(\d{1,3})\s*years?\b/i);
    if (max) out.maxAge = parseInt(max[1], 10);
  }

  // "above N years" implies a minimum of N+1. The negative lookbehind is
  // essential: without it "NOT more than 60 years" matches here and sets
  // minAge=61 alongside maxAge=60, which then trips the ordering guard and
  // discards a perfectly good upper bound.
  const aboveOnly = src.match(/\b(?<!not\s)(?:above|over|more\s+than)\s+(\d{1,3})\s*years?\b/i);
  if (aboveOnly && out.minAge === null && out.maxAge === null) {
    out.minAge = parseInt(aboveOnly[1], 10) + 1;
  }

  // Sanity: a parsed range must be ordered. If tenure noise produced
  // min > max, trust neither.
  if (out.minAge !== null && out.maxAge !== null && out.minAge > out.maxAge) {
    return { minAge: null, maxAge: null };
  }
  return out;
}

/**
 *   "annual income does not exceed Rs. 2 lakh"
 *   "family income below ₹3,00,000"
 *   "income up to 5 lakhs"
 *   "minimum income of Rs 1 lakh per annum"
 */
function extractIncome(text) {
  const out = { minAnnualIncome: null, maxAnnualIncome: null };

  const maxRe =
    /(?:annual\s+(?:family\s+)?income|family\s+income|income)\b[^.;\n]{0,80}?\b(?:not\s+exceed|does\s+not\s+exceed|must\s+not\s+exceed|should\s+not\s+exceed|less\s+than|below|upto|up\s+to|not\s+more\s+than|is\s+less\s+than|maximum\s+of)\s*(?:rs\.?|₹|inr)?\s*([\d,.]+\s*(?:lakhs?|crores?)?|\d+)/i;
  const maxMatch = text.match(maxRe);
  if (maxMatch) {
    const v = parseIndianNumber(maxMatch[1]);
    if (v !== null) out.maxAnnualIncome = v;
  }

  const minRe =
    /(?:minimum|min\.?)\s+(?:annual\s+)?income\b[^.;\n]{0,50}?\s*(?:of\s+)?(?:rs\.?|₹|inr)?\s*([\d,.]+\s*(?:lakhs?|crores?)?|\d+)/i;
  const minMatch = text.match(minRe);
  if (minMatch) {
    const v = parseIndianNumber(minMatch[1]);
    if (v !== null) out.minAnnualIncome = v;
  }

  return out;
}

/**
 *   "for women / girls only"           → ["Female"]
 *   "male candidates only"             → ["Male"]
 *   "transgender applicants"           → ["Other"]  (best-effort)
 */
function extractGenders(text) {
  const g = new Set();
  if (/\b(women|woman|female|girl|widow|mahila)s?\s+(?:only|candidates?|applicants?|beneficiaries?)?\b/i.test(text)) g.add("Female");
  if (/\bfor\s+(women|girls?|female|widows?)\b/i.test(text)) g.add("Female");
  if (/\b(men|male|boys?)\s+(?:only|candidates?|applicants?)?\b/i.test(text)) g.add("Male");
  if (/\btransgender\b/i.test(text)) g.add("Other");
  // "SC/ST women" implies female
  if (g.size === 0 && /\bwomen\b/i.test(text)) g.add("Female");
  return [...g];
}

/**
 *   "SC/ST/OBC candidates" → ["SC","ST","OBC"]
 *   "BPL families"         → ["BPL"]
 *   "persons with disability" → ["Person with Disability"]
 */
const CATEGORY_KEYWORDS = [
  { key: "SC",                       re: /\b(sc|scheduled\s+castes?)\b/i },
  { key: "ST",                       re: /\b(st|scheduled\s+tribes?)\b/i },
  { key: "OBC",                      re: /\b(obc|other\s+backward\s+classes?)\b/i },
  { key: "Minority",                 re: /\bminorit(?:y|ies)\b/i },
  { key: "BPL",                      re: /\b(bpl|below\s+poverty\s+line)\b/i },
  { key: "BPL / Economically Weaker", re: /\b(bpl|below\s+poverty\s+line|ews|economically\s+weaker\s+sections?)\b/i },
  { key: "Widow",                    re: /\bwidows?\b/i },
  { key: "Person with Disability",   re: /\b(persons?\s+with\s+(?:a\s+)?(?:benchmark\s+)?disabilit(?:y|ies)|students?\s+with\s+(?:a\s+)?(?:benchmark\s+)?disabilit(?:y|ies)|children\s+with\s+disabilit(?:y|ies)|physically\s+(?:disabled|handicapped|challenged)|differently\s+abled|divyangjan|divyang|pwd|handicapped|\bdisabled\b)\b/i },
  { key: "Senior Citizen",           re: /\b(senior\s+citizens?|elderly)\b/i },
  { key: "Ex-Servicemen",            re: /\b(ex[-\s]?servicem[ae]n|veterans?)\b/i },
  { key: "Migrant Worker",           re: /\bmigrant\s+workers?\b/i },
  { key: "Single Parent",            re: /\bsingle\s+parents?\b/i },
];
function extractCategories(text) {
  const out = [];
  for (const { key, re } of CATEGORY_KEYWORDS) {
    if (re.test(text)) out.push(key);
  }
  return out;
}

/**
 * Detect OR-groups vs AND-requirements among category mentions.
 */
function extractCategoryGroups(text) {
  const safe = String(text || "");
  const groups = [];
  const seen = new Set();

  const ANY_CAT = CATEGORY_KEYWORDS.map((c) => c.re.source).join("|");
  const SEP = "\\s*(?:\\/|,|\\bor\\b|\\band\\b)\\s*";
  const OR_LIST_RE = new RegExp(`(?:${ANY_CAT})(?:${SEP}(?:${ANY_CAT}))+`, "gi");

  const matches = safe.match(OR_LIST_RE) || [];
  for (const clause of matches) {
    const hits = [];
    for (const { key, re } of CATEGORY_KEYWORDS) {
      if (re.test(clause)) hits.push(key);
    }
    const dedup = [...new Set(hits)];
    if (dedup.length >= 2) {
      groups.push(dedup);
      dedup.forEach((k) => seen.add(k));
    }
  }

  for (const { key, re } of CATEGORY_KEYWORDS) {
    if (seen.has(key)) continue;
    if (re.test(safe)) {
      groups.push([key]);
      seen.add(key);
    }
  }

  const flat = [...seen];
  return { groups, flat };
}

const OCCUPATION_KEYWORDS = [
  { key: "Student",           re: /\b(students?|pupils?|scholars?)\b/i },
  { key: "Farmer",            re: /\b(farmers?|kisan|cultivators?|agriculturists?)\b/i },
  { key: "Entrepreneur",      re: /\b(entrepreneurs?|start[-\s]?ups?)\b/i },
  { key: "Salaried Employee", re: /\b(salaried\s+employees?)\b/i },
  { key: "Self-Employed",     re: /\bself[-\s]?employed\b/i },
  { key: "Unemployed",        re: /\bunemployed\b/i },
  { key: "Homemaker",         re: /\b(homemakers?|housewives?|housewife)\b/i },
  { key: "Retired",           re: /\bretired\b/i },
  { key: "Artisan / Weaver",  re: /\b(artisans?|weavers?|handloom)\b/i },
  { key: "Fisherman",         re: /\b(fishermen|fisherman|fisherfolk)\b/i },
  { key: "Construction Worker", re: /\b(construction\s+workers?|building\s+and\s+other\s+construction\s+workers?)\b/i },
];
function extractOccupations(text) {
  const out = [];
  for (const { key, re } of OCCUPATION_KEYWORDS) if (re.test(text)) out.push(key);
  return out;
}

function extractStates(text) {
  const found = [];
  for (const st of INDIAN_STATES) {
    const re = new RegExp(`\\b${st.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) found.push(st);
  }
  return [...new Set(found)];
}

function extractEducation(text) {
  // Longest-first: "Post Graduate" should win over "Graduate".
  const sorted = [...EDUCATION_LEVELS].sort((a, b) => b.length - a.length);
  for (const level of sorted) {
    const re = new RegExp(`\\b${level.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) return level;
  }
  // Missing mappings causing false-positives because they returned null (no constraint):
  if (/\b(phd|ph\.d|doctorate|post[-\s]?doctoral|post[-\s]?doc)\b/i.test(text)) return "Doctorate";
  if (/\b(post[-\s]?graduate|pg|master'?s?)\b/i.test(text)) return "Post Graduate";
  if (/\b(under[-\s]?graduate|ug|b\.?tech|be\b|b\.?sc|b\.?com|bba|bca|bams|bhms|bums|bds|mbbs|bachelor'?s?\s+degree\s+(?:pursuing|student|studying)|pursuing\s+(?:graduation|bachelor|degree))\b/i.test(text)) return "Undergraduate";
  if (/\b(graduate\s+engineers?|passed\s+graduation|completed\s+(?:graduation|degree)|graduation|bachelor'?s?\s+degree|degree\s+holders?)\b/i.test(text)) return "Graduate";
  if (/\b(12th|xii|intermediate|higher\s+secondary|hsc|11th|xi|class\s*11|class\s*12)\b/i.test(text)) return "12th Standard";
  if (/\b(10th|x\s+standard|matriculat(?:ion|e)|ssc|post[-\s]?matric)\b/i.test(text)) return "10th Standard";
  return null;
}

function extractMarks(text) {
  // Only match when explicitly linked to marks, scores, aggregate, or qualifying exam percentages
  const m = text.match(/\b(?:minimum\s+)?(\d{2,3}(?:\.\d+)?)\s*%\s*(?:marks|aggregate|score|percentage\s+of\s+marks|\b(?:in|at)\s+(?:the\s+)?qualifying)\b/i);
  if (m) {
    const v = parseFloat(m[1]);
    if (v > 0 && v <= 100) return v;
  }
  const m2 = text.match(/\b(?:secured|obtained|with|scored)\s+(?:at\s+least\s+)?(\d{2,3}(?:\.\d+)?)\s*%\s*(?:in\s+(?:class|standard|exam|examination|graduation|10th|12th|degree))/i);
  if (m2) {
    const v = parseFloat(m2[1]);
    if (v > 0 && v <= 100) return v;
  }
  return null;
}

/**
 * Education ceiling: e.g. "Pre-Matric", "Classes I to X", "up to 10th standard"
 */
const MAX_EDU_CONTEXT_RE =
  /\b(pre[-\s]?matric|up\s*to|not\s+more\s+than|maximum|not\s+(?:exceeding|exceed)|below|under|has\s+not\s+(?:completed|passed)|studying\s+(?:up\s*to|in)|only\s+for\s+students?\s+(?:up\s*to|below)|classes?\s+(?:[i|1]\s*(?:to|-)\s*[x|10]|[ix|9]\s*(?:and|&|-|to)\s*[x|10]))\b/i;
function extractMaxEducation(text) {
  if (!MAX_EDU_CONTEXT_RE.test(text)) return null;
  if (/\bpre[-\s]?matric\b/i.test(text) || /\bclasses?\s+(?:[i|1]\s*(?:to|-)\s*[x|10]|[ix|9]\s*(?:and|&|-|to)\s*[x|10])\b/i.test(text)) {
    return "10th Standard";
  }
  const sorted = [...EDUCATION_LEVELS].sort((a, b) => b.length - a.length);
  for (const level of sorted) {
    const escaped = level.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `\\b(?:up\\s*to|not\\s+more\\s+than|maximum|below|under|has\\s+not\\s+(?:completed|passed)|studying\\s+(?:up\\s*to|in)|not\\s+(?:exceeding|exceed))\\b[^.;]{0,25}\\b${escaped}\\b`,
      "i"
    );
    if (re.test(text)) return level;
  }
  return null;
}

/**
 *   "40% or more disability"
 *   "minimum 40% disability"
 *   "disability of at least 25%"
 */
function extractDisabilityPercentage(text) {
  const m = text.match(
    /\b(\d{1,3})\s*%\s*(?:or\s+more\s+)?(?:benchmark\s+)?disabilit(?:y|ies)\b|\bdisabilit(?:y|ies)\s+(?:percentage\s+)?(?:of\s+)?(?:at\s+least|minimum|not\s+less\s+than)?\s*(\d{1,3})\s*%/i
  );
  if (!m) return null;
  const v = parseFloat(m[1] ?? m[2]);
  return v > 0 && v <= 100 ? v : null;
}

// True if the text restricts the scheme to persons with disabilities
const DISABILITY_REQUIRED_RE =
  /\b(persons?\s+with\s+(?:a\s+)?(?:benchmark\s+)?disabilit(?:y|ies)|students?\s+with\s+(?:a\s+)?(?:benchmark\s+)?disabilit(?:y|ies)|children\s+with\s+disabilit(?:y|ies)|physically\s+(?:disabled|handicapped|challenged)|differently\s+abled|divyangjan|divyang|pwd|handicapped|\bdisabled\b)\b/i;
function extractDisabilityRequired(text) {
  return DISABILITY_REQUIRED_RE.test(text) ? true : null;
}

const SINGLE_GIRL_CHILD_RE =
  /\b(single\s+girl\s+child|only\s+girl\s+child|one\s+girl\s+child|sole\s+(?:surviving\s+)?girl\s+child)\b/i;
function extractSingleGirlChild(text) {
  return SINGLE_GIRL_CHILD_RE.test(text) ? true : null;
}

/**
 * Course / stream restriction, e.g. "for engineering students",
 * "pursuing a course in Computer Science", "students of Agriculture".
 * Deliberately a curated keyword set, not free-text NLP — the same
 * transparency trade-off as the rest of this module: what it recognises,
 * it recognises reliably; what it doesn't, it leaves null rather than
 * guessing.
 */
const COURSE_KEYWORDS = [
  { key: "Engineering",       re: /\b(engineering|b\.?\s?tech|be\b|m\.?\s?tech)\b/i },
  { key: "Computer Science",  re: /\b(computer\s+science|computer\s+applications?|\bcs\b|\bcse\b|\bit\b|information\s+technology)\b/i },
  { key: "Medicine",          re: /\b(medicine|medical|mbbs|\bmd\b|\bms\b(?!c)|nursing|bams|bhms|bums|bds)\b/i },
  { key: "Law",                re: /\b(law|llb|llm)\b/i },
  { key: "Agriculture",       re: /\bagricultur\w*\b/i },
  { key: "Animal Science / Veterinary", re: /\b(animal\s+husbandry|animal\s+science|veterinar\w*|bvsc|mvsc|dairy)\b/i },
  { key: "Horticulture / Forestry / Fisheries", re: /\b(horticultur\w*|forestr\w*|fisher\w*|aquacultur\w*|sericultur\w*)\b/i },
  { key: "Architecture / Planning", re: /\b(architecture|b\.?\s?arch|m\.?\s?arch|urban\s+planning)\b/i },
  { key: "Biotechnology",    re: /\b(biotech\w*|bioinformatics)\b/i },
  { key: "Arts",               re: /\b(arts|humanities|\bba\b)\b/i },
  { key: "Commerce",          re: /\b(commerce|\bbcom\b|\bmcom\b|accountancy)\b/i },
  { key: "Science",            re: /\b(science|\bbsc\b|\bmsc\b)\b/i },
  { key: "Management",        re: /\b(management|\bmba\b|\bbba\b)\b/i },
  { key: "Pharmacy",          re: /\bpharmac\w*\b/i },
  { key: "Polytechnic / Diploma", re: /\bpolytechnic\b/i },
  { key: "Vocational",        re: /\bvocational\b/i },
];
// Only fire when the text ties the keyword to a course/stream/study
// context — otherwise "Agriculture Ministry" or "Science and Technology
// department name" would be misread as a course restriction.
const COURSE_CONTEXT_RE =
  /\b(course|stream|discipline|studying|pursuing|student[s]?\s+of|branch|degree|programme|program|scholarship\s+for|fellowship\s+for|students?\s+in|undergraduate|postgraduate|b\.?tech|be\b|bsc|msc|bcom|ba|mbbs|diploma)\b/i;
function extractCourses(text) {
  if (!COURSE_CONTEXT_RE.test(text)) return [];
  const out = [];
  for (const { key, re } of COURSE_KEYWORDS) {
    if (re.test(text)) out.push(key);
  }
  return [...new Set(out)];
}

function isProbablyUniversalLanguage(text) {
  return UNIVERSAL_PATTERNS.some((re) => re.test(text));
}

function isProbablyUnknownText(text) {
  if (!text) return true;
  const trimmed = text.trim();
  // Very short strings are only "unknown" if they don't also parse into
  // real signals — see extractDeterministic below. A short but valid
  // constraint like "Age 18 to 40 years" (18 chars) is legitimate and
  // must NOT short-circuit the extractors.
  if (trimmed.length < 8) return true;
  return UNKNOWN_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Run every extractor. Returns a rules object shaped like
 * models/Scheme.EligibilityRulesSchema PLUS an `eligibilityType` field.
 *
 *   eligibilityType:
 *     - "universal"   : language matches an open-to-all phrasing AND no
 *                        restrictive constraint was extracted.
 *     - "constrained" : at least one restrictive constraint was extracted.
 *     - "unknown"     : text is missing/placeholder AND we found nothing.
 *
 * Confidence reflects how many extractors fired — a text that produced
 * age + income + categories is trusted more than one that produced a
 * bare "Woman" tag.
 */
const RESTRICTIVE_INDICATORS = [
  /\b(scholarships?|fellowships?|stipends?|grants?|subsid(?:y|ies)|loans?|pensions?)\b/i,
  /\b(students?|farmers?|teachers?|scientists?|researchers?|scholars?|innovators?|artisans?|weavers?|fisherm[ae]n|workers?|labourers?)\b/i,
  /\b(start[-\s]?ups?|entrepreneurs?|msme|enterprises?|industr\w+|companies|institutions?|schools?|colleges?|universit\w+)\b/i,
  /\b(agricultur\w*|engineering|medical|mbbs|nursing|pharmacy|polytechnic|vocational)\b/i,
  /\b(class\s*\d+|10th|12th|matric\w*|under[-\s]?graduate|post[-\s]?graduate|ph\.?d|doctorate|post[-\s]?doc)\b/i,
  /\b(sc|st|obc|bpl|ews|pwd|disab\w+|handicapped|divyang\w*|widows?|minority|minorities|tribal|caste)\b/i,
  /\b(only|restricted|mandatory|criteria|eligible|eligibility|must\s+be|must\s+have|should\s+be|should\s+have|applicable\s+(?:only\s+)?to)\b/i,
];

function hasUnrepresentedRestrictions(text) {
  return RESTRICTIVE_INDICATORS.some((re) => re.test(text));
}

function extractApplicantTypes(text) {
  const safe = String(text || "").toLowerCase();
  const types = new Set();

  // 1. Context mask: Replace prepositional/affiliational mentions so they are not mistaken for the primary applicant
  const cleanText = safe
    .replace(/\b(?:studying|enrolled|admitted|pursuing|undergoing|reading|training|registered)\s+(?:in|at|with|from)\s+[^.;,\n]{0,80}\b(?:institutions?|colleges?|universit\w+|schools?|polytechnics?|training\s+centres?|hospitals?|laborator\w+)\b/gi, " [CONTEXT_STUDY_PLACE] ")
    .replace(/\b(?:students?|pupils?|scholars?|children|youth|candidates?|applicants?|patients?)\s+(?:of|from|in|at)\s+[^.;,\n]{0,80}\b(?:institutions?|colleges?|universit\w+|schools?|polytechnics?|training\s+centres?|hospitals?|laborator\w+)\b/gi, " [CONTEXT_STUDENT_INST] ")
    .replace(/\b(?:affiliated\s+(?:to|with)|recognized\s+by|approved\s+by|accredited\s+by)\s+[^.;,\n]{0,60}\b(?:aicte|ugc|board|state|central|university|cbse|icse|ncte|pci|dci)\b/gi, " [CONTEXT_ACCREDITATION] ")
    .replace(/\b(?:treatment\s+in|hospitalized\s+in|admitted\s+in)\s+[^.;,\n]{0,60}\b(?:hospitals?|laborator\w+|centres?)\b/gi, " [CONTEXT_TREATMENT_PLACE] ");

  // 2. Direct Institutional Beneficiary Check (Grants/Funds/Assistance TO Institutions)
  const isDirectInstitution =
    /\b(?:assistance|grants?|subsid\w+|funds?|support|aid|loans?|scheme|proposals?|applications?)\s+(?:for|to|provided\s+to|given\s+to)\s+(?:eligible\s+|registered\s+|recognized\s+|aicte\s+approved\s+|ugc\s+approved\s+)?(?:institutions?|colleges?|universit\w+|schools?|polytechnics?|training\s+institutes?|laborator\w+|hospitals?)\b/i.test(cleanText) ||
    /\b(?:institutions?|colleges?|universit\w+|schools?|polytechnics?)\s+(?:shall\s+be\s+eligible|can\s+apply|are\s+eligible|may\s+apply|must\s+be\s+accredited|must\s+submit|seeking\s+grant|eligible\s+for\s+grant)\b/i.test(cleanText) ||
    /\b(?:financial\s+assistance\s+to|scheme\s+for)\s+(?:upgrading|infrastructure|modernization|laboratories\s+of)\s+(?:institutions?|colleges?|universit\w+)\b/i.test(cleanText) ||
    /\b(aicte|ugc)\s+approved\s+(?:institutions?|colleges?|institutes?)\s+(?:are\s+eligible|can\s+apply|for\s+upgrading|to\s+establish)\b/i.test(cleanText);

  if (isDirectInstitution) {
    types.add("INSTITUTION");
  }

  // 3. Direct NGO / SHG / Voluntary Organization Beneficiary Check
  const isDirectNgo =
    /\b(?:assistance|grants?|subsid\w+|support|funds?|aid|scheme)\s+(?:for|to|provided\s+to|given\s+to)\s+(?:registered\s+|eligible\s+)?(?:ngos?|non[-\s]?governmental\s+organizations?|voluntary\s+organizations?|trusts?|societ\w+|self[-\s]?help\s+groups?|shgs?|cooperatives?|federations?|fpos?|producer\s+organizations?)\b/i.test(cleanText) ||
    /\b(?:ngos?|voluntary\s+organizations?|registered\s+societ\w+|trusts?|shgs?|self[-\s]?help\s+groups?|cooperatives?)\s+(?:can\s+apply|are\s+eligible|may\s+apply|must\s+be\s+registered|working\s+in)\b/i.test(cleanText);

  if (isDirectNgo) {
    types.add("NGO_SHG");
  }

  // 4. Direct Enterprise / Startup / MSME / Manufacturer Check
  const isDirectEnterprise =
    /\b(?:assistance|subsid\w+|incentives?|funds?|loans?|support|scheme)\s+(?:for|to|provided\s+to|given\s+to)\s+(?:eligible\s+|registered\s+|new\s+|existing\s+)?(?:start[-\s]?ups?|msmes?|micro\s+enterprises?|small\s+enterprises?|medium\s+enterprises?|industr\w+|manufacturing\s+units?|factories|companies|firms?|commercial\s+units?)\b/i.test(cleanText) ||
    /\b(?:start[-\s]?ups?|msmes?|industr\w+|manufacturing\s+units?|companies|firms?)\s+(?:can\s+apply|are\s+eligible|must\s+have\s+dpiit|registered\s+under\s+companies\s+act)\b/i.test(cleanText);

  if (isDirectEnterprise) {
    types.add("ENTERPRISE");
  }

  // 5. Direct Faculty / Researcher / Scientist Check
  const isDirectFaculty =
    /\b(?:fellowships?|grants?|awards?|assistance|scheme)\s+(?:for|to|tenable\s+for)\s+(?:regular\s+|permanent\s+|appointed\s+)?(?:facult\w+|teachers?|professors?|associate\s+professors?|assistant\s+professors?|lecturers?|scientists?|principal\s+investigators?|\bpi\b|researchers?|post[-\s]?doctoral|post[-\s]?docs?)\b/i.test(cleanText) ||
    /\b(?:facult\w+|teachers?|professors?|scientists?|principal\s+investigators?|researchers?|post[-\s]?docs?)\s+(?:working\s+in|holding\s+phd|can\s+apply|are\s+eligible)\b/i.test(cleanText);

  if (isDirectFaculty) {
    types.add("FACULTY_RESEARCHER");
  }

  // 6. Direct Student / Scholar Check
  const isDirectStudent =
    /\b(scholarships?|stipends?|free\s+coaching|hostel\s+subsidy|tuition\s+fee|education\s+loan|students?|pupils?|matric\w*|pre[-\s]?matric|post[-\s]?matric|class\s+\d+|under[-\s]?graduate|post[-\s]?graduate|degree|diploma|pursuing\s+education)\b/i.test(safe);

  if (isDirectStudent && !isDirectInstitution) {
    types.add("STUDENT");
  }

  // 7. Direct Farmer Check
  const isDirectFarmer =
    /\b(farmers?|kisan|cultivators?|agricultural\s+labourers?|landholders?|tenant\s+farmers?|crop\s+insurance|pm-kisan)\b/i.test(safe);

  if (isDirectFarmer) {
    types.add("FARMER");
  }

  return [...types];
}

function extractDeterministic(text) {
  const safe = String(text || "");

  // Empty / obviously-placeholder text bails out immediately.
  if (isProbablyUnknownText(safe)) {
    return {
      minAge: null, maxAge: null,
      minAnnualIncome: null, maxAnnualIncome: null,
      minMarksPercentage: null, minEducationLevel: null, maxEducationLevel: null,
      genders: [], categories: [], categoryGroups: [], occupations: [], applicantTypes: [], states: [],
      courses: [], disabilityRequired: null, minDisabilityPercentage: null,
      singleGirlChildRequired: null,
      source: "deterministic",
      eligibilityType: "unknown",
      confidence: 0.1,
      signals: 0,
      needsReview: false,
    };
  }

  const age = extractAge(safe);
  const income = extractIncome(safe);
  const genders = extractGenders(safe);
  const { groups: categoryGroups, flat: categories } = extractCategoryGroups(safe);
  const occupations = extractOccupations(safe);
  const states = extractStates(safe);
  const minEducationLevel = extractEducation(safe);
  const maxEducationLevel = extractMaxEducation(safe);
  const minMarksPercentage = extractMarks(safe);
  const courses = extractCourses(safe);
  const minDisabilityPercentage = extractDisabilityPercentage(safe);
  // A percentage threshold implies the requirement itself, even if the
  // generic disability phrasing wasn't separately matched.
  const disabilityRequired = extractDisabilityRequired(safe) || (minDisabilityPercentage !== null ? true : null);
  const singleGirlChildRequired = extractSingleGirlChild(safe);

  let signals = 0;
  if (age.minAge !== null || age.maxAge !== null) signals += 1;
  if (income.minAnnualIncome !== null || income.maxAnnualIncome !== null) signals += 1;
  if (genders.length) signals += 1;
  if (categories.length) signals += 1;
  if (occupations.length) signals += 1;
  if (states.length) signals += 1;
  if (minEducationLevel) signals += 1;
  if (maxEducationLevel) signals += 1;
  if (minMarksPercentage !== null) signals += 1;
  if (courses.length) signals += 1;
  if (disabilityRequired) signals += 1;
  if (singleGirlChildRequired) signals += 1;

  let eligibilityType = "constrained";
  let needsReview = false;
  if (signals === 0) {
    if (isProbablyUniversalLanguage(safe) && !hasUnrepresentedRestrictions(safe)) {
      eligibilityType = "universal";
    } else {
      eligibilityType = "unknown";
      if (hasUnrepresentedRestrictions(safe)) {
        needsReview = true;
      }
    }
  }

  // Confidence: 0.1 baseline + 0.15 per signal, capped at 0.9.
  const confidence = Math.min(0.9, 0.1 + 0.15 * signals);

  const applicantTypes = extractApplicantTypes(safe);
  if (applicantTypes.length > 0) signals++;

  return {
    ...age,
    ...income,
    minMarksPercentage,
    minEducationLevel,
    maxEducationLevel,
    genders,
    categories,
    categoryGroups,
    occupations,
    applicantTypes,
    states,
    courses,
    disabilityRequired,
    minDisabilityPercentage,
    singleGirlChildRequired,
    source: "deterministic",
    eligibilityType,
    confidence,
    signals,
    needsReview,
  };
}

module.exports = {
  extractDeterministic,
  extractAge,
  extractIncome,
  extractGenders,
  extractCategories,
  extractCategoryGroups,
  extractOccupations,
  extractApplicantTypes,
  extractStates,
  extractEducation,
  extractMaxEducation,
  extractMarks,
  extractCourses,
  extractDisabilityPercentage,
  extractDisabilityRequired,
  extractSingleGirlChild,
  isProbablyUniversalLanguage,
  isProbablyUnknownText,
  hasUnrepresentedRestrictions,
  parseIndianNumber,
  INDIAN_STATES,
};
