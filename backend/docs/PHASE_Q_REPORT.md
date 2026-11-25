# PHASE Q — Propagation Soundness Evaluation

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase Q only.** At the time this Phase Q report was produced, Phase R had not started.

---

## Why this is Phase Q and not something else

Phase Q was **not** specified in the brief. The Phase P proposal in this
repository says, in writing:

> Either way I would not propose a Phase Q. After P the project has an
> architecture, an implementation, an evaluation instrument, and a measured
> result. That is a complete piece of work, and further phases would be padding.

That assessment was mostly right and one thing was missing from it. Phases O and
P measure the **conversational layer**: retrieval quality, stale answers,
grounding and contradiction guards. They measure the part of the system where an
LLM is involved.

They do not measure the part that is the actual contribution:

> We detect government policy drift and automatically propagate that change
> through affected-user eligibility and personalized recommendations.

The propagation step is only affordable because the Impact Agent does not
re-score every user — it derives a narrow candidate band from the diff. Before
Phase Q, the evidence for that band being *correct* was:

- unit tests asserting the **contract fields** (`narrowingProven`,
  `completenessGuaranteed`) — which assert that the agent *claims* soundness;
- one efficiency figure, **79.3%**, which is synthetic, structured-only, and
  measures **narrowing**, not correctness.

Nothing measured whether the band can lose somebody. That is the project's most
serious failure mode and it was the last unmeasured one. Phase Q measures it.

**Anything beyond this would be padding**, and that assessment has not changed.

---

## What Phase Q adds

An experiment, in the shape Phases O and P established: a labelled corpus, an
oracle, a metrics module that refuses to flatter the result, a CLI, and a
document that separates what was measured from what was not.

No production behaviour changes. No new model, route, scheduler, notification
path, or environment variable.

### Files created

| file | role |
|---|---|
| `src/evaluation/propagationCorpus.js` | 16 labelled change shapes + a deterministic 240-user population |
| `src/evaluation/propagationOracle.js` | ground truth: the same agent, filter removed |
| `src/evaluation/propagationHarness.js` | runs the corpus; in-process user store |
| `src/evaluation/propagationMetrics.js` | aggregation and reporting |
| `src/evaluation/queryEvaluator.js` | evaluates the Mongo operators the agent emits |
| `scripts/runPropagationEvaluation.js` | CLI, offline and `--live` |
| `tests/propagationEvaluation.test.js` | 19 tests |
| `docs/Q_EVALUATION.md` | the result, and what it is not |

### Files modified

| file | change |
|---|---|
| `package.json` | two scripts: `evaluate:propagation`, `evaluate:propagation:live` |

Nothing else. **No file under `src/agents/`, `src/services/`, `src/routes/`,
`src/models/` or `frontend/` was touched.**

---

## The design decision that matters

Ground truth is **computed by the same agent with the candidate filter
discarded**, not written by hand and not re-implemented.

A hand-written expected-affected list is a second implementation of the
eligibility rules. It drifts, and when the two disagree nothing says which is
right — so whichever is easier to edit gets adjusted until the numbers agree.
That yields a green result and no knowledge.

Running `assessImpact` twice over the same population, differing **only** in the
candidate query, isolates the variable under test. Any disagreement is
attributable to the filter, because the filter is the only thing that differs.

This needed **no production change**: `assessImpact` already accepts `userModel`
by injection, so a wrapper whose `find()` ignores the filter forces the full
scan. The agent cannot tell the difference and therefore cannot behave
differently.

---

## Result

**SOUND.** 0 unsound cases, 0 users missed, recall **100.0% (1115/1115)**,
scan reduction **75.3% (1808/2400)** across the 10 banded cases.

Full table, per-mode breakdown, and the list of things this does not measure:
`docs/Q_EVALUATION.md`.

The corpus is **SYNTHETIC** and the offline store is **SIMULATED**. The
`--live` run against a real database has **NOT been executed**.

---

## Defect found — in the harness, not the product

Required by the defect-first rule, and worth recording because it is the reason
to trust the result at all.

**Root cause.** The first oracle differed from the pipeline run only by a model
wrapper that ignored the filter. But `assessImpact` returns *before touching the
model* when `buildImpactQuery` classifies the query as `none`. A banding bug
that selected **nobody** therefore produced an empty pipeline result **and** an
empty oracle, and the comparison reported `0 missed`.

**Reproduction.** Mutation 2 (state/occupation symmetric difference keeps
additions only) made `state-list-reduced` select nobody. The harness scored it
SOUND.

**Fix.** The oracle forces the full-scan path explicitly. `isNew` is used in
exactly one place in the agent — to select `filter: {}` with the full-scan
contract — so setting it means "scan everyone" and nothing else.

**Evidence it is fixed.** The oracle's denominator is now **stable at 1115
across every mutation**, where before it moved with the agent's banding. The
same mutation now reports 2 unsound cases and 88 users missed.

**Regression test.** *"finds affected users even when the pipeline query selects
nobody"* — builds a case whose query classifies as `none` and asserts the oracle
still finds the movers.

A second, smaller finding: the corpus originally used education tokens
(`"12th"`, `"Postgraduate"`) that are not on the canonical ladder in
`services/eligibilityLevels.js`. The agent correctly fell back to a full scan —
its documented fail-safe — and the harness's candidate-selection drift check
caught the mismatch on the first run. The corpus was corrected, and a case using
a deliberately unmappable rung was **added**, so the fail-safe is now measured
rather than hit by accident.

---

## Mutation testing

Applied to the Impact Agent and to the harness, each reverted after:

| mutation | test that failed |
|---|---|
| income band `$lte` → `$lt` | corpus runs SOUND |
| oracle drops `isNew` | oracle finds users when the query selects nobody |
| evaluator matches null against a range | evaluator does not match null |
| evaluator ignores an unknown operator | evaluator throws on unknown operator |

Against the harness alone (measured, not asserted): the off-by-one missed 17
users across 4 cases; the symmetric-difference bug missed 88 across 2; banding
an introduced income cap missed 4.

---

## What was NOT verified

- **`--live` against MongoDB.** Never executed. `store: REAL_MONGODB` has never
  been produced.
- **Real Jest.** Not run in the environment where Phase Q was written; `npm
  install` is blocked there. Figures quoted are from the project's offline
  runner, which is **not Jest**.
- **Frontend.** Phase Q has no frontend surface, so nothing was built or linted
  for it.

---

## Frontend

**Phase Q adds no frontend.** It is an evaluation instrument, as Phases O and P
are, and neither of those has a UI either. Adding a page to display a research
figure would be a feature nobody asked for, and the project's rules are explicit
about not doing that.

---

*Phase Q complete. At the time this report was produced, Phase R had not started — and, as with the Phase P
proposal, I would not propose one.*
