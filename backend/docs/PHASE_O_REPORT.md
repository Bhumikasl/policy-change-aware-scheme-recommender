# Phase O — Research Evaluation Harness

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase O only.** At the time this report was produced, Phase P had not started.

Phase O was undefined in the original brief; the only forward reference was
*"do not proceed to performance/research evaluation yet."* You confirmed the
scope as the **research evaluation harness**.

---

## 1. PHASE O STATUS

| Deliverable | Status |
|---|---|
| Metrics definitions + aggregation | **IMPLEMENTED, TESTED + mutation-tested** |
| Evaluation harness over the real agent | **IMPLEMENTED, TESTED** |
| Labelled question set (routing/behaviour) | **IMPLEMENTED** — 24 questions + 2 follow-up pairs |
| Relevance labels for retrieval quality | **NOT DONE — needs human judgement (§9)** |
| Stale-answer experiment | **IMPLEMENTED, EXECUTED, measured** |
| CLI runner (`npm run evaluate`) | **IMPLEMENTED, EXECUTED** |
| Instrumentation consumers (latency, top-k, grounding, fallback) | **IMPLEMENTED, TESTED** |

**Nothing in H–N was changed except three real defects found by the audit (§5).**

## 2. THE AUDIT — THREE DEFECTS FOUND AND FIXED

You asked me not to modify H–N unless the audit found an actual defect. It
found three, all in Phase N's `loadRecommendationContext`, and **all 24
existing chat-service tests passed with every one of them present.**

They passed because they tested `handleRecommendation` with a hand-built
context object — the **handler**, never the **wiring** that produces the
context. That is the same class of gap that let an eligibility mutant survive
in Phase N: testing the unit and not the seam.

| # | Defect | Effect |
|---|---|---|
| 1 | Code read `hit.reasons`; `rankCandidates` returns `{scheme, verdict, relevance, relevanceBreakdown}` — **there is no `reasons` field** | `rankingReasons` was `[]` for every scheme, permanently. "Why is this recommended?" had **no signals to explain**, silently. |
| 2 | No `isActive(scheme.status)` gate | `matcher.js` does not look at status. `recommendationPropagation` gates on it explicitly; chat did not. A **closed scheme could take a rank**, shifting every rank below it, and could itself be described as recommended. |
| 3 | `documentReadiness` not passed to the ranker | The ranker's document term is `(have/required) * 1.5`. Omitting it silently zeroed that term, so chat could **order schemes differently from `GET /recommendations`** and quote a rank the UI disagreed with. |

**Fixes:** `isActive` is now **exported** from `recommendationPropagation` and
imported rather than copied (two copies of a status rule would drift).
`documentReadiness` is supplied, matching the other two call sites.
`rankingReasons` are rendered by a new `describeRankingSignals()` from the
ranker's **own computed breakdown** — each sentence describes what its
component actually measures, read off `scoreCandidate`. A component that
contributed nothing produces **no sentence**: padding would be the same
invention N.4 forbids, just moved out of the model. The universal downweight is
reported as honestly as an upweight.

Six regression tests added; each fix was reverted individually and confirmed to
fail them.

## 3. ARCHITECTURE

```
                    ┌─────────────────────────────┐
                    │   questionSet.js            │  24 labelled questions
                    │   - expectedIntent          │  + 2 follow-up pairs
                    │   - expectedSchemeIds  []   │  EMPTY — see §9
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   harness.js                │  drives the REAL agent
                    │   runEvaluation()           │  matcher, guards, grounding
                    └──────────────┬──────────────┘  all real; LLM/RAG injectable
                                   │
                    ┌──────────────▼──────────────┐
                    │   metrics.js                │  observe() → summarise()
                    │   - null, never 0           │
                    │   - quality GATED on provider│
                    │   - n travels with every rate│
                    └──────────────┬──────────────┘
                                   │
    ┌──────────────────────────────▼──────────────────────────────┐
    │   staleAnswerExperiment.js    the headline measurement       │
    │   version-aware  vs  same retriever, filter removed          │
    └──────────────────────────────────────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   scripts/runEvaluation.js  │  npm run evaluate
                    └─────────────────────────────┘
```

