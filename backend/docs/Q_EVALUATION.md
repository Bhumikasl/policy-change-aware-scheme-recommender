# Q_EVALUATION.md — propagation soundness

**Phase Q measures the project's central claim.**

H–P built the machinery: detect a policy change, work out who it affects,
propagate it, explain it, notify. Phase O measures retrieval and stale answers.
Phase P measures the safety guards. Nothing measured the step the whole
contribution rests on — whether the *targeted candidate query* can miss a user
whose eligibility genuinely moved.

That is not a performance question. From the architecture, unchanged since H:

> A too-wide query is slow. A too-narrow query silently fails to tell someone
> they lost a benefit.

---

## What is measured

For every case in a labelled corpus, the Impact Agent runs **twice** over the
same population:

| run | candidate query |
|---|---|
| pipeline | the band the agent derives from the diff |
| oracle | discarded — every user examined |

Same matcher, same transition classifier, same closed-scheme handling, same
inputs. **The candidate query is the only difference**, so any disagreement is
attributable to it and to nothing else.

`missed` — a user the oracle says moved and the pipeline never reached — is the
finding that matters. Each entry is a person the system would not have told.

### Why ground truth is computed, not written

A hand-written "expected affected users" list would be a second implementation
of the eligibility rules. It would drift, and every disagreement would be
ambiguous: is the pipeline wrong, or is the label? The usual outcome is that
whichever is easier to edit gets "fixed" until the numbers agree. That produces
a green result and no knowledge.

---

## Result — offline run, 2026-08-29

```
npm run evaluate:propagation
```

| | |
|---|---|
| population | 240 users (**synthetic**, deterministic) |
| corpus | 16 change shapes (**synthetic**) |
| store | **SIMULATED_STORE** — filters evaluated in process |
| status | **SOUND** |

**Soundness**

| metric | value |
|---|---|
| unsound cases | **0** (must be 0) |
| users the pipeline never told | **0** |
| recall over affected users | **100.0% (1115/1115)** |

**Narrowing**, where a band was attempted

| metric | value |
|---|---|
| users not re-scored | **75.3% (1808/2400)** across 10 cases |

**By candidate-selection mode**

| mode | cases | users affected | recall | scan reduction |
|---|---|---|---|---|
| targeted-band | 9 | 505 | 100% | 76.6% |
| targeted-union | 1 | 36 | 100% | 63.8% |
| full-scan | 5 | 574 | 100% | 0% (by definition) |
| none | 1 | 0 | **NOT MEASURED** | — |

`none` reports NOT MEASURED rather than 100%: no user moved in that case, so it
demonstrates nothing about the band. Scoring it as a success would pad the
average with a case that tested nothing.

---

## What this number is NOT

- **Not a measurement of MongoDB.** Filters were evaluated in process by
  `src/evaluation/queryEvaluator.js`. Index behaviour, type coercion and Mongo's
  own matching semantics are **not** covered. Use `--live` for that.
- **Not a measurement of real policy.** The corpus is constructed to span change
  *shapes*, not to reflect how often each occurs. It says nothing about the
  distribution of real Indian government policy changes.
- **Not a measurement of notification delivery, LLM behaviour or retrieval
  quality.** Those are Phases L, P and O.
- **Not a claim that the agent is sound in general.** It is sound *on these
  shapes, on this population*. A change shape absent from the corpus is
  unmeasured.

---

## Is 100% vacuous?

That is the right question to ask of any perfect score, so it was tested by
mutation. Each mutation was applied to the Impact Agent, the experiment re-run,
and the mutation reverted:

| mutation | detected | users missed |
|---|---|---|
| income band upper bound `$lte` → `$lt` | **yes** — 4 cases unsound | 17 |
| state/occupation symmetric difference keeps additions only | **yes** — 2 cases unsound | 88 |
| "income cap introduced" bands instead of full-scanning | **yes** — 1 case unsound | 4 |

The instrument detects an unsound band. The 100% is a measurement, not an
absence of measurement.

### A defect the mutation testing found in the harness itself

The first version of the oracle differed from the pipeline run only by a model
wrapper that ignored the filter. That is **not sufficient**: `assessImpact`
returns *before touching the model at all* when the query classifies as `none`.
So a banding bug that selected **nobody** produced an empty pipeline result and
an equally empty oracle — and the comparison reported a serene `0 missed`.

Mutation 2 above exposed it: `state-list-reduced` selected nobody and the
harness called it SOUND. The oracle now forces the full-scan path explicitly, so
its result no longer moves with the agent's banding. The stable denominator
across mutations (1115 in every run) is the evidence.

This is recorded rather than quietly fixed because a harness that has never been
shown to fail is not evidence of anything.

---

## Running it

```bash
npm run evaluate:propagation                      # offline, simulated store
npm run evaluate:propagation -- --out q.json      # machine-readable
npm run evaluate:propagation -- --users 1000      # larger population

npm run evaluate:propagation:live                 # against the real database
```

`--live` **writes to your database**: it inserts users whose `_id` begins with
`q-user-`, runs the same corpus through Mongoose, and deletes exactly those
users afterwards. It touches nothing else. It requires `MONGODB_URI` and
refuses to report a live result without one. **Do not point it at production.**

A `--live` run is the only way to measure the banding *as Mongo executes it*.
The two modes are reported separately and never merged; `store` in the output
says which produced the number.

Exit code is non-zero when the run is UNSOUND or FAILED, so CI can gate on it.

---

## Status of the live run

**REAL DATABASE RESULT: NOT MEASURED.**

`--live` has never been executed. Running it requires an Atlas connection, which
was not available in the environment where this harness was written.
