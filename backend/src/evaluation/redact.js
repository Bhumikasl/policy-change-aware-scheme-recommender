/**
 * SECRET REDACTION for evaluation output.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * Phase P writes files: a results JSON and a human-review file that a person
 * will open, annotate and quite possibly attach to a thesis appendix or paste
 * into an email. Those files carry provider names, model identifiers and —
 * critically — error strings from provider SDKs.
 *
 * A provider error is the likeliest place a credential appears in this system.
 * A 401 from an SDK routinely echoes the request, and the request carries the
 * key. Nothing else in the pipeline writes provider errors to a shareable file,
 * so this is a new exposure introduced by this phase, and it is closed here.
 *
 * Two mechanisms, because either alone is insufficient:
 *
 *   1. KEY-NAME redaction — any field whose NAME looks like a credential is
 *      replaced wholesale, whatever it contains. Catches a key in a field the
 *      value patterns miss.
 *   2. VALUE-PATTERN redaction — known credential shapes are scrubbed from any
 *      string. Catches a key embedded in prose, which is exactly how it
 *      arrives inside an error message.
 */

/**
 * Credential shapes. Deliberately broad: a false positive costs a redacted
 * string in a research artefact; a false negative costs a leaked key.
 */
const SECRET_PATTERNS = [
  // generic "key=value" / "token: value"
  /\b(sk|gsk|api|key|token|bearer|secret|password)[-_a-z0-9]*\s*[=:]\s*["']?[A-Za-z0-9_\-\.]{12,}["']?/gi,
  /\bAIza[0-9A-Za-z_\-]{20,}\b/g, // Google
  /\bgsk_[0-9A-Za-z]{20,}\b/g, // Groq
  /\bsk-[0-9A-Za-z]{20,}\b/g, // OpenAI-style
  /mongodb(\+srv)?:\/\/[^\s"']+/gi, // connection strings carry credentials
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+/g, // JWT
  /\bBearer\s+[A-Za-z0-9_\-\.]{16,}/gi,
];

/** Field names that are replaced wholesale, regardless of content. */
const SECRET_KEY_NAMES =
  /^(api[_-]?key|apikey|secret|password|passwd|token|authorization|auth|credential|credentials|connection[_-]?string|mongodb_uri|jwt[_-]?secret|smtp[_-]?app[_-]?password)$/i;

const PLACEHOLDER = "[REDACTED]";

/** Scrub credential shapes out of one string. */
function redactString(text) {
  let out = String(text);
  for (const p of SECRET_PATTERNS) out = out.replace(p, PLACEHOLDER);
  return out;
}

/**
 * Deep-redact any value.
 *
 * Cycle-safe: an object graph with a back-reference would otherwise recurse
 * forever, and the harness stores nested result objects.
 */
function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_NAMES.test(k) ? PLACEHOLDER : redact(v, seen);
  }
  return out;
}

module.exports = { redact, redactString, SECRET_PATTERNS, SECRET_KEY_NAMES, PLACEHOLDER };