The harness drives `conversationalAgent.answerQuestion` directly, not the HTTP
route: the route adds auth and serialisation that the metrics are not about,
and driving it would need a running server and a live token — making the
harness impossible to run offline and pointless to test.

## 4. DATA FLOW

```
runEvaluation({questions, user, buildData, deps})
   for each question:
      answerQuestion(...)        REAL agent — matcher, guards, grounding check
      observe(response, labels)  → one observation row
   for each follow-up pair:
      turn 1 → capture intent → turn 2 with that context → resolved?
   summarise(observations, env)  → report, gated
   refusalStats(results)         → did it decline what it should have?

runStaleAnswerExperiment({chunkModel, cases})
   for each version-pair:
      indexScheme(v1, NEW)  → indexScheme(v2, UPDATED)     the REAL indexer
      retrieve(query)                     version-aware arm
      retrieve(query, includeHistorical)  baseline arm  ← ONE variable
      quotesOldValue(results)             stale?
   coverage control → comparisonValid
```

## 5. FILES CREATED

| File | Lines | Purpose |
|---|---|---|
| `src/evaluation/metrics.js` | 305 | Definitions, aggregation, the honesty rules |
| `src/evaluation/questionSet.js` | 121 | 24 questions, 2 follow-up pairs, label slots |
| `src/evaluation/harness.js` | 186 | Runs the set through the real agent |
| `src/evaluation/staleAnswerExperiment.js` | 219 | The headline experiment |
| `scripts/runEvaluation.js` | 168 | CLI |
| `tests/evaluation.test.js` | 41 tests | Tests for the instrument |

## 6. FILES MODIFIED

| File | Change |
|---|---|
| `src/services/chatService.js` | The three defect fixes (§2) + `describeRankingSignals` |
| `src/services/recommendationPropagation.js` | **One line**: export `isActive` so chat imports rather than copies it |
| `src/agents/conversationalAgent.js` | Exports `buildGroundingSet` for the harness; no behaviour change |
| `tests/chatService.test.js` | +6 regression tests |
| `tests/conversationalAgent.test.js` | unchanged behaviour, export alignment |
| `package.json` | `evaluate`, `evaluate:stale` scripts |

**No database change. No API change. No frontend change.**

## 7. THE HONESTY RULES, ENFORCED IN CODE

Three rules are mechanical rather than left to discipline, because a
measurement instrument that reports a plausible wrong number is worse than one
that reports nothing — that is the kind of error that survives into a thesis
and is caught only by someone reproducing it.

1. **NO DEFAULTS.** A metric with no observations reports `null`, never `0`.
   `rate(0,0) → {value: null, n: 0}`. "No questions were asked" and "no
   question succeeded" must not render identically.
2. **QUALITY IS GATED ON PROVIDER.** Under `local-hash`, or if *any*
   observation carries degraded vectors, the entire quality block reports
   `measurable: false` and prints **WITHHELD** with the reason. Plumbing
   metrics still report — they are provider-independent.
3. **SAMPLE SIZES TRAVEL WITH THE NUMBERS.** Every rate carries its `n`, so a
   grounding rate of 1.0 over 3 questions cannot be mistaken for a result.

A fourth rule emerged during implementation: **fallbacks are classified, not
lumped.** `deterministic-fallback` (provider down), `deterministic-override`
(model contradicted the matcher) and `deterministic-ungrounded` (model invented
a figure) are the same fallback rate and **opposite findings**. A
config-disabled LLM is excluded from the denominator entirely — it was never
asked.

## 8. WHAT WAS ACTUALLY MEASURED

Executed in this sandbox, on synthetic fixtures, with `local-hash` embeddings
and **no LLM**:

### Stale-answer experiment — the headline result

| Arm | Stale answers | Coverage |
|---|---|---|
| **Version-aware (this system)** | **0 / 5** | 100% |
| **Baseline (same retriever, filter removed)** | **5 / 5** | 100% |

