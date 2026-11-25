/**
 * PHASE W — the public shape of scheme and scheme-history documents.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `routes/schemes.js` had four unauthenticated endpoints that answered with
 * `res.json(doc)` on a raw Mongoose document. That was harmless when it was
 * written: a scheme row held scheme facts, and a history row held a version,
 * an event type and a diff.
 *
 * Then the model grew. Phase J added the policy-stage statuses, the retry flag
 * and `policyProcessing`. Phase M added `ragIndexStatus`, `ragIndexRetryable`
 * and `ragIndexing`. Both are written by `policyPipeline.persistStatus`, and
 * both carry operational detail — job ids, candidate-selection modes, how many
 * users a change moved, and the **provider error messages** from the LLM and
 * embedding calls.
 *
 * Nobody revisited the routes. `res.json(history)` kept meaning "everything on
 * the row", so each new internal field joined the public response the moment it
 * was added, silently and with no code change at the boundary.
 *
 * ---------------------------------------------------------------------------
 * ALLOWLIST, NOT DENYLIST
 * ---------------------------------------------------------------------------
 * A denylist would have exactly the failure mode above: it is correct on the
 * day it is written and wrong the next time the model grows, because a new
 * field is public by default. An allowlist fails the other way — a new field is
 * withheld until someone decides otherwise, and the Phase W audit
 * (`npm run evaluate:exposure`) reports it as undeclared rather than leaking it.
 *
 * The list below is therefore the whole contract. If a field is not named here,
 * it does not leave the process.
 *
 * ---------------------------------------------------------------------------
 * THE COUNTERWEIGHT
 * ---------------------------------------------------------------------------
 * Withholding everything would satisfy confinement and break the product. The
 * audit checks both directions: nothing internal escapes, AND every field the
 * frontend actually reads is still present. Neither property alone is a
 * specification — a projection has to be squeezed from both sides.
 */

/** Mongoose doc or plain object, indifferently. */
function toPlain(doc) {
  return doc && typeof doc.toObject === "function" ? doc.toObject() : doc || {};
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Scheme fields a caller may see.
 *
 * `version`, `source`, `sourceUrl`, `firstSeenAt` and `lastUpdatedAt` stay:
 * they are provenance, the detail page renders them, and a citizen reading a
 * scheme is entitled to know where it came from and when it last moved.
 *
 * `contentHash` does not. It is the change detector's own fingerprint — an
 * internal artifact of the mechanism Phase V measures, not a fact about the
 * policy — and publishing it would let anyone watch the system's private
 * "nothing material changed" decisions from outside.
 *
 * `lastCheckedAt` does not either: it describes the crawler's schedule rather
 * than the scheme, and it is the field an abuser would use to time a run.
 */
const SCHEME_PUBLIC_FIELDS = Object.freeze([
  "schemeId",
  "name",
  "description",
  "eligibility",
  "eligibilityRules",
  "benefits",
  "documents",
  "lastDate",
  "applicationLink",
  "ministry",
  "state",
  "category",
  "tags",
  "status",
  "source",
  "sourceUrl",
  "version",
  "firstSeenAt",
  "lastUpdatedAt",
]);

/**
 * Eligibility rule fields a caller may see.
 *
 * The rules themselves are public policy — thresholds, categories, the
 * eligibility type the matcher branches on. What is withheld is the metadata
 * about HOW we obtained them: `source`, `confidence`, `needsReview` and
 * `extractedAt` describe our extraction pipeline's own uncertainty. They belong
 * on an admin review queue, which is what the model comment says they are for.
 */
const ELIGIBILITY_RULE_PUBLIC_FIELDS = Object.freeze([
  "minAge",
  "maxAge",
  "maxAnnualIncome",
  "minAnnualIncome",
  "minMarksPercentage",
  "minEducationLevel",
  "maxEducationLevel",
  "courses",
  "disabilityRequired",
  "minDisabilityPercentage",
  "singleGirlChildRequired",
  "genders",
  "categories",
  "categoryGroups",
  "occupations",
  "applicantTypes",
  "states",
  "eligibilityType",
]);

/**
 * History fields a caller may see: what changed, when, and in plain language.
 *
 * Everything the pipeline stamps on the row afterwards is withheld. The
 * snapshot is reduced to the scheme's name — the activity feed renders that and
 * nothing else from it, and the full snapshot is a second copy of the scheme
 * document including its contentHash.
 */
const HISTORY_PUBLIC_FIELDS = Object.freeze([
  "schemeId",
  "version",
  "eventType",
  "aiSummary",
  "createdAt",
]);

/** Diff entries are already the public story of a change: field, before, after. */
const DIFF_PUBLIC_FIELDS = Object.freeze(["field", "oldValue", "newValue"]);

function toPublicEligibilityRules(rules) {
  if (!rules) return undefined;
  return pick(toPlain(rules), ELIGIBILITY_RULE_PUBLIC_FIELDS);
}

/** One scheme, as an unauthenticated caller may see it. */
function toPublicScheme(doc) {
  const plain = toPlain(doc);
  const out = pick(plain, SCHEME_PUBLIC_FIELDS);
  if (plain.eligibilityRules !== undefined) {
    out.eligibilityRules = toPublicEligibilityRules(plain.eligibilityRules);
  }
  return out;
}

/**
 * One history row, as an unauthenticated caller may see it.
 *
 * `snapshot` is deliberately narrowed to `{ name }` rather than dropped: the
 * activity feed labels each row with the scheme's name at that version, which
 * is not always the current name, so it cannot be recovered from the Scheme
 * collection.
 */
function toPublicHistoryEntry(doc) {
  const plain = toPlain(doc);
  const out = pick(plain, HISTORY_PUBLIC_FIELDS);
  out.diffs = (plain.diffs || []).map((d) => pick(toPlain(d), DIFF_PUBLIC_FIELDS));
  const snapshotName = toPlain(plain.snapshot).name;
  if (snapshotName !== undefined) out.snapshot = { name: snapshotName };
  return out;
}

const toPublicSchemes = (docs) => (docs || []).map(toPublicScheme);
const toPublicHistory = (docs) => (docs || []).map(toPublicHistoryEntry);

module.exports = {
  toPublicScheme,
  toPublicSchemes,
  toPublicHistoryEntry,
  toPublicHistory,
  toPublicEligibilityRules,
  SCHEME_PUBLIC_FIELDS,
  ELIGIBILITY_RULE_PUBLIC_FIELDS,
  HISTORY_PUBLIC_FIELDS,
  DIFF_PUBLIC_FIELDS,
};
