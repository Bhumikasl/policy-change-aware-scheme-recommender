# PHASE V — Change-Detection Completeness

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase V only.** At the time this Phase V report was produced, Phase W had not started.

---

## 1. NO OFFICIAL PHASE V SPECIFICATION FOUND

I searched the whole H→U tree — `docs/`, `README.md`, `MERGE_MANIFEST.md`,
`RUN_FINAL.md`, `PROJECT_AUDIT.md`, `NOTIFICATION_ARCHITECTURE.md`,
`INDEX_VERIFICATION.md`, `CHANGES.md`, every phase report, every evaluation
document, all source comments, all tests, and every deferred-work reference.
The only occurrences of the string "Phase V" anywhere in the project are the two
forward-looking notes in `PHASE_U_REPORT.md` saying Phase V had not started.

**There is no Phase V specification.**

(For contrast: Phase R *was* specified, in `NOTIFICATION_ARCHITECTURE.md`.
Phases S, T, U and V are not.)

So Phase V was chosen by auditing for defects, not by looking for a missing
feature.

---

## 2. The gap

The project's headline claim has two halves:

> We **detect** government policy drift and automatically **propagate** that
> change through affected-user eligibility and personalized recommendations.

Five phases now examine the second half:

| | asks |
|---|---|
| Q | does the targeted band miss anyone? *(**who**)* |
| R | is the targeted flow actually cheaper? *(**cost**)* |
| S | how late can the propagation be? *(**when**)* |
| T | is the resulting ranking a function of its inputs? *(**stability**)* |
| U | are the eligibility rules read correctly? *(**the authority**)* |

**Every one of them begins after a change has been detected.** Nothing asks
whether it was detected at all.

That gap is worse than it sounds, because a detection miss is silent by
construction. `reconcile()` returning `NO_CHANGE` writes no `SchemeHistory` row,
bumps no version and starts no pipeline — so there is nothing downstream for any
harness to be wrong about. Q, R, S, T and U all stay green while the system
quietly stops monitoring.

### The gap, demonstrated rather than asserted

Removing `eligibilityType` from the change signal — which is exactly the state
the code shipped in — leaves every prior harness reporting healthy:

| | Phase Q | Phase R | Phase S | Phase T | Phase U | full suite |
|---|---|---|---|---|---|---|
| the detector cannot see `eligibilityType` | **SOUND** | MEASURED | BOUNDED | STABLE | **AGREE** | 886/886 |

Phase U is the striking column. It verifies the matcher exhaustively across
306,180 cases and passes — correctly, because the matcher is not broken. The
matcher never *sees* the change.

---

## 3. The defect

**`eligibilityRules.eligibilityType` was not part of the change signal.**

`ELIGIBILITY_RULE_FIELDS` in `normalizer/normalizer.js` drives two things: the
`contentHash`, and the field-by-field diff in `comparator.js`. `eligibilityType`
was in neither.

It is not a metadata field. It is the branch `matcher.js` takes **before it
reads a single rule**:

```
unknown      eligible = false                              (nobody)
constrained  eligible = no failures AND at least one pass
universal    eligible = no failures
```

### Reproduction

```
$ node scripts/runDetectionCompleteness.js     # before the fix

run status : INCOMPLETE

MISSED                       6   material, detector said NO_CHANGE   <- defect
  [MISSED] universal-open :: eligibilityRules.eligibilityType
    "universal" -> "constrained"
    detector route : hash-identical
    users flipped  : 1152
         recommended true -> false

exit 1
```

`hash-identical` is the important line. `reconcile()` returns `NO_CHANGE` on the
hash gate **without ever calling `diffFields`**, so a field outside the hash
cannot be rescued by being inside the diff.

### Consequence

A scheme reclassified between the three types — by an improved extraction, a
re-crawl, or a genuine change of policy framing — changes who qualifies without
producing a version bump, a history row, an impact analysis or a notification.
The stored document keeps the old type indefinitely, so the divergence is
permanent rather than delayed. This is the failure Phase S bounded for
*processing* faults, reappearing at the *detection* stage where no sweep can
recover it: there is no failed row to retry.

### Why every suite missed it