`comparisonValid: true` — both arms answered every question, so the difference
is not an artefact of one arm staying silent.

**The scope sentence, emitted with the result so the number cannot travel
without it:**

> In a synthetic corpus of 5 scheme version-pairs, each containing a single
> numeric eligibility-threshold change, version-aware retrieval returned no
> superseded threshold value, while an otherwise identical baseline with the
> version filter removed did, at equal retrieval coverage.
>
> **Scope and limits.** The baseline models an **accumulating index** — one
> that adds each crawl's chunks without invalidating the previous version.
> That is the common naive design, but not the only one: a pipeline that
> **deletes and re-indexes** has no staleness of this kind, at the cost of
> retaining no history and of leaving a scheme with nothing retrievable if a
> re-index fails midway. Against an accumulating baseline the direction of this
> result is **close to structural** — if both versions are present and the
> query matches both, the superseded text is returned — so the contribution is
> **not that the number is surprising**, but that the system has a principled
> invalidation path and preserves history at the same time. The measurement is
> provider-independent and is **NOT** a measurement of retrieval quality,
> semantic accuracy, or end-to-end answer correctness.

### Question set

| Metric | Value | Reading |
|---|---|---|
| Intent accuracy | 100% (24/24) | **See the caveat below** |
| Follow-up context resolved | 2/2 | A bare "why?" inherits the prior intent |
| Correct refusals | 4/4 | Off-domain questions declined, not guessed |
| Grounded | 50% (12/24) | Expected: retrieval was stubbed empty |
| LLM fallback | not measured (n=0) | LLM disabled, so never asked |
| Retrieval quality | **WITHHELD** | Lexical provider |
| Precision@k | **not measured (n=0)** | No relevance labels exist |

**The intent-accuracy caveat, stated plainly: 100% is close to circular.** I
wrote both the question set and the routing regexes. It measures that the
router is deterministic and matches its own design — **not** that it handles
real user phrasing. A question set written by someone else, or drawn from real
usage, is the only thing that would make this number meaningful. It is
reported because the harness measures it, not because it is evidence.

## 9. WHAT IS **NOT** MEASURED, AND WHY

- **Retrieval quality.** Requires (a) a semantic embedding provider, (b) human
  relevance labels, (c) a real corpus. `expectedSchemeIds` is **empty on every
  question**, deliberately — `computeRetrievalHit` returns `null` for an
  unlabelled question, so it is **excluded from the denominator** rather than
  counted as a hit or a miss. Precision therefore reads `not measured (n=0)`,
  which is much harder to mistake for a real score than a fabricated 0.0 or
  1.0. **Populating those labels is the single biggest remaining item before
  any retrieval-quality claim.**
- **Real LLM behaviour.** No provider call was made. Fallback rates, grounding
  rejections and latency for the LLM path are all `not measured`.
- **Real MongoDB / Atlas latency.** All runs used the in-memory model double.
- **End-to-end HTTP latency.** The harness drives the agent, not the route.
- **Real Jest.** `npm install` still fails (403 on every registry). All 722
  results come from **miniJest**.

## 10. TESTS

**41 tests in `tests/evaluation.test.js`.** Mostly tests of *refusal* — the
ways the instrument could produce a plausible wrong number without erroring:

- percentile/mean correctness, hand-verifiable
- null-not-zero, and a genuine 0% distinguished from an unmeasured one
- unit labelling: counts are not reported under `meanMs`
- the provider gate, in both directions (it must also *permit* when clean)
- unlabelled questions excluded from precision
- fallback classification, and the disabled-LLM exclusion
- the harness reporting the config it *actually ran under*
- errors recorded, not silently dropped
- refusal stats separate from grounding
- stale-experiment: stale definition, coverage control, scope emission

## 11. MUTATION TESTS

**7 mutants introduced into the Phase O code; 6 killed immediately, 1 survived
and was fixed.**

| Mutant | Result |
|---|---|
| Empty rate defaults to `0` | killed — 6 tests |
| Provider gate removed | killed — 4 tests |
| Unlabelled question counted as a miss | killed — 3 tests |
| Counts reported under `meanMs` | killed — 1 test |
| Coverage control dropped | killed — 2 tests |
| `chatLlmEnabled` read from env, not from the run | killed — 1 test |
| **Stale check ignores chunk status** | **SURVIVED → fixed** |

