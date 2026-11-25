/**
 * PHASE X — the corpus the three recommendation surfaces are compared over.
 *
 * Built to make the ways they can disagree DECIDABLE rather than to be large.
 * Two axes matter:
 *
 *   1. Cases where a candidate field the ranker reads is the deciding signal.
 *      A dropped field scores zero rather than throwing, so a divergence only
 *      becomes visible when that term is what separates two schemes. Every
 *      other corpus in this project — Q's, R's, T's — happens not to contain
 *      such a case, which is why 957 tests passed with the surfaces disagreeing.
 *
 *   2. Cases on the boundary of the status gate. `isActive` accepts "active" in
 *      any casing and a blank status; an exact `status: "Active"` query does
 *      not. The two differ only on rows a single collector does not currently
 *      produce, which is what makes it a latent divergence rather than a
 *      visible one — and exactly the kind that surfaces after a second source
 *      is added.
 */

const rules = (over = {}) => ({
  minAge: null,
  maxAge: null,
  maxAnnualIncome: null,
  minAnnualIncome: null,
  minMarksPercentage: null,
  minEducationLevel: null,
  genders: [],
  categories: [],
  categoryGroups: [],
  occupations: [],
  states: [],
  source: "structured",
  eligibilityType: "constrained",
  confidence: 0.5,
  needsReview: false,
  extractedAt: null,
  ...over,
});

const scheme = (schemeId, over = {}) => ({
  schemeId,
  name: schemeId,
  description: "",
  eligibility: "",
  benefits: "Rs 10000 per year",
  documents: [],
  lastDate: "",
  applicationLink: "",
  ministry: "Education",
  state: "Kerala",
  category: [],
  tags: [],
  status: "Active",
  ...over,
  eligibilityRules: rules(over.eligibilityRules || {}),
});

const KERALA = { states: ["Kerala"] };

/**
 * Scheme universes. Each is a complete world the three surfaces rank
 * independently.
 */
const UNIVERSES = Object.freeze([
  {
    label: "document readiness is the deciding signal",
    /**
     * Two schemes identical in every ranking term except the documents they
     * demand. The user holds the papers for one and not the other, so the
     * readiness term (0 .. 1.5) is the only thing separating them — and a
     * surface that drops `documentReadiness` ties them and falls through to
     * the Phase T schemeId tie-break, which orders them alphabetically:
     * the wrong one first.
     */
    schemes: [
      scheme("a-papers-ready", { documents: ["Aadhaar Card", "Income Certificate"], eligibilityRules: KERALA }),
      scheme("b-papers-missing", { documents: ["Caste Certificate", "Disability Certificate"], eligibilityRules: KERALA }),
    ],
  },
  {
    label: "readiness reversed against alphabetical order",
    /**
     * The same test with the names swapped. Without this, a surface that
     * dropped the field could still produce the right order by accident,
     * because alphabetical and correct happened to coincide.
     */
    schemes: [
      scheme("a-papers-missing", { documents: ["Caste Certificate", "Disability Certificate"], eligibilityRules: KERALA }),
      scheme("b-papers-ready", { documents: ["Aadhaar Card", "Income Certificate"], eligibilityRules: KERALA }),
    ],
  },
  {
    label: "partial readiness between two extremes",
    schemes: [
      scheme("all-three", { documents: ["Aadhaar Card", "Income Certificate", "Domicile Certificate"], eligibilityRules: KERALA }),
      scheme("two-of-three", { documents: ["Aadhaar Card", "Income Certificate", "Caste Certificate"], eligibilityRules: KERALA }),
      scheme("none-held", { documents: ["Caste Certificate"], eligibilityRules: KERALA }),
    ],
  },
  {
    label: "status gate boundaries",
    schemes: [
      scheme("status-titlecase", { status: "Active", eligibilityRules: KERALA }),
      scheme("status-lowercase", { status: "active", eligibilityRules: KERALA }),
      scheme("status-blank", { status: "", eligibilityRules: KERALA }),
      scheme("status-closed", { status: "Closed", eligibilityRules: KERALA }),
    ],
  },
  {
    label: "eligibility types side by side",
    schemes: [
      scheme("universal-open", { state: "All India", eligibilityRules: { eligibilityType: "universal" } }),
      scheme("constrained-kerala", { eligibilityRules: { ...KERALA, eligibilityType: "constrained" } }),
      scheme("unknown-unparsed", { eligibilityRules: { ...KERALA, eligibilityType: "unknown", source: "unparsed" } }),
    ],
  },
  {
    label: "mixed universe",
    schemes: [
      scheme("m-ready-kerala", { documents: ["Aadhaar Card"], eligibilityRules: KERALA }),
      scheme("m-unready-kerala", { documents: ["Caste Certificate"], eligibilityRules: KERALA }),
      scheme("m-universal", { state: "All India", documents: ["Aadhaar Card"], eligibilityRules: { eligibilityType: "universal" } }),
      scheme("m-closed", { status: "Closed", documents: ["Aadhaar Card"], eligibilityRules: KERALA }),
      scheme("m-other-state", { eligibilityRules: { states: ["Tamil Nadu"] } }),
    ],
  },
]);

/**
 * Users chosen so the document-readiness term takes several distinct values —
 * holding everything, holding some, holding none — and so that at least one
 * user is ineligible for part of every universe.
 */
const USERS = Object.freeze([
  {
    label: "holds every common document",
    user: {
      _id: "u-full",
      email: "full@example.test",
      profile: {
        state: "Kerala", age: 24, annualIncome: 150000, occupation: "Student",
        education: "Graduate", gender: "Female", categories: [], marksPercentage: 70,
        documentsAvailable: ["Aadhaar Card", "Income Certificate", "Domicile Certificate"],
      },
    },
  },
  {
    label: "holds one document",
    user: {
      _id: "u-partial",
      email: "partial@example.test",
      profile: {
        state: "Kerala", age: 31, annualIncome: 240000, occupation: "Farmer",
        education: "12th Standard", gender: "Male", categories: ["SC"], marksPercentage: 55,
        documentsAvailable: ["Aadhaar Card"],
      },
    },
  },
  {
    label: "holds no documents",
    user: {
      _id: "u-none",
      email: "none@example.test",
      profile: {
        state: "Kerala", age: 45, annualIncome: 90000, occupation: "Student",
        education: "Post Graduate", gender: "Female", categories: [], marksPercentage: 88,
        documentsAvailable: [],
      },
    },
  },
  {
    label: "outside the state most schemes target",
    user: {
      _id: "u-outside",
      email: "outside@example.test",
      profile: {
        state: "Tamil Nadu", age: 28, annualIncome: 300000, occupation: "Student",
        education: "Graduate", gender: "Male", categories: [], marksPercentage: 61,
        documentsAvailable: ["Aadhaar Card", "Income Certificate"],
      },
    },
  },
]);

module.exports = { UNIVERSES, USERS, scheme, rules };
