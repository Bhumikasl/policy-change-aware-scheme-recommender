# Phase P — Proposal

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**No repository changes made.** This is a proposal for your approval.

---

## PART 1 — AUDIT: WHAT IS CLAIMED vs WHAT IS EVIDENCED

The stated research contribution has two halves. Here is the evidence behind
each, honestly graded.

### Claim (a) — version-aware RAG driven by change detection

| Evidence | Strength |
|---|---|
| 65 Phase M tests, 6 mutants killed | Strong for **structure** |
| Stale-answer experiment: 0/5 vs 5/5 at equal coverage | Real, but **n=5, synthetic, structural** |
| Real corpus, real embeddings | **None** |

Grade: **the mechanism is well-evidenced; its behaviour on real data is not.**

### Claim (b) — the LLM cannot alter a policy decision

| Evidence | Strength |
|---|---|
| 4 guard mutants killed | Strong for **"the guard fires when triggered"** |
| Contradiction guard, grounding validation | Implemented, unit-tested |
| **Behaviour against a real language model** | **NONE** |

Grade: **materially weaker than it currently reads.**

### The finding that matters

```
722 tests.  0 real LLM calls.
```

Every guard test in this project uses `llmSaying("...")` — a stub returning
text **I wrote specifically to trigger the guard**. That proves the guard fires
on inputs shaped like its own specification. It is not evidence about how a
real model behaves, and the distinction is not academic:

**The contradiction detector is two regular expressions.**

```js
claimsEligible   = /\byou\s+(are|now)\s+(now\s+)?eligible\b|\byou\s+qualify\b/
claimsIneligible = /\bnot\s+eligible\b|\bdo\s+not\s+qualify\b|\bdon't\s+qualify\b|\bno\s+longer\s+eligible\b/
```

Consider a model handed an **ELIGIBLE** verdict that replies:

> *"Unfortunately, this scheme isn't a match for your circumstances."*
> *"You may want to look at other schemes instead."*
> *"While you meet most criteria, the income requirement could be a problem."*

None of those match either pattern. Every one of them reverses the verdict in
the reader's mind. The guard does not fire, `method` reads `"llm"`, and the
person is told — in effect — that they do not qualify for something they do.

**That is the exact harm the architecture exists to prevent, and the system's
false-negative rate against it has never been measured.** My own Phase N report
flags this as limitation #4; nothing has since measured it.

### Everything else that remains unvalidated

| Gap | Status |
|---|---|
| Real Jest | never run (npm 403 in sandbox) |
| Real MongoDB / index creation | never run |
| Atlas `$vectorSearch` | never executed |
| Gemini / Ollama embeddings | never called |
| Browser rendering | never rendered |
| `tests/api.test.js` / HTTP layer | skipped since Phase H |
| Retrieval precision@k | `n=0` — no relevance labels |
| 79.3% impact-narrowing figure | synthetic, structured-only |
| `JWT_SECRET` | unset — **auth is currently broken** |
| Atlas / Gemini / SMTP credentials | live and **unrotated** |

---

## PART 2 — IS A PHASE P ACTUALLY NECESSARY?

You asked me not to invent phases to extend the project. Taking that seriously:

### The case for stopping at O

The system is **architecturally complete** for its stated contribution. Every
component the original architecture named exists, is wired, and is tested.
Nothing in H–O is a stub. If the goal is a working capstone application plus a
defensible design narrative, **you could stop now**, do the real-environment
validation you have planned, and write up.

**Under that goal, Phase P is optional and I would not push it.**

### The case for one more phase

Claim (b) — the one you called non-negotiable, the one that distinguishes this
project from "we used RAG and agents" — currently rests entirely on stubs I
wrote. A reviewer's first question will be:

> *"You claim the LLM cannot override eligibility. How often did a real model
> try, and how often did you catch it?"*

There is no answer today. And the honest answer may not be flattering: a
phrase-based detector will have a real false-negative rate. **Measuring it —
and reporting it even if it is bad — is worth more than another feature.**

That work is not "running the tests." It needs designed experiments, a
generation harness, and a labelling protocol. That is a phase.

### My recommendation

**Yes, one more phase — but a narrow one, and not a feature phase.** It adds no
product functionality. It converts *"we built guards"* into *"here is the
measured residual risk."*

**And it must come after your real-environment validation, not before.** An
ablation result computed on a system that has never run against real MongoDB or
a real provider would measure the harness, not the system.

---

## PART 3 — PROPOSED PHASE P

### Title
**Adversarial Guard Evaluation — measuring what the safety layer actually
catches, and what it misses**

### Objectives

| # | Objective |
|---|---|
| P.1 | Measure the **natural activation rate** of each guard against a real LLM over the question set |
| P.2 | Measure the **catch rate** under adversarial conditions (injected scheme text, edge-case profiles, prompts designed to induce reversal) |
| P.3 | Measure the **false-negative rate** — wrong eligibility statements the guards do *not* catch. **The critical objective.** |
| P.4 | **Ablation**: disable each guard independently, measure what reaches the user |
| P.5 | Extend the contradiction detector *only if* P.3 shows a material gap, then re-measure |

P.3 is the one that matters. P.1, P.2 and P.4 are comparatively easy and will
probably look good; P.3 is the one that can embarrass the project, which is
precisely why it is worth running.

### Research contribution

> **A measured residual-risk figure for an LLM-as-explanation-layer
> architecture: given a deterministic decision and a model instructed to state
> it, how often does the model's prose still mislead, and what fraction does a
> structural output check catch?**