**The survivor, and what it exposed.** My "does NOT count an ACTIVE chunk" test
used a chunk carrying the **new** value, so removing the status check entirely
still passed it — the assertion never exercised the guard it was named for. The
case is reachable in production: if a supersede fails, v1 stays ACTIVE while
carrying the old figure. "Stale" must mean *text the system marked superseded*,
not *any text containing an old number* — otherwise the metric would count a
live **indexing** fault as a **retrieval** failure and point at the wrong
subsystem. Test corrected; mutant now killed.

Plus 3 Phase-N defect reverts (§2), each confirmed to fail its regression test.

## 12. TEST RESULTS

```
722 passed, 0 failed, 0 skipped, 1 suite skipped   (miniJest, 725 ms)
```

Phase N baseline **675** + 41 evaluation + 6 chat-service regressions = **722**.
**No regression.**

```
npm run verify:agents
  Policy Change Agent — 73 passed, 0 failed
  Policy Impact Agent — 136 passed, 0 failed
npm run demo:policy-change   -> passed
npm run evaluate             -> ran, output in §8
```

## 13. HOW TO GET REAL NUMBERS

```bash
# 1. auth must work first — chat is unreachable without it
JWT_SECRET=<48 random bytes>

# 2. a semantic provider, and a full re-index
EMBEDDING_PROVIDER=gemini
#    existing local-hash vectors are NOT comparable — discard, do not mix

# 3. label the question set
#    src/evaluation/questionSet.js → expectedSchemeIds
#    human relevance judgements against the real corpus

# 4. real retrieval + real LLM
CHAT_LLM=true
#    point harness buildData at the real models instead of the fixture

npm run evaluate --json results.json
```

The script prints a warning under `local-hash` and withholds quality metrics,
so a run that skips step 2 cannot silently produce quality numbers.

## 14. LIMITATIONS

1. **Intent accuracy is near-circular** (§8) — same author for questions and
   regexes.
2. **The stale-answer result is close to structural** against an accumulating
   baseline. The scope sentence says so rather than implying a surprise.
3. **Synthetic corpus.** 5 version-pairs, single-figure changes. Real drift
   includes prose rewrites, field additions and status changes, which this does
   not cover.
4. **No statistical treatment** — no confidence intervals, no repeated trials.
   With n=5 and a deterministic pipeline there is nothing to be uncertain
   about yet; with a real corpus and a real provider there will be.
5. **The harness bypasses HTTP**, so nothing here says anything about the API
   layer.
6. **Carried over:** `JWT_SECRET` unset; Atlas/Gemini/SMTP credentials still
   look live and **unrotated** — I have not rotated them. Atlas
   `$vectorSearch` still never executed. **No multilingual support** — Phase M's
   `language` field is a retrieval filter; there is no translation and no
   non-English content.

## 15. RESEARCH CONTRIBUTION

Phase O contributes the **instrument**, and one measured result.

The instrument's design is itself the argument: in a project whose claims are
about *failure behaviour*, the measurement layer is where fabrication is
easiest and least detectable. So the honesty constraints are mechanical —
absent measurements report null, quality figures are withheld under a lexical
provider, unlabelled questions are excluded rather than scored, and every rate
carries its `n`. Mutation testing confirms each of those is load-bearing:
removing any one lets the harness emit a plausible number it has not earned.

The measured result supports the Phase M claim at a specific, bounded scope:
version-aware retrieval returned **no** superseded threshold across 5
version-pairs where an otherwise identical accumulating baseline returned one
every time, **at equal coverage** — the control that rules out the degenerate
explanation of a retriever that simply answers less.

**Not claimed:** retrieval quality, semantic accuracy, end-to-end correctness,
latency on real infrastructure, or anything about real-model behaviour. §9 lists
what closing each would take.

---

*Phase O complete. At the time this report was produced, Phase P had not started.*
