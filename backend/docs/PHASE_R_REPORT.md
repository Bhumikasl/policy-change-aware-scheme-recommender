# PHASE R — Notification Cost Measurement

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase R only.** At the time this Phase R report was produced, Phase S had not started.

---

## 1. Where Phase R comes from

**Phase R was already specified inside this repository.** It was not inferred
and not invented. `NOTIFICATION_ARCHITECTURE.md` defers exactly two questions to
it, in writing:

> **No scalability claim is made here.** The flow is narrower by construction;
> whether that yields a measured improvement on a real population is a **Phase R
> question and has not been measured**.

> Revisit [a message broker] when a measured collection cycle spends a material
> fraction of its time in delivery… **That measurement belongs to Phase R and
> has not been taken.**

Both are cost questions about the same path. Both were unanswerable because the
instrument did not exist. Phase R is that instrument.

| | question |
|---|---|
| **R.1** | Does the targeted flow interrupt fewer people than the legacy full-scan notifier, on a population? |
| **R.2** | Does a collection cycle spend a material fraction of its time in delivery — the documented trigger for adopting a broker? |

---

## 2. Method

**R.1** runs both paths over the same population against the same scheme.

The baseline is **not a reconstruction**. It is `notifyMatchingUsers` — the
actual pre-Phase-I function, still in the tree behind `LEGACY_NOTIFIER=true` —
executed for real. A re-implementation would be a second set of bugs, and every
disagreement between them would be ambiguous.

The targeted arm runs the three production units in sequence: `assessImpact` →
`classifyEligibilityTransition` → `decideNotification`. It stops before the
database write, because R.1 counts people interrupted, not rows.

The population is the **same synthetic corpus Phase Q uses** — reused, not
duplicated, so both experiments describe the same population.

**R.2** reads `notificationDurationMs`, added to the policy record in this phase,
and evaluates the rule the architecture document already committed to: is
delivery ≥ 25% of cycle time?

---

## 3. Result — offline, 2026-08-29

```
npm run evaluate:notification-cost
```

### R.1 — MEASURED

| | |
|---|---|
| legacy full-scan notified | **1716** |
| targeted flow notified | **1089** |
| **reduction in interruptions** | **36.5% (627/1716)** |
| users scanned | **53.3% (2048/3840) fewer** |

**Coverage — the counterweight**

| | |
|---|---|
| reached by legacy only | **1197** — nothing moved for them |
| reached by targeted only | **570** — the baseline could not see them |

That second number is the more interesting finding, and it is not a compliment
to the targeted flow so much as an indictment of the baseline. The legacy filter
is `isMatch(user, schemeAfter)`, so **a user who just LOST eligibility fails the
filter and is never emailed**. The old path was not merely noisier — it was
structurally blind to the people with the most at stake.

Reporting "36.5% fewer notifications" without that line would flatter the result
and misdescribe what the baseline did.

The clearest single row is `no-material-change`: a ministry rename, nothing
moved for anyone. Legacy **104**, targeted **0**.

### R.2 — NOT MEASURED

No cycle in this environment recorded both a total and a notification duration,
so the delivery fraction is `null` and the broker recommendation is `null` —
**not 0% and not "no broker needed"**. An unmeasured cycle can neither justify a
broker nor rule one out.

The instrumentation now exists. To take the measurement on a real deployment:

```bash
npm run evaluate:notification-cost -- --cycles cycles.json
```

where `cycles.json` is an array of `{ totalMs, notificationDurationMs }` from
instrumented runs.

---

## 4. Defects found and fixed

### 4.1 The legacy notifier had no injection seam (blocking)

`notifyMatchingUsers` imported `User` and `NotificationLog` directly. Measuring
the baseline over a corpus was impossible without reaching the real Mongoose
models — the same escape that made the RAG and notification stages hang the
integration suite, since with no connection mongoose **buffers** rather than
throwing.

It is also why the integration suites `jest.mock` the whole notifier module
rather than injecting into it, which means **the real baseline was never
exercised by any test**.

