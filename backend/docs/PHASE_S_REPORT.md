# PHASE S — Staleness Bound

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase S only.** At the time this Phase S report was produced, Phase T had not started.

---

## 1. There is no official Phase S specification

I searched the whole repository — `docs/`, `README.md`, `MERGE_MANIFEST.md`,
every architecture and evaluation document, source comments, tests — for a
Phase S definition. **There is none.** (Phase R *was* specified, in
`NOTIFICATION_ARCHITECTURE.md`; Phase S is not.)

So Phase S is inferred, from one gap the existing evaluations leave open.

---

## 2. The gap

Four experiments now examine the project's central claim:

| | asks |
|---|---|
| O | is the retrieved evidence stale? *(the knowledge base)* |
| P | do the safety guards hold? *(the LLM layer)* |
| Q | does the targeted band miss anyone? *(**who**)* |
| R | is the targeted flow actually cheaper? *(**cost**)* |

**None of them asks *when*.**

A propagation that reaches exactly the right people and is six months late is
not a correct propagation — it is a wrong recommendation that eventually
stopped being wrong. For a system that calls itself a *monitor*, the quantity
that matters is the worst case: **the longest a user can hold a recommendation
the policy has already invalidated.**

---

## 3. The defect this found

**`retryFailedPolicyProcessing` was scheduled by nothing.**

It has existed since Phase J. It is implemented, exported, unit-tested and
documented. It was reachable **only** by a human typing `npm run policy:retry`.
The comment on the notification sweep in `scheduler/cron.js` even referred to
"the policy retry sweep" as though it ran.

**Consequence.** A transient failure in the impact or propagation stage marked
the row `policyRetryable: true` — and nothing ever came back for it. The
affected users kept a recommendation the policy change had already invalidated,
with **no bound on how long**, in a system whose entire claim is that a policy
change propagates automatically.

**Why every suite missed it.** The function worked. Its unit tests passed. They
pass identically whether or not anything calls it — which is precisely how this
survived Phases J through R.

**Reproduction:**

```
$ npm run evaluate:staleness -- --without-policy-sweep

overall bound : UNBOUNDED
UNBOUNDED because these stages have NO automatic recovery:
    - policy-analysis

stage                   recovered by                  max wait      schedule
collection              collection cycle (next tick)  24 h          0 3 * * *
policy-analysis         *** NOTHING ***               NOT MEASURED  -
notification-delivery   notification retry sweep      5 min         */5 * * * *
rag-indexing            RAG re-index sweep            1 h           0 * * * *

exit 1
```

**Fix.** A fourth job in the **same** scheduler, following the notification and
RAG sweeps exactly: its own interval (`POLICY_RETRY_CRON`, hourly), its own
overlap guard, its own try/catch. No second scheduler, no new service.

**Regression test.** *"schedules the policy retry sweep"* — asserted against
the scheduler's source, because the defect was never in the function.

---

## 4. Method

The staleness window has two parts and **only one can be measured**:

| part | status | why |
|---|---|---|
| detection delay | **DERIVED** | a property of the cron *schedule*, not the code. Arithmetic on the configured interval. A benchmark cannot measure it. |
| processing time | **MEASURED** | real code doing real work, timed in process. |

Every figure carries which it is. A summed "window" that blurred them would
look like a measurement and be a config setting with a rounding error attached.

The part that is *not* arithmetic is the recovery analysis: for each stage that
can fail, is there something that runs again without a human? A stage with no
such path has no worst case at all — the window is **UNBOUNDED**, and no amount
of schedule tuning changes it.

**One unrecovered stage makes the whole system unbounded.** Averaging it away
with the stages that do recover would describe a system that does not exist:
the user whose policy stage failed is not helped by the notification sweep
running every five minutes.

---

## 5. Result — after the fix

```
overall bound : BOUNDED

stage                   recovered by                  max wait      schedule
collection              collection cycle (next tick)  24 h          0 3 * * *
policy-analysis         policy retry sweep            1 h           0 * * * *
notification-delivery   notification retry sweep      5 min         */5 * * * *
rag-indexing            RAG re-index sweep            1 h           0 * * * *

WORST-CASE CORRECTION WINDOW
  DERIVED  : 25 h   (configured cron intervals; assumes every attempt succeeds)
  MEASURED : NOT MEASURED — no pipeline timing supplied
```

