const User = require("../models/User");
const { evaluateEligibility, getDocumentReadiness } = require("../services/matcher");
const { EDUCATION_LEVELS, EDUCATION_RANK } = require("../services/eligibilityLevels");
const { CHANGE_TYPES } = require("./policyChangeAgent");
const logger = require("../utils/logger");

/**
 * AGENT 2 — POLICY IMPACT AGENT
 *
 * Question it answers: *which specific people does this change actually move,
 * and in which direction?*
 *
 * This is the piece that distinguishes the system from a scheme search engine.
 * A search engine answers "who matches today". This answers "whose answer is
 * different from yesterday, and because of what".
 *
 * ---------------------------------------------------------------------------
 * THE IDEA
 * ---------------------------------------------------------------------------
 * The naive way to find affected users after a policy edit is to re-evaluate
 * every user against the changed scheme: O(users) matcher runs per changed
 * scheme, per collection cycle.
 *
 * But the diff already tells us where the boundary moved. If maxAnnualIncome
 * went 250000 -> 300000, then the ONLY people whose verdict can differ are
 * those earning more than 250000 and at most 300000. Everyone below 250000
 * passed the income rule before and passes it now; everyone above 300000
 * failed before and fails now. Neither group's verdict can have changed,
 * because no other rule moved.
 *
 * So we translate the diff into a MongoDB filter over the indexed profile
 * fields and re-evaluate only the users inside the moved band.
 *
 * ---------------------------------------------------------------------------
 * SOUNDNESS IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * A candidate filter that is too WIDE costs time. A filter that is too NARROW
 * silently drops people who should have been told they lost a benefit. Those
 * failures are not symmetric, so every narrowing below is justified explicitly,
 * and anything that cannot be justified falls back to a full scan rather than
 * guessing.
 *
 * ---------------------------------------------------------------------------
 * THE RESULT CONTRACT — READ THIS BEFORE USING THE OUTPUT
 * ---------------------------------------------------------------------------
 * An earlier version of this file reported a single `exhaustive` boolean, where
 * `exhaustive: false` meant "we fell back to scanning every user". That naming
 * was actively misleading: a full scan is the MOST complete thing this agent
 * can do, yet it was the case flagged false. Anyone reading the field as
 * "did we cover everyone?" would have drawn the exact opposite conclusion.
 *
 * The flag is gone. Completeness and narrowing are two different questions and
 * now have two different fields:
 *
 *   candidateSelection  HOW the candidate set was chosen:
 *       "targeted-band"   one provably-complete band over an indexed field
 *       "targeted-union"  an $or of provably-complete bands
 *       "full-scan"       every user in the collection
 *       "none"            nothing comparable changed; nobody selected
 *       "skipped"         the change cannot affect any user; no query issued
 *
 *   scannedEveryUser    true when candidateSelection is "full-scan".
 *
 *   narrowingProven     true when we examined strictly fewer than all users and
 *                       that was provably safe. false means we could not prove
 *                       a narrower set and scanned everyone instead. It never
 *                       means the result is partial.
 *
 *   completenessGuaranteed
 *                       true when the candidate set provably contains every
 *                       user whose eligibility verdict could differ. Derived
 *                       from COMPLETE_SELECTIONS below, NOT hardcoded: a future
 *                       mode that knowingly samples reports false unless it is
 *                       deliberately added to that set. It is true on every
 *                       path the agent currently takes, because every current
 *                       path is complete — a proven band, a full scan, and an
 *                       empty set arrived at for a proven reason all are.
 *
 * All four come from contractFor() so the two call sites cannot disagree.
 *
 * The three questions a caller actually asks map one-to-one:
 *   "Did it target a subset?"                 candidateSelection.startsWith("targeted")
 *   "Did it scan everyone?"                   scannedEveryUser
 *   "Could it prove a narrower set was safe?" narrowingProven
 *
 * Two cases that look narrowable but are NOT:
 *
 *   1. A rule APPEARING or DISAPPEARING (null <-> value). Adding a rule does
 *      not only exclude people outside the new bound; for a `constrained`
 *      scheme, matcher.js requires at least one positive match, so adding a
 *      rule can also give someone their first positive and make them eligible.
 *      Both effects reach outside any band, so the candidate set is everyone.
 *
 *   2. CATEGORY changes. Categories are AND-of-OR, plus matcher.js bridges
 *      gender=female to the "woman" category. Restructuring the groups can
 *      flip a user whose own categories appear in both the old and the new
 *      lists, so a symmetric-difference query is unsound here.
 *
 * When several fields change at once, the candidate set is the UNION of the
 * per-field bands: a user's overall verdict can only move if at least one
 * changed rule moved for them. If any single field is unbandable, the union
 * degrades to a full scan.
 */

