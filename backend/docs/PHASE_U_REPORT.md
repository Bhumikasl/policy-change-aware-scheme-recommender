# PHASE U — Independent Matcher Verification

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase U only.** At the time this Phase U report was produced, Phase V had not started.

---

## 1. NO OFFICIAL PHASE U SPECIFICATION FOUND

I searched the whole H→T tree — `docs/`, `README.md`, `MERGE_MANIFEST.md`,
`RUN_FINAL.md`, every architecture and evaluation document, every phase report,
all source comments, all tests, all deferred-work references. **There is no
Phase U specification anywhere.**

(For contrast: Phase R *was* specified, in `NOTIFICATION_ARCHITECTURE.md`.
Phases S, T and U are not.)

---

## 2. The gap — and it is the one the Phase U brief names

The brief's rule 7 says:

> Do NOT compute: prediction = production algorithm, ground truth = same
> production algorithm with a cosmetic difference.

**That describes Phase Q exactly.** Its oracle is `assessImpact` run twice,
differing only in `isNew`. Its own documentation says so: *"Same matcher, same
transition classifier, same closed-scheme handling."*

That was a defensible choice for what Q measured — it isolates the **candidate
filter**, which was the variable under test. But it makes Q, and every
evaluation built on the same foundation, structurally blind to a defect in the
part they share.

And the part they share is **`services/matcher.js`** — the deterministic
authority for the whole system. The architecture is explicit that the LLM never
decides eligibility; the matcher does, and impact analysis, propagation,
history, notifications and the chat verdict block are all consequences of what
it returns.

**Nothing independently checks it.**

### The gap, demonstrated rather than asserted

Two mutations of `matcher.js`, each a serious correctness defect:

| mutation | Phase Q | Phase R | Phase S | Phase T | full suite |
|---|---|---|---|---|---|
| a constrained scheme no longer needs a positive match | **SOUND** | MEASURED | BOUNDED | STABLE | 868/1 |
| a universal scheme ignores failed rules entirely | **SOUND** | MEASURED | BOUNDED | STABLE | 868/1 |

The first means users are told they qualify for schemes nobody could verify
them against. The second means a failed rule stops mattering. **All four
harnesses reported healthy**, and one unit test out of 869 objected.

---

## 3. What Phase U does

An **independent reference implementation** of the eligibility rules, compared
**exhaustively** against the production matcher.

**Independence** — `src/evaluation/eligibilityReference.js` does not import
`services/matcher.js`, does not use its helpers (`meetsEducation` included), and
is deliberately written in a *different shape*: a table of independent rule
predicates reduced at the end, rather than one procedural pass. Two
implementations sharing a structure tend to share a bug. It is written from the
matcher's documented specification — the three-branch header block, the
per-rule comments, the ladder — not from its code. Tests assert the
non-import structurally, and assert that nothing outside `evaluation/` can
reach it.

**The one shared thing** is the education ladder *order*, which is data. Copying
it risks a drift that would look like a correctness finding and be nothing of
the sort, so the reference declares its own and a test asserts it equals
production's. The *comparison logic* stays independent — verified by mutation
U-M6, which breaks production's `meetsEducation` and produces 4,860
disagreements.

**Exhaustive, not sampled** — the input space is bounded deliberately small and
then enumerated in full. Attribute values sit **on** and immediately either side
of every threshold the scheme set uses, and `undefined` is included for every
optional attribute because "the user never filled this in" is what the matcher's
`strict` flag exists for and is the most likely transcription divergence.

Only the **boolean verdict** is compared. The two implementations produce
different reason vocabularies on purpose — requiring those to match would be
requiring a transcription, which is the opposite of independence.

---

## 4. Result — MEASURED

```
npm run evaluate:matcher
```

| | |
|---|---|
| profiles enumerated | **14,580** (exhaustive cartesian product) |
| scheme shapes | **21** |
| verdicts compared | **306,180** |
| disagreements | **0** |
| agreement rate | **100.0000% (306,180/306,180)** |
| status | **AGREE** |

**Evidence strength** — agreement over a space where nobody is ever eligible
would be vacuous. Both implementations produced a genuine mix:

