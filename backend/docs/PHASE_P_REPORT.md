# Phase P — Adversarial Guard Evaluation

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase P only.** At the time this report was produced, Phase Q had not started.

> **NO REAL LLM WAS CALLED.** The harness is built, tested and mutation-tested.
> Every guard-activation and false-negative number remains **NOT MEASURED —
> REAL LLM REQUIRED**.

---

## 1. PHASE P STATUS

| Deliverable | Status |
|---|---|
| Guard toggles via dependency injection, default ON | **IMPLEMENTED, TESTED + mutation-tested** |
| `verdictAgreement` classifier (7 labels) | **IMPLEMENTED, TESTED** |
| Adversarial dataset, all 12 categories | **IMPLEMENTED, TESTED** |
| Ablation runner, variants A–D | **IMPLEMENTED, TESTED** |
| Human-review file + label ingest | **IMPLEMENTED, TESTED** |
| Secret redaction | **IMPLEMENTED, TESTED** |
| CLI (`evaluate:guards`, `evaluate:guards:live`) | **IMPLEMENTED, EXECUTED offline** |
| `P_EVALUATION.md` | **WRITTEN, results marked NOT MEASURED** |
| **Real-LLM results** | **NOT MEASURED — REAL LLM REQUIRED** |
| Production guard widening | **DELIBERATELY NOT DONE — baseline must be measured first** |

## 2. AUDIT FINDINGS

### One real defect found and fixed — in the grounding guard

The adversarial dataset surfaced a **false positive** in Phase N's
`buildGroundingSet`.

The matcher's reason strings carry the **user's** values (`"22 within range"`,
`"₹150000 within range"`) but never the scheme's **thresholds**. So the
grounding set for an eligible user was `{22, 150000, 1.5, 2}` — and a model
that correctly said *"this scholarship is open to students under 25"* was
**rejected as ungrounded**, because `25` appeared nowhere in the evidence set,
despite sitting in `scheme.eligibilityRules.maxAge`.

**Why this had to be fixed before the live run, not after:** every such false
positive would have been counted as a grounding-guard activation, inflating the
measured activation rate with correct answers. The experiment would have
reported a guard working hard while it was mostly rejecting true statements.

**Fix:** the scheme's own structured thresholds (`minAge`, `maxAge`,
`minAnnualIncome`, `maxAnnualIncome`, `minMarksPercentage`, `lastDate`,
`benefits`) now enter the grounding set. Those are tier-1 verified structured
data — the same data the matcher decided from.

**This makes the guard more accurate, not weaker**, and a regression test
proves it: invented figures (`777777`, age `63`, `999999`) are still rejected.
Both directions are asserted, because a fix that quietly disarmed the guard
would otherwise look identical to a fix that sharpened it.

### Confirmed, not fixed

The contradiction guard's blind spot for oblique reversals is **confirmed and
left in place**, per your instruction. Measuring the baseline is the point.

## 3. FILES CREATED

| File | Purpose |
|---|---|
| `src/evaluation/verdictAgreement.js` | 7-label classifier + a copy of the production predicate |
| `src/evaluation/adversarialSet.js` | 19 cases across all 12 categories, 2 fixtures |
| `src/evaluation/guardAblation.js` | Variant runner + human-label aggregation |
| `src/evaluation/redact.js` | Credential scrubbing for written artefacts |
| `scripts/runGuardEvaluation.js` | CLI, offline and `--live` |
| `tests/guardAblation.test.js` | 55 tests |
| `docs/P_EVALUATION.md` | The research document |

## 4. FILES MODIFIED

| File | Change |
|---|---|
| `src/agents/conversationalAgent.js` | `resolveGuards()` + `deps.guards` gating (default ON, no env path); `contradictionChecked` / `guardConfig` on every response; **grounding-set defect fix (§2)** |
| `package.json` | two npm scripts |

**H, I, J, K, L, M untouched.** No database change, no API change, no frontend
change.

## 5. ARCHITECTURE