`tests/policyChangeAgent.test.js` has a field-coverage gate, and it is a good
one:

```js
const emittable = [
  ...COMPARABLE_FIELDS.filter((f) => f !== "eligibilityRules"),
  ...ELIGIBILITY_RULE_FIELDS.map((f) => `eligibilityRules.${f}`),
];
expect(emittable.filter((f) => !FIELD_MAP[f])).toEqual([]);
```

It asks *"is every field we compare also classified?"* It cannot ask *"is every
field that matters compared?"*, because it derives the field list from the
detector's own constants — a field missing from the list is missing from both
sides of the check. It passed for the life of the project.

**This is the Phase V brief's rule 7 in a form that is easy to miss.** Rule 7
forbids computing ground truth with the production algorithm. Here the shared
component was not an algorithm at all but a *list of field names*, and sharing
it was enough to make the check unfalsifiable.

### Fix

Three parts, because detecting the change without classifying it would have
looked like a fix and delivered nothing:

1. **`normalizer.js`** — `eligibilityType` added to `ELIGIBILITY_RULE_FIELDS`,
   so it enters both the hash and the diff.
2. **`policyChangeAgent.js`** — a `FIELD_MAP` entry (ELIGIBILITY / HIGH /
   `eligibility: true`) plus a direction rule. Without the entry the diff
   degrades to ADMINISTRATIVE / LOW with `eligibilityImpact: false`, which makes
   `assessImpact` return `SKIPPED` and nobody is told.
3. **`policyImpactAgent.js`** — an explicit `scanAll` branch. The generic
   fallback already produced a full scan, so this is not a behaviour change; it
   replaces the audit-trail reason *"no candidate band defined for
   eligibilityRules.eligibilityType"*, which reads as an oversight, with the
   actual proof: the field selects the matcher branch itself, so any user can
   flip regardless of profile.

### The direction rule is proved, not asserted

The three types form a permissiveness lattice, and the ordering follows from the
matcher's own branches: the constrained condition is the universal condition
plus an extra requirement, so constrained-eligible implies universal-eligible.

Asserted by exhaustive enumeration over the full Phase U space rather than left
as a comment, and checked in **both** implementations — if it held only in
production it would be a property of one reading of the specification rather
than of the specification:

```
triples checked            : 306,180
containment violations     : 0
eligible under unknown     : 0
eligible under constrained : 103,518
eligible under universal   : 147,258        strictly growing
```

So a move up the lattice is a BROADENING and a move down is a NARROWING, which
the existing rule escalates to CRITICAL — a scheme reclassified downward revokes
standing from people who had it.

### The deploy-time migration is silent, by construction

Adding a field to `ELIGIBILITY_RULE_FIELDS` changes every stored `contentHash`
once. That is safe only because of `reconcile()`'s **second** gate: the hash
differs, `diffFields` finds nothing, and the NO_CHANGE branch rewrites the hash
without bumping the version or writing a history row. One extra diff per scheme,
on one cycle, then nothing.

No backfill, no migration script, no downtime. Two tests hold that property in
place — one on the behaviour, one asserting `reconcile` still contains the
branch that makes it true.

---

## 4. What Phase V adds

An instrument that asks the question the other five cannot:

> **If a change flips at least one user's recommended state, does the system
> notice?**

**The mutation set comes from the document, not the detector.** The field
universe is every key `normalize()` actually writes — 30 paths — and never
`COMPARABLE_FIELDS`. The gap between *fields the document carries* and *fields
the detector compares* is the blind spot, and it is only visible from outside
the detector. A future field added to the normalizer but not to the comparator
is caught automatically, with no edit to the harness.

**Materiality is judged independently.** A change is material when it moves

```
recommendedState(user, scheme) = eligible(user, scheme) AND schemeIsOpen(scheme)
```

`eligible` comes from `eligibilityReference.js` — the Phase U reference, which
does not import `services/matcher.js`. `schemeIsOpen` restates
`policyImpactAgent`'s documented rule that a closed scheme is not recommended;
the matcher itself never reads `status`, so an oracle built on the matcher alone
would call a closure immaterial and could not notice a detector that missed it.