- both said ELIGIBLE: **115,182**
- both said INELIGIBLE: **190,998**

`--allow-unknown` also runs AGREE, so the opt-in branch is covered in both
directions.

### What this does NOT measure

- **Whether the specification is right.** Both implementations read the same
  documented rules. Agreement means they read them the same way — not that the
  rules serve citizens correctly. That is a policy question, not a code one.
- **Attribute values outside the enumerated axes.** The space is bounded and
  boundary-focused, not the whole domain.
- Real scheme data or a real user population.
- Reason strings, scores or ordering.

---

## 5. Files

**Created:** `src/evaluation/eligibilityReference.js`,
`src/evaluation/matcherAgreement.js`, `scripts/runMatcherAgreement.js`,
`tests/matcherAgreement.test.js`, `docs/PHASE_U_REPORT.md`

**Modified:** `package.json` (one script), `README.md`, `MERGE_MANIFEST.md`

**Deleted:** none.

**No production code was changed.** No model, schema, index, route, API,
scheduler, environment variable or frontend file was touched. Phase U adds an
instrument; it does not alter the system it measures.

---

## 6. Mutation testing

Six mutations of the production matcher, each reverted after. **Two columns
matter: what Phase Q said, and what Phase U said.**

| mutation | Phase Q | Phase U | disagreements |
|---|---|---|---|
| U-M1 constrained needs no positive match | **SOUND** (blind) | **DISAGREE** | 14,580 |
| U-M2 universal ignores failed rules | **SOUND** (blind) | **DISAGREE** | 5,832 |
| U-M3 income ceiling off-by-one | **SOUND** (blind) | **DISAGREE** | 5,832 |
| U-M4 unknown type silently allowed | SOUND | **DISAGREE** | 2,916 |
| U-M5 AND-of-OR becomes "any group satisfied" | — | **DISAGREE** | 9,720 |
| U-M6 education `>=` becomes `>` | — | **DISAGREE** | 4,860 |

**U-M4 survived the first pass** and the reason is worth recording. The
`unknown-type` scheme in the set had no rules, so with the guard removed
production fell through to the constrained branch, found no positive match, and
returned ineligible anyway — **agreeing with the reference for the wrong
reason**. Fixed by adding `unknown-type-satisfiable`, a scheme whose rules a
user *can* satisfy, so the guard is the only thing holding the verdict false.

That is the failure mode this whole phase is about, appearing inside the phase
itself: two things agreeing because neither was exercised.

---

## 7. Research contribution

**Problem.** Evaluation harnesses for rule-driven systems routinely compute
ground truth with the production rule engine, because it is the most convenient
authority available. The result is an evaluation that measures *plumbing* —
filters, orderings, schedules — while being structurally incapable of detecting
an error in the rules themselves.

**Method.** An independent reference implementation, written from the
specification rather than the code and in a deliberately different structure,
compared by exhaustive enumeration over a bounded, boundary-focused input space.
Independence is asserted structurally (no import, no shared helper, unreachable
from production) rather than claimed.

**Finding.** The production matcher **agrees with an independent reading of its
own specification on all 306,180 enumerated cases**. Equally important: the four
pre-existing harnesses were shown to be blind to three serious matcher defects
that this one detects.

**Contribution.** Oracle independence is testable, and the test is cheap: mutate
the shared component and check whether the harness notices. An evaluation that
cannot fail when the system is broken is not evidence, and this phase gives a
concrete procedure for telling the two apart.

**Limitations.** SYNTHETIC and bounded. It cannot validate the specification
itself, only the consistency of two readings of it. Agreement is not proof of
correctness — it is the removal of one specific way of being wrong undetected.

---

## 8. Reproducibility

```bash
npm run evaluate:matcher
npm run evaluate:matcher -- --out u.json
npm run evaluate:matcher -- --allow-unknown
```

Fully deterministic: exhaustive enumeration, no sampling, no seed. Exits
non-zero on any disagreement, so CI can gate on it.

---

*Phase U complete. At the time this report was produced, Phase V had not started.*