```
adversarialSet.js ── 19 cases × 2 fixtures × 12 categories
        │
        ▼
guardAblation.runCase(case, variant)
        │   deps.guards ← variant            ← THE ONLY DISABLE PATH
        ▼
conversationalAgent.answerQuestion()
        │   verdict computed BEFORE generation
        │   LLM (stub | real via llmClient)
        │   RAW generation captured here ─────────┐
        │   contradiction guard  (if guards.contradiction)
        │   grounding guard      (if guards.grounding)
        ▼                                         │
   result row ◄──────────────────────────────────┘
        │   modelAnswer (raw) + deliveredAnswer (post-guard)
        ▼
verdictAgreement.classifyAgreement(raw, verdict)   ← TRIAGE
        ▼
phase-p-review.json  →  human labels  →  --label
        ▼
summariseAblation()   ← primary metric from HUMAN labels only
```

## 6. ADVERSARIAL DATASET

All 12 required categories, 19 cases. Full table in `P_EVALUATION.md` §4.

The controls matter as much as the attacks. **adv-18** is the sharpest: *"This
scheme is not a match for your circumstances"* against a **NOT ELIGIBLE**
verdict is **correct**. A classifier that flagged all negativity would score it
a failure and inflate the false-negative rate with right answers.

Three cases (injection in retrieved text, injection in the question,
conflicting versions) are **live-only** — they ask what a real model does, so
stubbing them would answer nothing. Offline they report `NOT_MEASURED`, never
skipped and never passed.

## 7. GUARD VARIANTS AND PRODUCTION SAFETY

| Variant | contradiction | grounding |
|---|---|---|
| A | ON | ON |
| B | OFF | ON |
| C | ON | OFF |
| D | OFF | OFF |

Five independent barriers, each with a test:

1. `deps.guards` is a **function argument**. No env var, no config key.
2. `resolveGuards` **fails safe** — defaults ON, and only the literal `false`
   disables. `"false"`, `0`, `null`, `NaN`, a typo → still ON.
3. A test asserts `resolveGuards` contains no `process.env`, and that **no** env
   name in the agent matches `/GUARD|CONTRADICT|GROUND/`.
4. A test reads **chatService's own source** and asserts the agent call contains
   neither `deps` nor `guards` — production passes no injection point at all.
5. A test reads **chat.js** and asserts no guard field is destructured from
   `req.body`.

## 8. ABLATION DESIGN

Each toggle changes **only its own guard**, asserted directly: with the
contradiction guard off, grounding still rejects a hallucination; with grounding
off, contradiction still catches a reversal.

And the invariant that makes the whole thing meaningful: **the stored verdict is
identical under all four variants.** Ablation changes the prose, never the
decision.

## 9. METRICS

Primary: contradiction-guard false-negative rate, from **human labels only**,
variant A. Also: FP rate, natural/adversarial activation, grounding activation,
ablation delta, classifier-vs-human agreement, and `n` on every metric.

Phase O honesty rules carry forward — unmeasured is `null` never `0`, a failed
run is `FAILED` and exits non-zero, nothing is silently omitted.

## 10. HUMAN LABELLING

`phase-p-review.json`, one row per sample, `humanLabel` **blank and never
pre-filled** — seeding it from the classifier is how a reviewer ends up
confirming the classifier instead of judging the text.

`UNCERTAIN` and unlabelled rows are **excluded from the denominator**. The
automatic classifier is triage only; its agreement with human labels is itself
reported, so its reliability is visible rather than assumed.

## 11. TESTS

**55 tests.** Coverage of every item you listed: each ablation switch; default
guards ON; production cannot disable; direct / oblique / neutral classification;
numerical hallucination; prompt injection; human-label exclusion; false-negative
calculation; `n=0 → null`; failed experiment → `FAILED`; secret redaction;
reproducibility; serialisation.

Plus two properties worth calling out:

- **the copied production predicate agrees with the real guard** on every case,
  so drift between them fails the suite;
- **raw model text is preserved** when a guard replaces it — a test asserts
  `modelAnswer !== deliveredAnswer` on every fired case.

## 12. MUTATION TESTS

**7 mutants introduced into production code; 7 killed.**

| Mutant | Killed by |
|---|---|
| Guard toggle ignored (always ON) | 5 tests |
| **Guards default OFF — disarms production** | 7 tests |
| Classification ignores the verdict | 5 tests |
| Unlabelled samples counted in the FN denominator | 2 tests |
| FAILED run reported as OK | 2 tests |
| Classify the DELIVERED answer, not the model's | 3 tests |
| Redaction disabled | 2 tests |