const TRANSITIONS = Object.freeze({
  NEWLY_ELIGIBLE: "NEWLY_ELIGIBLE",
  NO_LONGER_ELIGIBLE: "NO_LONGER_ELIGIBLE",
  STILL_ELIGIBLE_CHANGED: "STILL_ELIGIBLE_CHANGED",
  UNCHANGED: "UNCHANGED",
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const asArr = (v) => (Array.isArray(v) ? v : []);

/** The five ways a candidate set can be chosen. */
const CANDIDATE_SELECTION = Object.freeze({
  TARGETED_BAND: "targeted-band",
  TARGETED_UNION: "targeted-union",
  FULL_SCAN: "full-scan",
  NONE: "none",
  SKIPPED: "skipped",
});

/**
 * The candidate-selection modes whose completeness has been ARGUED, not
 * assumed. Membership here is the claim that the mode returns every user whose
 * verdict could differ:
 *
 *   targeted-band / targeted-union  a band proven to contain every mover
 *   full-scan                       trivially complete: everyone is in it
 *   none                            no comparable field moved, so the set of
 *                                   movers is empty and we returned all of it
 *   skipped                         the change verdict proved no user can be
 *                                   affected, same emptiness by a different route
 *
 * This is a SET rather than a hardcoded `true` on purpose. A future mode that
 * knowingly samples (say "sampled-estimate") is incomplete by default and has
 * to be added here deliberately, so the flag can actually be false. A literal
 * `true` could never report a problem, which makes it worth nothing.
 */
const COMPLETE_SELECTIONS = new Set([
  CANDIDATE_SELECTION.TARGETED_BAND,
  CANDIDATE_SELECTION.TARGETED_UNION,
  CANDIDATE_SELECTION.FULL_SCAN,
  CANDIDATE_SELECTION.NONE,
  CANDIDATE_SELECTION.SKIPPED,
]);

/**
 * Derive the four contract fields from the selection mode. ONE definition,
 * used by both buildImpactQuery and the assessImpact early returns.
 *
 * Two functions deriving these independently is how `candidateSelection:"none"`
 * came to report narrowingProven:true from one and false from the other — the
 * same ambiguity the `exhaustive` rename existed to remove.
 *
 * narrowingProven means "we examined strictly fewer than all users, and that
 * was provably safe". `none` and `skipped` examine nobody for a proven reason,
 * so they qualify; only a full scan does not.
 */
function contractFor(candidateSelection) {
  return {
    candidateSelection,
    scannedEveryUser: candidateSelection === CANDIDATE_SELECTION.FULL_SCAN,
    narrowingProven: candidateSelection !== CANDIDATE_SELECTION.FULL_SCAN,
    completenessGuaranteed: COMPLETE_SELECTIONS.has(candidateSelection),
  };
}

/** "Scan everyone" — the honest answer whenever a band cannot be justified. */
const scanAll = (reason) => ({ filter: null, narrowingProven: false, reason });

/**
 * Turn ONE field diff into a candidate filter over User documents.
 *
 * @returns {{filter: Object|null, narrowingProven: boolean, reason: string}}
 *   `filter` is a Mongo query fragment; `null` means every user is a candidate.
 *   `narrowingProven: true` means this filter provably contains every user
 *   whose verdict on THIS field can differ. `false` means no narrower set could
 *   be proven safe, so the caller must scan everyone — not that anyone is
 *   missing.
 */
function deriveCandidateFilter(diff) {
  const { field, oldValue, newValue } = diff;

  // ---- numeric upper bounds: max income, max age -------------------------
  // Old cap A, new cap B. A user's verdict on this rule flips only if their
  // value lies between the two caps.
  if (field === "eligibilityRules.maxAnnualIncome" || field === "eligibilityRules.maxAge") {
    if (!isNum(oldValue) || !isNum(newValue)) {
      return scanAll(`${field} appeared or was removed; a new rule can also create a first positive match`);
    }
    const lo = Math.min(oldValue, newValue);
    const hi = Math.max(oldValue, newValue);
    const path =
      field === "eligibilityRules.maxAnnualIncome" ? "profile.annualIncome" : "profile.age";
    return {
      filter: { [path]: { $gt: lo, $lte: hi } },
      narrowingProven: true,
      reason: `${path} in (${lo}, ${hi}] — the only band whose verdict on this rule can differ`,
    };
  }

  // ---- numeric lower bounds: min income, min age, min marks ---------------
  // Old floor A, new floor B. The flipping band is [min(A,B), max(A,B)).
  if (
    field === "eligibilityRules.minAnnualIncome" ||
    field === "eligibilityRules.minAge" ||
    field === "eligibilityRules.minMarksPercentage"
  ) {
    if (!isNum(oldValue) || !isNum(newValue)) {
      return scanAll(`${field} appeared or was removed; a new rule can also create a first positive match`);
    }
    const lo = Math.min(oldValue, newValue);
    const hi = Math.max(oldValue, newValue);
    const path =
      field === "eligibilityRules.minAnnualIncome"
        ? "profile.annualIncome"
        : field === "eligibilityRules.minAge"
        ? "profile.age"
        : "profile.marksPercentage";
    return {
      filter: { [path]: { $gte: lo, $lt: hi } },
      narrowingProven: true,
      reason: `${path} in [${lo}, ${hi}) — the only band whose verdict on this rule can differ`,
    };
  }

  // ---- education ladder ---------------------------------------------------
  // Required rung moved from A to B: only users standing between the two rungs
  // change verdict. Everyone at or above both still passes; below both, fails.
  if (field === "eligibilityRules.minEducationLevel") {
    const o = oldValue ? EDUCATION_RANK[oldValue] : undefined;
    const n = newValue ? EDUCATION_RANK[newValue] : undefined;
    if (o === undefined || n === undefined) {
      return scanAll(
        `${field} appeared, was removed, or names a level outside the known ladder`
      );
    }
    const lo = Math.min(o, n);
    const hi = Math.max(o, n);
    const band = EDUCATION_LEVELS.slice(lo, hi); // [lo, hi)
    return {
      filter: { "profile.education": { $in: band } },
      narrowingProven: true,
      reason: `education in ${JSON.stringify(band)} — between the old and new required level`,
    };
  }

  // ---- OR allow-lists: gender, occupation, state --------------------------
  // The user has one value and it must appear in the list. Their verdict flips
  // only if their value entered or left the list, so the symmetric difference
  // is the whole candidate set — provided the rule existed on both sides.
  if (
    field === "eligibilityRules.genders" ||
    field === "eligibilityRules.occupations" ||
    field === "eligibilityRules.states"
  ) {
    const o = asArr(oldValue);
    const n = asArr(newValue);
    if (o.length === 0 || n.length === 0) {
      return scanAll(`${field} became or stopped being unrestricted`);
    }
    const lower = (a) => a.map((s) => String(s).toLowerCase());
    const os = new Set(lower(o));
    const ns = new Set(lower(n));
    const symDiff = [...new Set([...o, ...n])].filter((v) => {
      const k = String(v).toLowerCase();
      return os.has(k) !== ns.has(k);
    });
    if (symDiff.length === 0) {
      return { filter: { _id: null }, narrowingProven: true, reason: `${field} reordered only` };
    }
    const path =
      field === "eligibilityRules.genders"
        ? "profile.gender"
        : field === "eligibilityRules.occupations"
        ? "profile.occupation"
        : "profile.state";
    // Case-insensitive membership without a regex scan: match either casing.
    const variants = [...new Set(symDiff.flatMap((v) => [String(v), String(v).toLowerCase()]))];
    return {
      filter: { [path]: { $in: variants } },
      narrowingProven: true,
      reason: `${path} entered or left the list: ${symDiff.join(", ")}`,
    };
  }

  // ---- categories --------------------------------------------------------
  // AND-of-OR groups plus the female->"woman" bridge. A user holding a category
  // present in BOTH lists can still flip when the groups are restructured, so
  // there is no sound narrow query here.
  if (field === "eligibilityRules.categories" || field === "eligibilityRules.categoryGroups") {
    return scanAll("category rules are AND-of-OR; a narrow query would miss restructured groups");
  }

  // ---- eligibility type ---------------------------------------------------
  // PHASE V. Reclassifying a scheme between unknown/constrained/universal
  // changes the BRANCH matcher.js takes before it reads any rule, so it can
  // flip a user who matches no profile band at all — a universal scheme is open
  // to everyone who does not actively fail a rule, and a constrained one is not.
  // There is no attribute to band on, and the generic fallback below would say
  // "no candidate band defined", which reads like an oversight rather than a
  // proof. Everyone is a candidate, and the reason belongs in the audit trail.
  if (field === "eligibilityRules.eligibilityType") {
    return scanAll(
      "eligibilityType selects the matcher branch itself; any user's verdict can flip regardless of profile"
    );
  }

  // ---- scheme-level facts ------------------------------------------------
  // A closure revokes the scheme for everyone holding it; benefit, deadline and
  // document edits change what an eligible user sees without moving any rule.
  // Neither is expressible as a profile band.
  if (["status", "benefits", "lastDate", "documents", "description", "eligibility"].includes(field)) {
    return scanAll(`${field} affects users regardless of profile attributes`);
  }

  return scanAll(`no candidate band defined for ${field}`);
}

/**
 * Union the per-field bands into one query.
 *
 * A user's overall verdict can only move if at least one changed rule moved
 * for them, so OR-ing the bands is sound. One unbandable field forces a scan.
 */
function buildImpactQuery(diffs) {
  // Every return below goes through this, so the four contract fields can
  // never drift apart or be partially set.
  const shape = (candidateSelection, filter, reasons) => ({
    filter,
    ...contractFor(candidateSelection),
    reasons,
  });

  const list = Array.isArray(diffs) ? diffs : [];
  if (list.length === 0) {
    return shape(CANDIDATE_SELECTION.NONE, { _id: null }, ["no diffs"]);
  }

  const derived = list.map((d) => ({ field: d.field, ...deriveCandidateFilter(d) }));
  const reasons = derived.map((d) => `${d.field}: ${d.reason}`);

  if (derived.some((d) => !d.narrowingProven)) {
    return shape(CANDIDATE_SELECTION.FULL_SCAN, {}, reasons);
  }

  // Drop the empty-set sentinel before unioning; if all are empty, nobody moves.
  const real = derived.filter((d) => JSON.stringify(d.filter) !== JSON.stringify({ _id: null }));
  if (real.length === 0) {
    return shape(CANDIDATE_SELECTION.NONE, { _id: null }, reasons);
  }
  if (real.length === 1) {
    return shape(CANDIDATE_SELECTION.TARGETED_BAND, real[0].filter, reasons);
  }
  return shape(CANDIDATE_SELECTION.TARGETED_UNION, { $or: real.map((d) => d.filter) }, reasons);
}

/**
 * Compare one user's before and after verdicts.
 *
 * `schemeClosed` is handled separately from the rules: matcher.js does not
 * look at status, but a closed scheme is not something to keep recommending.
 */
function classifyTransition(before, after, { schemeClosed = false, changeVerdict = null } = {}) {
  const wasEligible = !!before?.eligible;
  const isEligible = !!after?.eligible && !schemeClosed;

  if (!wasEligible && isEligible) return TRANSITIONS.NEWLY_ELIGIBLE;
  if (wasEligible && !isEligible) return TRANSITIONS.NO_LONGER_ELIGIBLE;
  if (wasEligible && isEligible) {
    // Still eligible, but what they get, when they must apply, or what they
    // must produce may have moved. That is worth telling them; a ministry
    // rename is not.
    const material =
      !!changeVerdict &&
      (changeVerdict.benefitImpact || changeVerdict.deadlineImpact || changeVerdict.documentImpact);
    return material ? TRANSITIONS.STILL_ELIGIBLE_CHANGED : TRANSITIONS.UNCHANGED;
  }
  return TRANSITIONS.UNCHANGED;
}

/** Which rules moved for this specific user — the raw material for Agent 3. */
function diffVerdicts(before, after) {
  const key = (e) => `${e.rule}`;
  const beforeFailed = new Set((before?.failed || []).map(key));
  const afterFailed = new Set((after?.failed || []).map(key));
  return {
    rulesNowPassing: [...beforeFailed].filter((r) => !afterFailed.has(r)),
    rulesNowFailing: [...afterFailed].filter((r) => !beforeFailed.has(r)),
    failedAfter: after?.failed || [],
    matchedAfter: after?.positiveMatches || [],
  };
}

const isActive = (status) => {
  const s = String(status || "active").toLowerCase();
  return s === "active" || s === "";
};

/**
 * Assess who a scheme change actually moves.
 *
 * @param {Object}   opts
 * @param {Object}   opts.scheme        the scheme document AFTER the update
 * @param {Object}   opts.oldRules      eligibilityRules BEFORE (from SchemeHistory.snapshot)
 * @param {Array}    opts.diffs         comparator output
 * @param {Object}   opts.changeVerdict policyChangeAgent output
 * @param {Object}   [opts.oldSchemeSnapshot] full previous snapshot, for status
 * @param {number}   [opts.batchSize]
 * @param {Object}   [opts.userModel]   injectable for tests
 */
async function assessImpact({
  scheme,
  oldRules,
  diffs,
  changeVerdict,
  oldSchemeSnapshot = null,
  isNew = false,
  batchSize = 500,
  userModel = User,
} = {}) {
  const started = Date.now();

  // A change with no possible user consequence does no database work at all.
  // This is the cheap path most collection cycles take, and it is what keeps
  // the nightly run from re-scoring the whole user base over a typo fix.
  if (changeVerdict && changeVerdict.userImpactExpected === false) {
    return emptyResult({
      schemeId: scheme?.schemeId,
      candidateSelection: CANDIDATE_SELECTION.SKIPPED,
      reasons: ["changeVerdict.userImpactExpected is false — no user can be affected"],
      startedAt: started,
    });
  }

  // A scheme seen for the first time has no diff to band — there is no
  // "before" boundary to compare against, so buildImpactQuery would select
  // nobody and the scheme would reach no one. But a new scheme is exactly the
  // case where many users can become newly eligible at once, so the honest
  // candidate set is everyone.
  const query = isNew
    ? {
        filter: {},
        ...contractFor(CANDIDATE_SELECTION.FULL_SCAN),
        reasons: ["scheme is new: no prior version to band against, so every user is a candidate"],
      }
    : buildImpactQuery(diffs);

  if (query.candidateSelection === CANDIDATE_SELECTION.NONE) {
    return emptyResult({
      schemeId: scheme?.schemeId,
      candidateSelection: CANDIDATE_SELECTION.NONE,
      reasons: query.reasons,
      startedAt: started,
    });
  }

  const newRules = scheme?.eligibilityRules || {};
  const wasClosed = oldSchemeSnapshot ? !isActive(oldSchemeSnapshot.status) : false;
  const nowClosed = !isActive(scheme?.status);

  // Two synthetic scheme objects differing only in their rules, so the SAME
  // matcher decides both verdicts. Re-implementing the eligibility logic here
  // would let the two copies drift, and a drifted copy produces phantom
  // transitions — a user "becoming eligible" because the impact agent and the
  // recommendation endpoint disagree.
  const schemeBefore = { ...toPlain(scheme), eligibilityRules: oldRules || {} };
  const schemeAfter = { ...toPlain(scheme), eligibilityRules: newRules };

  const impacts = [];
  const counts = emptyCounts();
  let candidatesExamined = 0;

  const cursor = userModel.find(query.filter).batchSize(batchSize).cursor();
  for (let user = await cursor.next(); user != null; user = await cursor.next()) {
    candidatesExamined++;
    const before = evaluateEligibility(user, schemeBefore);
    const after = evaluateEligibility(user, schemeAfter);

    // NOTE the spread order. `{ eligible: X, ...before }` puts ...before LAST,
    // so before.eligible silently overwrites X and the wasClosed adjustment is
    // discarded — a reopened scheme would then report nobody as newly eligible.
    const transition = classifyTransition(
      { ...before, eligible: before.eligible && !wasClosed },
      after,
      { schemeClosed: nowClosed, changeVerdict }
    );

    counts[transition] = (counts[transition] || 0) + 1;
    if (transition === TRANSITIONS.UNCHANGED) continue;

    impacts.push({
      userId: user._id,
      email: user.email,
      transition,
      wasEligible: before.eligible && !wasClosed,
      isEligible: after.eligible && !nowClosed,
      ...diffVerdicts(before, after),
      documentReadiness: after.eligible ? getDocumentReadiness(user, schemeAfter) : null,
      severity: changeVerdict?.severity || null,
      affectedAttributes: changeVerdict?.affectedAttributes || [],
    });
  }

  // Only pay for the count when it is the denominator of a reported figure.
  let totalUsers = null;
  try {
    totalUsers = await userModel.countDocuments({});
  } catch (err) {
    logger.warn("PolicyImpactAgent: user count unavailable", { error: err.message });
  }

  const result = {
    schemeId: scheme?.schemeId,
    // --- the candidate-selection contract; see the header block ---
    candidateSelection: query.candidateSelection,
    scannedEveryUser: query.scannedEveryUser,
    narrowingProven: query.narrowingProven,
    completenessGuaranteed: query.completenessGuaranteed,
    // ---
    candidatesExamined,
    totalUsers,
    // The honest efficiency figure: what fraction of the user base we did NOT
    // have to re-evaluate. Reported, not asserted — EVALUATION.md quotes
    // measurements, not this docstring. It is 0 on a full scan by definition.
    scanReduction:
      totalUsers && totalUsers > 0
        ? Number((1 - candidatesExamined / totalUsers).toFixed(4))
        : null,
    impacts,
    counts,
    reasons: query.reasons,
    durationMs: Date.now() - started,
  };

  logger.info("PolicyImpactAgent: assessed", {
    schemeId: result.schemeId,
    candidateSelection: result.candidateSelection,
    scannedEveryUser: result.scannedEveryUser,
    candidatesExamined,
    totalUsers,
    newlyEligible: counts.NEWLY_ELIGIBLE,
    noLongerEligible: counts.NO_LONGER_ELIGIBLE,
  });

  return result;
}

/**
 * The zero-work result. Both early exits ("nothing comparable changed" and
 * "this change cannot affect anyone") share it so their shape cannot drift
 * from the full result above.
 */
function emptyResult({ schemeId, candidateSelection, reasons, startedAt }) {
  return {
    schemeId,
    // Same derivation buildImpactQuery uses. Deriving these here separately is
    // what previously made "none" report narrowingProven:true from one function
    // and false from the other.
    ...contractFor(candidateSelection),
    candidatesExamined: 0,
    totalUsers: null,
    scanReduction: null,
    impacts: [],
    counts: emptyCounts(),
    reasons,
    durationMs: Date.now() - startedAt,
  };
}

function emptyCounts() {
  return {
    [TRANSITIONS.NEWLY_ELIGIBLE]: 0,
    [TRANSITIONS.NO_LONGER_ELIGIBLE]: 0,
    [TRANSITIONS.STILL_ELIGIBLE_CHANGED]: 0,
    [TRANSITIONS.UNCHANGED]: 0,
  };
}

/** Mongoose doc or plain object, indifferently. */
function toPlain(doc) {
  return doc && typeof doc.toObject === "function" ? doc.toObject() : doc || {};
}

module.exports = {
  assessImpact,
  buildImpactQuery,
  deriveCandidateFilter,
  classifyTransition,
  diffVerdicts,
  TRANSITIONS,
  CANDIDATE_SELECTION,
  COMPLETE_SELECTIONS,
  contractFor,
};