**The property is one-directional on purpose.** Detecting a change that flips
nobody costs a wasted cycle — Phase R measured exactly that case
(`no-material-change`: legacy 104 notifications, targeted 0). Missing one that
flips somebody costs a person. Only the second is treated as a defect; the first
is reported as coverage.

**The candidate query is checked against the people who moved.** Asserting
`completenessGuaranteed` would not have been enough: that flag is derived from
the selection *mode*, and `targeted-band` is a member of `COMPLETE_SELECTIONS`,
so a band that is genuinely too narrow still reports complete. It records which
mode was chosen; it cannot police whether the mode was chosen correctly. So the
sweep evaluates the impact agent's real Mongo fragment against the users the
oracle says flipped. Mutation **V-M4** is the evidence this matters: a
deliberately narrow band for `eligibilityType` produces 6 `UNSOUND_BAND` results
while `completenessGuaranteed` stays `true` throughout.

---

## 5. Result — MEASURED, on a SYNTHETIC corpus

```
npm run evaluate:detection
```

| | |
|---|---|
| base scheme shapes | **4** |
| fields exercised | **30** (from the normalized document) |
| single-field mutations | **196** |
| oracle population | **1,152** enumerated profiles |
| status | **COMPLETE** |

| outcome | count | |
|---|---|---|
| MISSED | **0** | material, detector said NO_CHANGE |
| MISCLASSIFIED | **0** | detected, but not user-affecting |
| UNSOUND_BAND | **0** | candidate query drops a user who moved |
| INCOMPLETE_SELECTION | **0** | material, candidate set unproven |
| DETECTED_MATERIAL | 65 | material and handled correctly |
| DETECTED_IMMATERIAL | 91 | detected, flips nobody (acceptable noise) |
| IGNORED_IMMATERIAL | 40 | correctly ignored |

**Evidence strength** — COMPLETE over a sweep where nothing is ever material
would be vacuous. **65 of 196** mutations flip at least one user, and all three
non-defect outcomes are non-empty, so the sweep exercises both directions.

**Before the fix, on the same sweep: INCOMPLETE — 6 MISSED, exit 1.**

**Oracle cross-check** — 451,584 verdicts compared between the independent
reference and the production matcher across the sweep: **0 divergent, AGREE**,
consistent with Phase U over a different set of scheme shapes.

### What this does NOT measure

- **Completeness of the population.** The profile space is enumerated and
  bounded. A MISSED verdict is firm evidence of a defect; the absence of one is
  bounded reassurance, not proof.
- **Whether the source data is right.** Detection compares two normalized
  documents. If the collector or the extractor misread the government page, both
  sides are wrong together — that is an extraction-fidelity question and it
  remains unmeasured.
- **The database reconciliation loop.** The real `normalize`, contentHash gate
  and `diffFields` run here; the Mongo read/write around them is exercised by
  the integration suites.
- **Multi-field changes.** Mutations are applied one field at a time.
- Real scheme data or a real user population.

---

## 6. Files

**Created:** `src/evaluation/detectionOracle.js`,
`src/evaluation/detectionCompleteness.js`,
`scripts/runDetectionCompleteness.js`, `tests/detectionCompleteness.test.js`,
`docs/PHASE_V_REPORT.md`

**Modified:** `src/normalizer/normalizer.js` (one field added to the change
signal), `src/agents/policyChangeAgent.js` (field map entry + direction rule),
`src/agents/policyImpactAgent.js` (explicit scanAll branch, same behaviour,
honest reason), `package.json` (one script), `README.md`, `MERGE_MANIFEST.md`,
`RUN_FINAL.md`, and the phase-chain line in the ten historical reports.

**Deleted:** none.

No model, schema, index, route, API, scheduler, environment variable or frontend
file was changed.

---

## 7. Mutation testing

Ten mutations, each reverted after. **The evaluator is mutated as well as the
production code** — an evaluation that cannot fail when the system is broken is
not evidence.

