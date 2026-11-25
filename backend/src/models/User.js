const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { ROLES } = { ROLES: { USER: "USER", ADMIN: "ADMIN" } };

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },

    // Stored lowercased so the ownership check in middleware/auth.js and the
    // unique index both behave predictably.
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // bcrypt hash. `select: false` keeps it out of every query result unless
    // explicitly requested with .select("+passwordHash") — so it cannot leak
    // through res.json(user), which is exactly how POST /api/users used to
    // return the whole document.
    passwordHash: { type: String, default: "", select: false },

    role: { type: String, enum: Object.values(ROLES), default: ROLES.USER, index: true },

    fcmToken: { type: String, default: "" }, // push notifications, later

    // Per-user notification controls (Phase L).
    notificationPrefs: {
      email: { type: Boolean, default: true },
      // Separate switch on purpose: turning off email must not silence the
      // in-app inbox. They are different levels of interruption, and a user
      // who wants to stop the mail usually still wants the record.
      inApp: { type: Boolean, default: true },
      // Minimum policy-change severity that earns an email.
      minSeverity: {
        type: String,
        enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
        default: "MEDIUM",
      },
      unsubscribedAt: { type: Date, default: null },
    },

    profile: {
      state: { type: String, default: "", index: true },
      gender: { type: String, default: "" },
      age: { type: Number, default: null, index: true },
      occupation: { type: String, default: "" },
      // Indexed because PolicyImpactAgent issues targeted range queries such
      // as { "profile.annualIncome": { $gt: 250000, $lte: 300000 } } to find
      // exactly the users a threshold change affects, instead of scanning all.
      annualIncome: { type: Number, default: null, index: true },
      // NOT indexed: PolicyImpactAgent's category-rule diffs always fall back
      // to a full scan (deriveCandidateFilter in policyImpactAgent.js — "AND
      // -of-OR groups... there is no sound narrow query here"), so no
      // production code ever queries `profile.categories` directly. An index
      // here would only pay the write-amplification cost of indexing an
      // array field on every user document for zero read benefit.
      categories: { type: [String], default: [] },
      education: { type: String, default: "" },
      // Course/stream of study (e.g. "Computer Science", "Agriculture").
      // Only meaningful alongside `education`; used to match schemes that
      // are restricted to a specific stream ("engineering students",
      // "medical students") rather than education level alone.
      course: { type: String, default: "" },
      marksPercentage: { type: Number, default: null },
      // Tri-state by construction: `null`/unset means "not answered", which
      // the matcher must treat as NEEDS_MORE_INFORMATION, never as `false`.
      // Never default this to `false` — that would silently fail every
      // disability-restricted scheme for a user who simply hasn't answered.
      disability: { type: Boolean, default: null },
      disabilityPercentage: { type: Number, default: null },
      // Same tri-state rule as `disability` above.
      singleGirlChild: { type: Boolean, default: null },
      // Reference only - never store a full Aadhaar/govt ID number.
      idLast4: { type: String, default: "" },
      documentsAvailable: { type: [String], default: [] },
    },
  },
  { timestamps: true }
);

// Compound index for the common impact query "users in state X within an
// income band" — the two attributes changed thresholds most often touch.
UserSchema.index({ "profile.state": 1, "profile.annualIncome": 1 });

UserSchema.methods.setPassword = async function setPassword(plain) {
  if (!plain || plain.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  this.passwordHash = await bcrypt.hash(plain, 12);
};

UserSchema.methods.verifyPassword = async function verifyPassword(plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

/** Shape that is always safe to return over the API. */
UserSchema.methods.toSafeJSON = function toSafeJSON() {
  const o = this.toObject();
  delete o.passwordHash;
  delete o.__v;
  return o;
};

module.exports = mongoose.model("User", UserSchema);
module.exports.ROLES = ROLES;
