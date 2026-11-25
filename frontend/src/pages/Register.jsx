import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import "./Register.css";

const STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa",
  "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
  "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal",
  "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir",
  "Ladakh", "Lakshadweep", "Puducherry",
];

const OCCUPATIONS = [
  "Student", "Farmer", "Entrepreneur", "Salaried Employee", "Self-Employed",
  "Unemployed", "Homemaker", "Retired", "Artisan / Weaver", "Fisherman",
  "Construction Worker",
];

const EDUCATION_LEVELS = [
  "Below 10th", "10th Standard", "12th Standard", "Diploma",
  "Graduate", "Post Graduate", "Doctorate",
];

// Identity/eligibility tags — kept separate from occupation since a scheme
// can target either independently, and isMatch() checks both against the
// same flattened tag set.
const CATEGORY_OPTIONS = [
  "Woman", "SC", "ST", "OBC", "Minority", "BPL / Economically Weaker",
  "Person with Disability", "Senior Citizen", "Ex-Servicemen",
  "Migrant Worker", "Widow", "Single Parent",
];

const COURSE_OPTIONS = [
  "Computer Science", "Engineering", "Medicine", "Law", "Agriculture",
  "Arts", "Commerce", "Science", "Management", "Pharmacy",
  "Polytechnic / Diploma", "Vocational",
];