| mutation | `evaluate:detection` | tests failed | result |
|---|---|---|---|
| V-M1 `eligibilityType` removed from the change signal *(the original defect)* | **INCOMPLETE — 6 MISSED** | 6 | killed |
| V-M2 change agent no longer maps `eligibilityType` | **INCOMPLETE — 6 MISCLASSIFIED** | 9 | killed |
| V-M3 permissiveness direction reversed | COMPLETE | 3 | killed |
| V-M4 `eligibilityType` given a narrow candidate band | **INCOMPLETE — 6 UNSOUND_BAND** | 4 | killed |
| V-M5 constrained scheme no longer needs a positive match | COMPLETE | 5 | killed |
| V-M6 the no-diff branch bumps the version | COMPLETE | 1 | killed |
| V-M7 *(evaluator)* `classifyOutcome` never reports MISSED | COMPLETE | 3 | killed |
| V-M8 *(evaluator)* field universe taken from `COMPARABLE_FIELDS` | COMPLETE | 5 | killed |
| V-M9 *(evaluator)* `candidateSetContains` admits everyone | COMPLETE | 4 | killed |
| V-M10 *(evaluator)* oracle ignores scheme closure | COMPLETE | 1 | killed |

**All ten killed on the first pass.** No surviving mutants to record.

Two rows deserve reading together. **V-M8 turns the harness into the tautology**
— derive the field universe from the detector's own list and the sweep reports
COMPLETE, because the missing field is missing from both sides. It is killed
only by the independence test, never by the sweep. That is the whole phase in
one line: a harness cannot detect the defect it is built out of, so the
independence has to be asserted structurally.

**V-M3, V-M5, V-M6, V-M7, V-M9 and V-M10 leave `evaluate:detection` COMPLETE
and are killed by tests instead.** Recorded plainly rather than glossed: the
sweep is one instrument among several, not a universal oracle. V-M5 is the
sharpest case — breaking the matcher leaves detection completeness untouched,
which is correct, and is caught by Phase U where it belongs.

---

## 8. Research contribution

**Problem.** Change-propagation systems are evaluated on propagation. The
literature and the practice both assume the change arrives; the instruments
measure who is reached, how fast, at what cost, and how correctly. A miss at the
*detection* stage is invisible to all of them, because a change that is never
detected produces no artefact for a downstream evaluation to examine.

**Research question.** Can detection completeness be measured without deriving
the test set from the detector — and does a system that passes five independent
propagation evaluations still have detection defects?

**Method.** Enumerate the field universe from the *document schema the system
actually writes*, perturb one field at a time, and judge materiality with an
oracle built on an independent reference implementation plus the documented
recommendation rule. Assert three properties of every material change —
detected, classified as user-affecting, and reachable by the candidate query —
where the third is checked against the users who actually moved rather than
against the agent's own completeness flag.

**Finding.** Yes on both counts. A system passing Q, R, S, T and U carried a
detection blind spot on `eligibilityType`, the single field that selects the
eligibility branch. The existing field-coverage gate could not have found it,
because it derived its field list from the detector. Nine other kinds of
mutation, including four to the evaluator itself, are all detected.

**Contribution.** Two transferable results. First, **the shared component in an
unfalsifiable check need not be an algorithm** — a shared list of field names is
enough, and the tell is that the check reads its inputs from the thing it is
checking. Second, **completeness flags derived from a mode label cannot police
correctness of the mode**; V-M4 shows a candidate set reporting
`completenessGuaranteed: true` while dropping every user who moved. The remedy
in both cases is the same and cheap: derive the test set from a description of
the system's *data*, and check *outcomes* against an oracle that shares no code
with the mechanism under test.

**Limitations.** SYNTHETIC and bounded — see §5. Agreement is not proof of
correctness; it is the removal of one specific way of being wrong undetected.
The oracle can only judge materiality within an enumerated population, and the
whole phase is silent on whether the extracted policy data was faithful to the
source in the first place.

---

## 9. Reproducibility

```bash
npm run evaluate:detection
npm run evaluate:detection -- --verbose
npm run evaluate:detection -- --out v.json
npm run evaluate:detection -- --no-cross-check
```

Fully deterministic: exhaustive single-field enumeration over a fixed value
domain and a fixed population, no sampling, no seed. Exits non-zero on any
missed, misclassified, unsound-band or unproven material change — those
conditions are defects, not settings, so CI can gate on it.

---

*Phase V complete. At the time this report was produced, Phase W had not started.*