**Fix:** a fifth `deps` parameter defaulting to the real models. Production is
unchanged. **Mutation R-M5** (ignore the injected model) → 3 tests fail.

### 4.2 The notification stage had no clock on it

`durationMs` and `ragDurationMs` existed; delivery had neither. R.2 was
unanswerable by construction.

**Fix:** `record.notificationDurationMs`, set in a `finally` so a **failed**
delivery still reports its cost — a timing figure covering only successful runs
would understate exactly the case the broker decision cares about. Initialised
to `null`, not 0, because 0 reads as "delivery was instant" when it means
"delivery never happened".

### 4.3 Two corpus cases were inconsistent with the matcher (found by R)

`matcher.js` requires a scheme declared `constrained` to produce **at least one
positive match**. Two Phase Q cases left a `constrained` scheme with no
constraints at all:

- `gender-restriction-lifted` removed the only rule;
- `income-cap-introduced` had an empty "before" side.

Every user was ineligible on that side, so both cases measured the **opposite**
of their label. It surfaced as an impossible row in the R.1 table: the
full-scan baseline notifying **zero** users for a scheme that had just become
*less* restrictive.

**Fix:** carry an unchanged constraint on both sides. It produces no diff, so
candidate selection is unaffected.

**Effect on Phase Q:** Q compares pipeline against oracle, both using the same
matcher, so the soundness verdict was never at risk. Q remains **SOUND, 0
missed, 100% recall** — the affected-user total moved from 1115 to 1089 because
the cases now measure what they claim to.

**Regression test:** *"never declares a scheme `constrained` while giving it
nothing to constrain"*, which found 4.3's second instance immediately after the
first was fixed.

---

## 5. Files

**Created:** `src/evaluation/notificationCostExperiment.js`,
`src/evaluation/notificationCostMetrics.js`,
`scripts/runNotificationCostEvaluation.js`, `tests/notificationCost.test.js`,
`docs/PHASE_R_REPORT.md`

**Modified:** `src/services/notifier.js` (deps seam),
`src/services/policyPipeline.js` (timing), `src/evaluation/propagationCorpus.js`
(two cases), `package.json` (one script)

**Deleted:** none.

No model, route, schema, index, environment variable, scheduler job or frontend
file was changed. Phase R is additive.

---

## 6. Mutation testing

| mutation | killed by |
|---|---|
| baseline stops scanning everyone | *interrupts fewer people than the baseline* |
| reduction reported 1.0 when baseline notified nobody | *reports NULL, not 1.0* |
| broker fraction defaults to 0 | *is NOT_MEASURED — never 0%* |
| coverage gap hidden | *reports the people the baseline could NOT reach* |
| notifier ignores the injected model | 3 tests, incl. *touches no real model* |

---

## 7. Research contribution

**Problem.** Targeted change propagation is justified on the grounds that it
does less work than a full scan. That justification is almost always asserted
from the shape of the algorithm rather than measured.

**Novelty.** The comparison runs the *retired implementation itself* as the
baseline, rather than a description of it, and reports volume reduction only
alongside a coverage delta. That pairing is what stops "fewer notifications"
from being read as "better notifications".

**Finding.** The headline is not the 36.5% reduction. It is that the baseline
**could not reach 570 users the targeted flow reached** — the people who lost
eligibility. Targeting is not only cheaper here; the untargeted path was
*wrong* in the direction that matters most.

**Honesty.** R.1 is MEASURED on a SYNTHETIC corpus. R.2 is NOT MEASURED. No
SMTP, database or Atlas latency is included — timings are in-process compute
only. No throughput or concurrency claim is made.

---

## 8. Reproducibility

```bash
npm run evaluate:notification-cost
npm run evaluate:notification-cost -- --out r.json --users 1000
npm run evaluate:notification-cost -- --cycles cycles.json   # R.2
```

Deterministic: same population, same result, no seed to record.

---

*Phase R complete. At the time this report was produced, Phase S had not started.*