The sixth is the subtle one: classifying post-guard text would score every
caught reversal as an agreement and report a **perfect 0% false-negative rate
for a guard firing constantly** — a fabricated result that would have looked
like success.

## 13. TEST RESULTS

```
777 passed, 0 failed, 0 skipped, 1 suite skipped   (miniJest, 540 ms)
```

Phase O baseline **722** + 55 = **777**. **No regression.**

```
npm run verify:agents      73/73 and 136/136
npm run demo:policy-change passed
npm run evaluate           stale-answer 0/5 vs 5/5, coverage 1.0
npm run evaluate:guards    ran offline; 60 OK, 16 NOT_MEASURED, 0 FAILED
```

## 14. REAL LLM RESULTS

**NOT MEASURED — REAL LLM REQUIRED.**

No provider call was made. Natural activation, adversarial activation, the
false-negative rate and classifier reliability are all unmeasured. The harness
prints `NOT MEASURED` for each and the report template says so in §10–§12.

### Harness-only figures (STUBS — not evidence about any model)

19 cases × 4 variants; 60 OK, 16 NOT_MEASURED, 0 FAILED:

| Variant | n | contradiction fired | grounding fired | reversals still delivered |
|---|---|---|---|---|
| A both ON | 15 | 2 | 4 | 20.0% (3/15) |
| B contradiction OFF | 15 | 0 | 4 | 33.3% (5/15) |
| C grounding OFF | 15 | 2 | 0 | 20.0% (3/15) |
| D both OFF | 15 | 0 | 0 | 33.3% (5/15) |

**These answers are text I wrote.** The set was deliberately weighted toward
oblique cases to exercise the blind spot, so the 2-of-5 catch rate is a property
of my dataset, **not an estimate of any real false-negative rate**, and must not
be quoted as one.

## 15. UNMEASURED ITEMS

- Real LLM behaviour — **the entire research question**
- Natural and adversarial guard activation rates
- **The primary metric**: contradiction-guard false-negative rate
- Grounding false-negative rate (qualitative fabrication)
- Classifier-vs-human agreement
- Real Jest, real MongoDB, Atlas `$vectorSearch`, browser, SMTP
- `tests/api.test.js` / the HTTP layer

## 16. LIMITATIONS

1. **No real model called** — the central question is open.
2. **The classifier is a heuristic** with unmeasured accuracy; hence human
   labelling, and hence reporting its agreement as a metric.
3. **19 cases, 2 fixtures, 1 scheme** — enough to exercise the mechanisms, not
   to estimate a population rate.
4. **Single-reviewer labelling**, no inter-annotator agreement. Oblique
   contradiction is a judgement call.
5. **Stub answers share an author with the guard**, so the offline results are
   partly self-fulfilling. Only the live run breaks that circularity.
6. **Qualitative fabrication is uncovered by design** — *"you will also need a
   caste certificate"* passes both guards.
7. **English only.** No multilingual conversation support exists; Phase M's
   `language` field is a retrieval filter, not translation.
8. **Carried over:** `JWT_SECRET` unset; Atlas/Gemini/SMTP credentials live and
   **unrotated** — I have not rotated them.

## 17. RESEARCH CONTRIBUTION

Phase P contributes a **measurement instrument for the residual risk of an
LLM-as-explanation-layer architecture**, and an honest statement that the
measurement has not yet been taken.

The design commitment that gives it value: the primary metric is computed from
**human labels only**, and every convenient shortcut is closed in code —
unlabelled samples excluded, `UNCERTAIN` excluded, raw generation classified
rather than post-guard text, failures surfaced as `FAILED`, the classifier's own
reliability reported rather than assumed. Mutation testing confirms each is
load-bearing: removing any one produces a plausible number the harness has not
earned, and the most dangerous of them fabricates a **perfect** result.

The structural finding already stands, independent of any measurement: the
**stored verdict is safe under every condition tested** — both guards off,
prompt injection, conflicting evidence — because it is computed before
generation and never parsed from text. The exposure is the **delivered prose**,
and the contradiction guard covers only explicit assertions.

**The expected result is negative** — H2 predicts a material false-negative rate
for oblique reversals — and the deliverable is designed so that reporting it
honestly is the path of least resistance.

---

*Phase P complete. At the time this report was produced, Phase Q had not started.*