This is falsifiable, it is not a number this project can currently produce, and
it is the difference between an architecture claim and an architecture
*result*. It also generalises beyond government schemes: any system putting an
LLM in front of a deterministic decision engine faces the same question.

A negative result is still a contribution. *"A phrase-based contradiction check
catches X% of real reversals; the remainder are oblique and require Y"* is a
publishable finding and an honest one.

### Components affected

**New (evaluation only — no product code):**

| File | Purpose |
|---|---|
| `src/evaluation/guardAblation.js` | Runs the set with each guard disabled via injected config |
| `src/evaluation/adversarialSet.js` | Prompts/fixtures designed to induce reversal and hallucination |
| `src/evaluation/verdictAgreement.js` | Classifies whether generated prose agrees with the verdict — the P.3 instrument |
| `scripts/runGuardEvaluation.js` | CLI, real provider required |
| `tests/guardAblation.test.js` | Tests for the above |

**Modified (minimally):**

| File | Change |
|---|---|
| `src/agents/conversationalAgent.js` | Add `deps.guards = {contradiction, grounding}` toggles — **default ON**, ablation-only. Possibly widen the detector, *after* P.3 measures the gap. |
| `src/evaluation/metrics.js` | Guard-activation and false-negative aggregates |

**Untouched:** H, I, J, K, L, M. No database change. No API change. No frontend
change.

### Tests

- Ablation toggles default ON and cannot be enabled in production config
- Each toggle actually disables only its own guard
- `verdictAgreement` classifier: agreement, reversal, hedge, and the oblique
  cases the regex misses
- Mutation tests on the ablation harness (a toggle that silently does nothing
  would report every guard as unnecessary)
- The false-negative counter cannot be gamed by an unlabelled sample

### Dependencies on H–O

| Depends on | For |
|---|---|
| **N** — conversational agent, both guards | The subject under test |
| **O** — harness, metrics, honesty rules | Aggregation and the null/gating discipline |
| **M** — retriever | Adversarial injected-content cases |
| **K** — `isGrounded` | Reused, not rebuilt |
| **J/I/H** | Only as fixture sources |

**Hard external dependencies — Phase P cannot produce results without these:**

1. A real LLM provider (Groq or Gemini) with quota
2. `JWT_SECRET` set, if driving through HTTP rather than the agent directly
3. Ideally a real MongoDB + semantic embeddings, so adversarial retrieval cases
   are realistic

**I can build the harness in this sandbox. I cannot run it.** The results are
yours to generate. I will not report a single guard-activation number I have
not measured — the Phase O honesty rules (null-never-zero, gate-on-provider)
carry into P and will withhold anything unmeasured.

### Expected outcome

A report containing, for each guard:

- activation rate, natural and adversarial, with `n`
- **false-negative rate with worked examples** — the wrong answers that got
  through
- ablation delta: what reaches the user with the guard off
- an explicit statement of residual risk

**Plausible finding I should flag now:** the grounding check will likely catch
most *numeric* fabrication, and the contradiction check will likely miss a
meaningful fraction of *oblique* reversals. If so, the honest write-up is
*"structural output checking catches the checkable class; the residual is
qualitative and remains an open problem"* — which is a better contribution than
a claim of completeness nobody can verify.

### What Phase P is NOT

- Not a feature phase — no user-visible functionality
- Not a rewrite of the guards; P.5 is contingent on P.3 finding a gap
- Not a substitute for your real-environment validation — it *depends* on it

---

## PART 4 — PHASES I RECOMMEND **AGAINST**

Named explicitly so the proposal above can be judged against the alternatives I
rejected:

| Candidate | Why not |
|---|---|
| **Multilingual support** | Would require a translation pipeline and non-English corpus. Real work, no research novelty, and it would invite exactly the overclaim we have been careful to avoid. |
| **Kafka / microservices / k8s** | Explicitly ruled out early and still correct. Nothing in the workload justifies it; it would look commercial and prove nothing. |
| **Admin dashboard** | Useful product work, zero research contribution. |
| **More agents** | The architecture has five. A sixth would be padding. |
| **Fine-tuning a model** | Directly contradicts the thesis, which is that the LLM should *not* be the policy authority. |
| **Scale/load testing** | Premature — no real deployment, no real traffic. The 79.3% figure is the honest scale story and it is already bounded. |
| **A second vector store** | Explicitly ruled out; still no reason. |

---

## PART 5 — RECOMMENDED ORDER

```
1. YOU: real-environment validation of H–O          ← blocking
      npm install && npm test        (real Jest baseline vs 722)
      JWT_SECRET set; auth works
      real MongoDB; indexes created
      EMBEDDING_PROVIDER=gemini; full re-index
      Atlas $vectorSearch verified or scan confirmed
      browser: chat UI renders
      credentials rotated

2. YOU: label the question set (expectedSchemeIds)
      unlocks retrieval precision@k, currently n=0

3. ME:  build the Phase P harness (no results)

4. YOU: run Phase P against a real provider

5. BOTH: write up, including the negative results
```

Steps 1 and 2 are yours and are genuinely blocking. If Phase P runs before them
it measures the sandbox, not the system.

---

## DECISION

**Approve Phase P** if you want the LLM-authority claim to rest on measurement
rather than on stubs.

**Skip it** if the capstone goal is a working system plus a design narrative —
in which case go straight to validation and write-up, and I would not argue.

Either way I would not propose a Phase Q. After P the project has an
architecture, an implementation, an evaluation instrument, and a measured
result. That is a complete piece of work, and further phases would be padding.

**No repository changes have been made. Awaiting your decision.**
