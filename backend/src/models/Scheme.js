const mongoose = require("mongoose");

/**
 * Structured eligibility. This is the schema the isMatch rules engine
 * actually reasons over — the free-text `eligibility` field is kept only
 * for display. Every field is optional/nullable: a null means "the source
 * did not specify this constraint", which the engine treats as "no
 * restriction", NOT as "matches everyone regardless".
 *
 * `source` records where the rules came from:
 *   - "structured"    : populated from myScheme's structured API fields
 *                        (basicDetails, eligibilityCriteria, beneficiaryState,
 *                        tags). Highest confidence.
 *   - "llm-extracted" : Gemini parsed the free-text eligibility string into
 *                        this shape. Confidence usually 0.4–0.8.
 *   - "unparsed"      : we have not yet extracted rules for this scheme;
 *                        rules engine falls back to legacy tag/state
 *                        matching for these.
 */
const EligibilityRulesSchema = new mongoose.Schema(
  {
    minAge: { type: Number, default: null },
    maxAge: { type: Number, default: null },
    maxAnnualIncome: { type: Number, default: null },
    minAnnualIncome: { type: Number, default: null },
    minMarksPercentage: { type: Number, default: null },
    minEducationLevel: { type: String, default: null }, // one of the ranked EDUCATION_LEVELS keys
    // Ceiling on education — schemes for students "up to" a level (e.g. a
    // pre-matric scholarship that stops applying once someone has a degree).
    // Same ranked EDUCATION_LEVELS keys as minEducationLevel.
    maxEducationLevel: { type: String, default: null },
    // Course/stream restriction, e.g. ["Computer Science", "Engineering"].
    // [] = no course restriction (open to any stream).
    courses: { type: [String], default: [] },
    // Disability requirements. `disabilityRequired: true` means the scheme
    // is restricted to persons with disabilities; `minDisabilityPercentage`
    // is an additional threshold some schemes specify (e.g. "40% or more
    // disability"). Both are independently nullable: a scheme can require
    // disability status without a percentage threshold.
    disabilityRequired: { type: Boolean, default: null },
    minDisabilityPercentage: { type: Number, default: null },
    // Schemes restricted to a family's single/only girl child.
    singleGirlChildRequired: { type: Boolean, default: null },
    genders: { type: [String], default: [] },       // e.g. ["Female"]; [] = no gender constraint
    categories: { type: [String], default: [] },    // e.g. ["SC","OBC","Woman","BPL"] — flat union, kept for display / legacy
    // Structured category requirements: an array of OR-groups. Match rule is
    // "user must have at least one keyword from EACH group" (AND-of-OR).
    //
    // Examples:
    //   "SC/ST/OBC candidates"         → [["SC","ST","OBC"]]
    //   "physically disabled students" → [["Person with Disability"]] plus
    //                                    occupations:["Student"]
    //   "SC women below poverty line"  → [["SC"], ["Widow"|"Woman"], ["BPL"]]
    //
    // A scheme that reads "SC OR ST students from BPL families" therefore
    // becomes [["SC","ST"], ["BPL"]] and REJECTS a plain "Student" user who
    // only has BPL (no SC/ST) — the "PwD student" case the reviewer raised.
    categoryGroups: { type: [[String]], default: [] },
    occupations: { type: [String], default: [] },   // e.g. ["Student","Farmer"]
    // Target applicant entity types, e.g. ["INSTITUTION", "NGO_SHG", "ENTERPRISE", "FACULTY_RESEARCHER", "STUDENT", "FARMER", "INDIVIDUAL"].
    // [] = no entity restriction (general individual applicants).
    applicantTypes: { type: [String], default: [] },
    states: { type: [String], default: [] },        // [] = All-India
    source: {
      type: String,
      enum: ["structured", "llm-extracted", "deterministic", "unparsed"],
      default: "unparsed",
    },
    // The classifier's read of the scheme's targeting:
    //   universal   — open to everyone in a jurisdiction (subject only to
    //                  state constraints if any). Match if no failures.
    //   constrained — at least one restrictive rule was extracted. Requires
    //                  a positive signal from the user to match.
    //   unknown     — text is missing/placeholder and nothing was parsed.
    //                  Excluded from /matches unless the caller opts in.
    eligibilityType: {
      type: String,
      enum: ["universal", "constrained", "unknown"],
      default: "unknown",
    },
    confidence: { type: Number, default: 0 }, // 0–1
    // Set by the hybrid extractor when deterministic and LLM disagreed on
    // a numeric field, when confidence is < 0.5, or when eligibilityType
    // couldn't be resolved. UI/admin flow can filter on this.
    needsReview: { type: Boolean, default: false },
    extractedAt: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * This is the CURRENT (latest known) version of a scheme.
 * Every field here is what the Comparator diffs against on each collection run.
 * Keep this schema in sync with normalizer/normalizer.js — the normalizer is the
 * only thing that should ever be allowed to write into this shape.
 */
const SchemeSchema = new mongoose.Schema(
  {
    schemeId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    eligibility: { type: String, default: "" }, // free-text, DISPLAY only
    eligibilityRules: { type: EligibilityRulesSchema, default: () => ({}) }, // structured, used by isMatch
    benefits: { type: String, default: "" },
    documents: { type: [String], default: [] },
    lastDate: { type: String, default: "" },
    applicationLink: { type: String, default: "" },
    ministry: { type: String, default: "" },
    state: { type: String, default: "All India" }, // legacy display string; matching uses eligibilityRules.states
    category: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    status: { type: String, default: "Active" },
    source: { type: String, required: true },
    sourceUrl: { type: String, default: "" },
    version: { type: Number, default: 1 },
    contentHash: { type: String, required: true },
    firstSeenAt: { type: Date, default: Date.now },
    lastCheckedAt: { type: Date, default: Date.now },
    lastUpdatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Scheme", SchemeSchema);
