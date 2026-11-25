# PHASE T — Ranking Order-Invariance

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase T only.** At the time this Phase T report was produced, Phase U had not started.

---

## 1. There is no official Phase T specification

I searched the whole repository — `docs/`, `README.md`, `MERGE_MANIFEST.md`,
every architecture and evaluation document, source comments, tests — for a
Phase T definition. **There is none.**

(For contrast: Phase R *was* specified, in `NOTIFICATION_ARCHITECTURE.md`.
Phases S and T are not.)

Every remaining `NOT MEASURED` item in the project is blocked on the
environment, not on code: Phase O retrieval quality needs a semantic provider
and human relevance labels; Phase P's primary metric needs a real LLM run and
human labelling; Atlas `$vectorSearch` needs a vector index; Phase Q `--live`
and Phase R.2 need a real deployment. **None of those is a phase — they are
executions the developer performs.**

So Phase T was found by auditing for defects rather than by looking for missing
features. It found one.

---

## 2. The defect

**`rankCandidates` was not order-invariant.**

The comparator sorted on relevance, then eligibility score, and stopped:

```js
scored.sort((a, b) => {
  if (b.relevance !== a.relevance) return b.relevance - a.relevance;
  return (b.verdict?.score || 0) - (a.verdict?.score || 0);
});
```

Two schemes tying on **both** fell through to the order the array arrived in.
`Array.prototype.sort` is stable, so that is the **caller's** order — which
comes from an unsorted `Scheme.find()`. MongoDB guarantees nothing about the
order of an unsorted query, so the same two schemes can come back `a,b` on one
cycle and `b,a` on the next.

### Blast radius

This is not a cosmetic reshuffle. The project converts rank movement into claims
about the world:

```
rank 1 -> 2
  -> classifyRecommendationTransition  = RANK_DECREASED
  -> decideNotification                = shouldNotify: true
  -> the user is emailed "Support Scheme moved down your recommendations"
  -> a RecommendationHistory row asserts a movement
```

**A false notification, and a false entry in the audit trail this project treats
as evidence** — for a change that never happened. It also directly contradicts
the system's central promise: that it tells users only about *real* policy
changes.

### Reproduction

Two schemes identical in every ranking signal, handed over in two orders:

```
db order a,b -> scheme-a, scheme-b
db order b,a -> scheme-b, scheme-a
scheme-a rank: 1 -> 2
transition: RANK_DECREASED   shouldNotify: true
title: "Support Scheme moved down your recommendations"
```

### Why eighteen ranking tests missed it

Every one asserts one ranking against one expected order. They pass whether or
not the comparator resolves ties, because each only ever sees the input in a
single arrangement. **The property — same set, any order, same result — was
never tested.**

### Fix

One final tie-break on `schemeId`:

```js
const byScore = (b.verdict?.score || 0) - (a.verdict?.score || 0);
if (byScore !== 0) return byScore;
return String(a.scheme?.schemeId || "").localeCompare(String(b.scheme?.schemeId || ""));
```

`schemeId` is unique, stable across cycles and never null, so the comparator
becomes a **total order**: the result depends only on the *set* of candidates.
It cannot affect any pair whose relevance or eligibility score differ, so **no
existing ranking moves** — confirmed by mutation T-M2 and by the full suite.

---

## 3. The instrument

`npm run evaluate:ranking` shuffles each user's candidate list many times and
requires the ranking to come out identical.

Permutation testing rather than another unit test, because a unit test cannot
distinguish "the comparator resolves ties" from "the input happened to arrive
in this order" — which is how the defect survived.

**Tie groups are reported alongside the verdict.** STABLE over a pool with no
ties proves nothing about the tie-break, so a vacuous pass has to be visible
rather than indistinguishable from a real one.

---

## 4. Result

```
npm run evaluate:ranking
```

| | |
|---|---|
| corpus | **SYNTHETIC** (shared with Phases Q and R) |
| users | 40, candidate pool 16 schemes |
| permutations per user | 24 → **960 rankings compared** |
| status | **STABLE** |
| users with unstable ranking | **0** |
| comparator not a total order | **0** |

**Evidence strength:** 40/40 users' rankings contain a tie group; largest group
**13**. The tie-break is genuinely exercised — this is not a pass over a corpus
with nothing to resolve.

**Before the fix, on the same corpus: UNSTABLE — 40/40 users, 24/24
permutations disagreed.** Reproduce with a one-line revert, or see mutation
T-M1.

### What this does NOT measure

- **Ranking quality.** Order-invariance says the ranking is a function of the
  candidate set. It says nothing about whether the order is *good*. Relevance
  quality needs human judgements and remains unmeasured.
- **MongoDB's actual reordering behaviour.** The instability is demonstrated by
  permutation, not by observing Mongo return rows in a different order.
- A real user population — the corpus is synthetic.

---

## 5. Files

**Created:** `src/evaluation/rankingStability.js`,
`scripts/runRankingStabilityAnalysis.js`, `tests/rankingStability.test.js`,
`docs/PHASE_T_REPORT.md`

**Modified:** `src/services/relevanceRanker.js` (the tie-break),
`package.json` (one script), `README.md`, `MERGE_MANIFEST.md`

**Deleted:** none. No model, schema, index, route, API, scheduler or frontend
file changed. No environment variable added.

---

## 6. Mutation testing

Five applied, **five killed on the first pass**:

| mutation | killed by |
|---|---|
| T-M1 final tie-break removed *(the original defect)* | 3 tests |
| T-M2 tie-break applied **before** relevance | 8 tests, incl. existing Phase J rank tests |
| T-M3 instrument always reports STABLE | *DETECTS an unstable comparator* |
| T-M4 instrument runs zero permutations | *DETECTS an unstable comparator* |
| T-M5 tie-break key not unique (`name` instead of `schemeId`) | 3 tests |

T-M2 is the one worth noting: putting the tie-break first breaks **existing**
Phase J tests (*"records RANK_INCREASED when a better benefit lifts the scheme
up the list"*), which is the evidence that the fix is inert where scores differ.

---

## 7. Research contribution

**Problem.** Recommender evaluations report relevance quality. They rarely ask
whether the ranking is a *function of its inputs* at all. A ranking that varies
with database return order produces movement that no change caused — and in a
system that notifies on movement, that noise becomes assertions to users.

**Method.** Permutation testing on the comparator, paired with a tie-group count
so that a stable result over a corpus with no ties is not mistaken for evidence.

**Finding.** The ranking was **not** order-invariant: 40/40 users, 24/24
permutations. The cause was a two-key comparator with no total-order guarantee,
and the effect was false rank-change notifications and false audit-trail
entries. Eighteen existing ranking tests could not detect it, structurally.

**Contribution.** Order-invariance is a cheap, checkable precondition for any
system that treats rank *movement* as a signal. It should be asserted before any
relevance-quality claim, because instability makes the quality claim unfalsifiable.

**Honesty.** STABLE is measured on a SYNTHETIC corpus. No ranking-quality claim
is made and none is measured.

---

## 8. Reproducibility

```bash
npm run evaluate:ranking
npm run evaluate:ranking -- --permutations 100 --users 200 --out t.json
```

Deterministic: the permutations come from a seeded integer generator, so every
arrangement is reproducible. Exits non-zero when the ranking is unstable — that
condition is a defect, not a setting, so CI can gate on it.

---

*Phase T complete. At the time this report was produced, Phase U had not started.*