// Tri-state select for fields where "unanswered" must NOT default to
// false — see models/User.js. Empty string means "not answered" and is
// sent to the backend as `null`, never coerced to a boolean.
const TRISTATE_OPTIONS = [
  { value: "", label: "Prefer not to say / not sure" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];
function triStateToValue(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

const DOCUMENT_OPTIONS = [
  "Aadhaar Card", "PAN Card", "Income Certificate", "Caste Certificate",
  "Domicile Certificate", "BPL Card", "Disability Certificate",
  "Bank Passbook", "Educational Certificates", "Voter ID",
];

const EMPTY_FORM = {
  name: "",
  email: "",
  state: "",
  gender: "",
  age: "",
  occupation: "",
  annualIncome: "",
  categories: [],
  education: "",
  course: "",
  marksPercentage: "",
  disability: "",         // tri-state string: "", "true", "false"
  disabilityPercentage: "",
  singleGirlChild: "",    // tri-state string
  idLast4: "",
  documentsAvailable: [],
};

function toggleInList(list, value) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function Register() {
  // POST /users is gone. Account creation now goes through
  // POST /api/auth/register, which requires a password and returns a JWT —
  // the old anonymous upsert-by-email let anyone overwrite anyone's profile.
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ ...EMPTY_FORM, password: "", confirmPassword: "" });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle"); // idle | submitting | success | error
  const [serverError, setServerError] = useState("");

  function setField(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function validate() {
    const next = {};
    if (!form.name.trim()) next.name = "Enter your name.";
    if (!form.email.trim()) {
      next.email = "Enter your email.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      next.email = "Enter a valid email address.";
    }
    if (!form.password || form.password.length < 8) {
      // Mirrors the backend rule so the user is told before a round trip.
      next.password = "Choose a password of at least 8 characters.";
    }
    if (form.confirmPassword !== form.password) {
      next.confirmPassword = "Passwords do not match.";
    }
    if (!form.state) next.state = "Select your state.";
    if (form.annualIncome !== "" && Number(form.annualIncome) < 0) {
      next.annualIncome = "Income can't be negative.";
    }
    if (
      form.marksPercentage !== "" &&
      (Number(form.marksPercentage) < 0 || Number(form.marksPercentage) > 100)
    ) {
      next.marksPercentage = "Enter a percentage between 0 and 100.";
    }
    if (form.idLast4 && !/^\d{4}$/.test(form.idLast4)) {
      next.idLast4 = "Enter exactly 4 digits.";
    }
    if (
      form.disabilityPercentage !== "" &&
      (Number(form.disabilityPercentage) < 0 || Number(form.disabilityPercentage) > 100)
    ) {
      next.disabilityPercentage = "Enter a percentage between 0 and 100.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;

    setStatus("submitting");
    setServerError("");

    try {
      await register({
        email: form.email.trim(),
        password: form.password,
        name: form.name.trim(),
        profile: {
          state: form.state,
          gender: form.gender,
          age: form.age === "" ? null : Number(form.age),
          occupation: form.occupation,
          annualIncome: form.annualIncome === "" ? null : Number(form.annualIncome),
          categories: form.categories,
          education: form.education,
          course: form.course,
          marksPercentage: form.marksPercentage === "" ? null : Number(form.marksPercentage),
          disability: triStateToValue(form.disability),
          disabilityPercentage:
            form.disabilityPercentage === "" ? null : Number(form.disabilityPercentage),
          singleGirlChild: triStateToValue(form.singleGirlChild),
          idLast4: form.idLast4,
          documentsAvailable: form.documentsAvailable,
        },
      });
      setStatus("success");
      // register() has stored the JWT and set the user, so the protected
      // pages are reachable immediately.
      setTimeout(() => navigate("/matches", { replace: true }), 1200);
    } catch (err) {
      setStatus("error");
      setServerError(
        err.friendlyMessage ||
          err.response?.data?.error ||
          "Something went wrong creating your account. Please try again."
      );
    }
  }

  if (status === "success") {
    return (
      <div className="container register-page">
        <div className="register-success">
          <div className="version-dots" aria-hidden="true">
            <span className="dot" /><span className="dot" /><span className="dot" />
          </div>
          <h2>You're registered</h2>
          <p>
            We'll match <strong>{form.email}</strong> against new and updated schemes and
            email you when something fits your profile.
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setForm(EMPTY_FORM);
              setStatus("idle");
            }}
          >
            Register another profile
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container register-page">
      <header className="register-header">
        <h2>Register for scheme matching</h2>
        <p className="register-subtitle">
          Tell us a bit about yourself so we only email you about schemes you're likely
          eligible for. Every field below is optional except your name, email, and state —
          the more you fill in, the sharper the matching.
        </p>
      </header>

      <form onSubmit={handleSubmit} noValidate>
        <fieldset className="register-section">
          <legend>Basic details</legend>

          <div className="field-row">
            <label htmlFor="name">Full name</label>
            <input
              id="name"
              type="text"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
            />
            {errors.name && <span className="field-error">{errors.name}</span>}
          </div>

          <div className="field-row">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => setField("email", e.target.value)}
            />
            {errors.email && <span className="field-error">{errors.email}</span>}
          </div>

          {/* New in K0: the backend requires a password (bcrypt, min 8 chars).
              autoComplete="new-password" so a browser offers to generate one
              rather than autofilling an existing credential. */}
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setField("password", e.target.value)}
            />
            {errors.password && <span className="field-error">{errors.password}</span>}
          </div>

          <div className="field">
            <label htmlFor="confirmPassword">Confirm password</label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={(e) => setField("confirmPassword", e.target.value)}
            />
            {errors.confirmPassword && (
              <span className="field-error">{errors.confirmPassword}</span>
            )}
          </div>

          <div className="field-grid">
            <div className="field-row">
              <label htmlFor="state">State / UT</label>
              <select
                id="state"
                value={form.state}
                onChange={(e) => setField("state", e.target.value)}
              >
                <option value="">Select state</option>
                {STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              {errors.state && <span className="field-error">{errors.state}</span>}
            </div>

            <div className="field-row">
              <label htmlFor="gender">Gender</label>
              <select
                id="gender"
                value={form.gender}
                onChange={(e) => setField("gender", e.target.value)}
              >
                <option value="">Prefer not to say</option>
                <option value="Female">Female</option>
                <option value="Male">Male</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          <div className="field-grid">
            <div className="field-row">
              <label htmlFor="age">Age</label>
              <input
                id="age"
                type="number"
                min="0"
                max="120"
                inputMode="numeric"
                value={form.age}
                onChange={(e) => setField("age", e.target.value)}
              />
              <span className="field-hint">
                Used to match age-gated schemes (senior, youth, etc). Optional.
              </span>
            </div>
          </div>
        </fieldset>

        <fieldset className="register-section">
          <legend>Eligibility profile</legend>

          <div className="field-grid">
            <div className="field-row">
              <label htmlFor="occupation">Occupation</label>
              <select
                id="occupation"
                value={form.occupation}
                onChange={(e) => setField("occupation", e.target.value)}
              >
                <option value="">Select occupation</option>
                {OCCUPATIONS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>

            <div className="field-row">
              <label htmlFor="annualIncome">Annual income (₹)</label>
              <input
                id="annualIncome"
                type="number"
                min="0"
                inputMode="numeric"
                value={form.annualIncome}
                onChange={(e) => setField("annualIncome", e.target.value)}
              />
              {errors.annualIncome && <span className="field-error">{errors.annualIncome}</span>}
            </div>
          </div>

          <div className="field-grid">
            <div className="field-row">
              <label htmlFor="education">Education level</label>
              <select
                id="education"
                value={form.education}
                onChange={(e) => setField("education", e.target.value)}
              >
                <option value="">Select education level</option>
                {EDUCATION_LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
              </select>
            </div>

            <div className="field-row">
              <label htmlFor="course">Course / stream</label>
              <select
                id="course"
                value={form.course}
                onChange={(e) => setField("course", e.target.value)}
              >
                <option value="">Select course / stream (if applicable)</option>
                {COURSE_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div className="field-row">
              <label htmlFor="marksPercentage">Marks percentage (latest)</label>
              <input
                id="marksPercentage"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.marksPercentage}
                onChange={(e) => setField("marksPercentage", e.target.value)}
              />
              {errors.marksPercentage && (
                <span className="field-error">{errors.marksPercentage}</span>
              )}
            </div>
          </div>

          <div className="field-grid">
            <div className="field-row">
              <label htmlFor="disability">Person with disability?</label>
              <select
                id="disability"
                value={form.disability}
                onChange={(e) => setField("disability", e.target.value)}
              >
                {TRISTATE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {form.disability === "true" && (
              <div className="field-row">
                <label htmlFor="disabilityPercentage">Disability percentage</label>
                <input
                  id="disabilityPercentage"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={form.disabilityPercentage}
                  onChange={(e) => setField("disabilityPercentage", e.target.value)}
                />
                {errors.disabilityPercentage && (
                  <span className="field-error">{errors.disabilityPercentage}</span>
                )}
              </div>
            )}

            <div className="field-row">
              <label htmlFor="singleGirlChild">Single girl child of the family?</label>
              <select
                id="singleGirlChild"
                value={form.singleGirlChild}
                onChange={(e) => setField("singleGirlChild", e.target.value)}
              >
                {TRISTATE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="field-row">
            <span className="checklist-label">Categories that apply to you</span>
            <div className="checklist-grid">
              {CATEGORY_OPTIONS.map((cat) => (
                <label key={cat} className="checklist-item">
                  <input
                    type="checkbox"
                    checked={form.categories.includes(cat)}
                    onChange={() => setField("categories", toggleInList(form.categories, cat))}
                  />
                  {cat}
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        <fieldset className="register-section">
          <legend>Documents</legend>

          <div className="field-row">
            <label htmlFor="idLast4">Last 4 digits of a govt ID (e.g. Aadhaar)</label>
            <input
              id="idLast4"
              type="text"
              inputMode="numeric"
              maxLength={4}
              placeholder="1234"
              value={form.idLast4}
              onChange={(e) => setField("idLast4", e.target.value.replace(/\D/g, ""))}
            />
            <span className="field-hint">
              For reference only — we never ask for or store your full ID number.
            </span>
            {errors.idLast4 && <span className="field-error">{errors.idLast4}</span>}
          </div>

          <div className="field-row">
            <span className="checklist-label">Documents you already have</span>
            <div className="checklist-grid">
              {DOCUMENT_OPTIONS.map((doc) => (
                <label key={doc} className="checklist-item">
                  <input
                    type="checkbox"
                    checked={form.documentsAvailable.includes(doc)}
                    onChange={() =>
                      setField("documentsAvailable", toggleInList(form.documentsAvailable, doc))
                    }
                  />
                  {doc}
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        {status === "error" && <p className="form-error-banner">{serverError}</p>}

        <button type="submit" className="btn-primary" disabled={status === "submitting"}>
          {status === "submitting" ? "Saving..." : "Save profile"}
        </button>
      </form>
    </div>
  );
}