**25 h is DERIVED, not measured**: 24 h until the next collection tick plus 1 h
until the next policy sweep, on the default schedules. It is what the schedule
*permits*, not what was observed. Under `CRON_SCHEDULE=0 */6 * * *` it becomes
7 h — a config change, not an improvement in the code.

**NOT MEASURED:** real detection delay (depends on when a ministry publishes),
SMTP/MongoDB/Atlas latency, and how often a stage actually fails in production.

---

## 6. Files

**Created:** `src/evaluation/stalenessBound.js`,
`scripts/runStalenessAnalysis.js`, `tests/stalenessBound.test.js`,
`docs/PHASE_S_REPORT.md`

**Modified:** `src/scheduler/cron.js` (fourth job), `.env.example`
(`POLICY_RETRY_CRON`, `POLICY_RETRY_LIMIT`), `package.json` (one script),
`tests/ragPipeline.test.js` (two assertions rescoped — see §7)

**Deleted:** none. No model, schema, index, route, API or frontend file changed.

---

## 7. A test I had to change, and why it is not a weakening

`ragPipeline.test.js` asserted the RAG sweep *"calls only the re-index sweep,
never a policy agent"* — by checking the **whole scheduler file** contained no
`retryFailedPolicyProcessing`. Correct while three jobs existed and none was
allowed to touch policy work. Phase S adds a fourth job that legitimately calls
it, and a file-wide assertion cannot tell *"the RAG sweep re-runs policy
agents"* (a real defect) from *"a different job does"* (that job's purpose).

Rescoped to the RAG job's own body, by splitting on `cron.schedule(`. The
invariant is unchanged and now **sharper** — the forbidden symbols are barred
from the RAG sweep specifically, wherever it sits in the file. Verified by
mutation **S-M2**: inserting a policy call into the RAG body still fails.

A sibling test asserted `cron.schedule(` appeared exactly 3 times. Now 4. The
invariant there is *one scheduler*, not *three jobs*; the single
`require("node-cron")` assertion is what actually protects it, and that is
untouched.

---

## 8. Mutation testing

| mutation | outcome |
|---|---|
| S-M1 policy sweep call removed, import kept | **survived → test strengthened → killed** |
| S-M2 RAG sweep re-runs policy work | killed |
| S-M3 one unrecovered stage no longer UNBOUNDED | killed |
| S-M4 unsupported cron shape gets a fabricated bound | **survived → test strengthened → killed** |
| S-M5 policy sweep loses its overlap guard | killed |

**Two survived on the first pass, and both mattered.**

**S-M1 was the original defect.** My wiring test matched the symbol anywhere in
the source — including the *import line* — so replacing the call with a no-op
passed. Fixed by asserting the call appears inside a `cron.schedule(` body.

**S-M4:** `maxIntervalMinutes` returning a fabricated 60 for an unparseable
schedule. Every unsupported case in my test was caught by an earlier branch
(wrong field count, or a day restriction), so the mutated line was never
reached. Fixed by adding five-field expressions using range, list and name
syntax: `"0 0 * * MON"`, `"1-30 * * * *"`, `"0,30 * * * *"`.

Recorded rather than quietly fixed: a test that has never been shown to fail is
not evidence.

---

## 9. Research contribution

**Problem.** Correctness claims about change-propagation systems are stated
without a time bound. "The system propagates policy changes to affected users"
is not falsifiable until you say *within what interval*, and *what happens when
a stage fails*.

**Method.** Separate the window into a schedule-derived part and a measured
part, refuse to sum them into one number, and check every stage for an
automatic recovery path. Treat a single unrecovered stage as making the whole
system unbounded.

**Finding.** The system's headline claim had an **unbounded** worst case, and
the cause was not a missing feature — the recovery function was written,
tested, and documented. It was never called. This is a failure mode unit
testing structurally cannot catch, and it is worth reporting as such.

**Honesty.** The 25 h bound is DERIVED from configuration, explicitly not
measured. No latency, throughput or failure-rate measurement is claimed.

---

## 10. Reproducibility

```bash
npm run evaluate:staleness                          # current deployment
npm run evaluate:staleness -- --without-policy-sweep  # the pre-S defect
npm run evaluate:staleness -- --out s.json
```

Reads the same environment variables the scheduler reads, so it describes the
deployment it runs in. Exits non-zero when any stage has no recovery path —
that condition is a defect, not a setting, so CI can gate on it.

---

*Phase S complete. At the time this report was produced, Phase T had not started.*
