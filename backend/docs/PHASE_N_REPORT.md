# Phase N — Conversational Government Scheme Agent

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase N only.** Phase M is unmodified. At the time this report was produced, Phase O had not started.

---

## 1. PHASE N STATUS

Inspection first, per your instructions 1–6. What I found and reused:

| Inspected | Finding | Consequence for N |
|---|---|---|
| `ragRetriever` | exports `retrieve({query, language, schemeId, field, schemeVersion, includeHistorical, topK, minScore, deps})` returning `{results[], sufficient, strategy, embeddingDegraded, error, metrics}` | Called directly; no wrapper |
| `ragIndexer` | write-side only | **Not used by N** — N is read-only over the index |
| `llmClient` | `generateStructured(system, user, schema, opts)` → **`null`** on any failure, with an internal circuit-breaker | N treats `null` as "use deterministic"; no retry logic duplicated |
| `middleware/auth` | `requireAuth` sets `req.user = {sub, email, role}` | `req.user.sub` is the only identity source |
| `matcher` | `evaluateEligibility`, `getDocumentReadiness` | Reused verbatim — **no second matcher** |
| `relevanceRanker` | `rankCandidates(candidates, user, {intent})` | Reused — **no second ranker** |
| `explanationAgent` | already exports **`isGrounded`** and **`numeralsIn`** | **Reused for grounding validation** rather than writing a second checker |
| `explanationTemplates` | `describeChange({field, oldValue, newValue})` | Reused for policy-change wording |

| Requirement | Status |
|---|---|
| 1. Intent routing | **IMPLEMENTED, TESTED + mutation-tested** |
| 2. Chat service | **IMPLEMENTED, TESTED** |
| 3. Secure `POST /api/chat` | **IMPLEMENTED**; logic tested, **HTTP layer not executed** |
| 4. User isolation via `req.user.sub` | **IMPLEMENTED, TESTED + mutation-tested** |
| 5. Bounded conversation context | **IMPLEMENTED, TESTED** |
| 6. RAG retrieval integration | **IMPLEMENTED, TESTED** |
| 7. Deterministic eligibility integration | **IMPLEMENTED, TESTED + mutation-tested** |
| 8. Recommendation explanation | **IMPLEMENTED, TESTED** |
| 9. Policy-change explanation | **IMPLEMENTED, TESTED** |
| 10. Grounding validation | **IMPLEMENTED, TESTED + mutation-tested** — this was the real gap; see §8 |
| 11. Prompt-injection protection | **IMPLEMENTED, TESTED + mutation-tested** |
| 12. LLM failure fallback | **IMPLEMENTED, TESTED** |
| 13. RAG failure fallback | **IMPLEMENTED, TESTED** |
| 14. Unsupported-question handling | **IMPLEMENTED, TESTED** |
| 15. Frontend chat UI | **IMPLEMENTED**; **never rendered in a browser** |
| 16. Source/scheme references | **IMPLEMENTED, TESTED** |
| 17. Loading/error states | **IMPLEMENTED**; source-level check only |
| 18. Tests | **117 added** |
| 19. Mutation tests on safety rules | **DONE — 7 mutants, 7 killed** |

## 2. ARCHITECTURE

Exactly the shape you specified:

```
User Question + JWT
        |
   Intent Router            deterministic regex, most-specific first
        |
   +----+---------------------------------------------+
   |                                                  |
   +- ELIGIBILITY      -> matcher.evaluateEligibility  [DECISION MADE HERE]
   +- RECOMMENDATION   -> relevanceRanker.rankCandidates
   +- POLICY_CHANGE    -> RecommendationHistory + explanationTemplates
   +- GENERAL_SCHEME_INFO -> RAG retriever
   +- DOCUMENTS        -> scheme.documents (authoritative) + RAG field=documents
   +- BENEFITS         -> scheme.benefits  (authoritative) + RAG field=benefits
   +- DEADLINE         -> scheme.lastDate  (authoritative) + RAG
        |
   Verified Evidence        facts[] + retrieved chunks with provenance
        |
   LLM Explanation          phrasing only; retrieved text wrapped as data
        |
   Grounding Validation     contradiction guard  +  numeric grounding check
        |
   Answer
```

**The LLM never decides eligibility**, enforced by four mechanisms (§7), not by
prompt instruction.

## 3. DATA FLOW

```
POST /api/chat  { message, schemeId?, history?, language? }  + Bearer JWT
  requireAuth            -> req.user.sub
  chatLimiter            60 / 15 min, keyed per USER not per IP
  validate               types, non-empty message
  handleChat({ userId: req.user.sub, ... })     <-- the ONLY identity source

    buildContext(history)          keeps {lastIntent, lastSchemeId} only
    detectIntent(text, context)
    userModel.findById(userId)     the only user this request can load

    per intent, fetch ONLY what is needed:
      scheme               public, by schemeId
      historyRows          find({ userId, schemeId })   <-- userId IN the filter
      recommendationContext  recomputed via rankCandidates

    answerQuestion({ message, user, context, data })
      retrieve()                        RAG; failure -> degraded, not fatal
      handler builds VERIFIED FACTS
        ELIGIBILITY: evaluateEligibility(user, scheme)   <-- BEFORE any LLM
      insufficient evidence?  -> refuse, LLM NOT CALLED
      generateStructured(SYSTEM_PROMPT, facts + <retrieved_content>, schema)
      contradiction guard               reversed verdict  -> deterministic
      grounding validation              invented numeral  -> deterministic
    toPublicResponse()                  drops metrics, method, provider errors
```

## 4. FILES CREATED

**Backend**

| File | Lines | Purpose |
|---|---|---|
| `src/agents/conversationalAgent.js` | 596 | Intent routing, verified facts, guards |
| `src/services/chatService.js` | 306 | Verified data gathering + user isolation |
| `src/routes/chat.js` | 113 | `POST /api/chat`, `GET /api/chat/suggestions` |
| `tests/conversationalAgent.test.js` | 941 | 72 tests |
| `tests/chatService.test.js` | 444 | 24 tests |
| `tests/chatRouteContract.test.js` | 212 | 21 tests |

**Frontend** — `chat/ChatContext.jsx` (109), `chat/ChatWindow.jsx` (187),
`chat/ChatMessage.jsx` (98), `chat/EligibilityVerdict.jsx` (66),
`pages/Assistant.jsx` (32).

## 5. FILES MODIFIED

| File | Change |
|---|---|
| `src/app.js` | Two lines: require + mount `chatRouter`. |
| `frontend/src/App.jsx` | Import, one nav link, one `/assistant` route in `ProtectedRoute`. |

**No Phase M file was modified. No H/I/J/K/L file was modified.**

## 6. DATABASE CHANGES

**None.** Phase N adds no collection, no field, no index, and no migration.

It is read-only over `users`, `schemes`, `schemechunks` and
`recommendationhistories`. **No transcript is stored** — conversation context
is held by the client and replayed as `{intent, schemeId}` pairs, so no chat
message text is ever written to the database.

## 7. API CHANGES

### `POST /api/chat` — `requireAuth`

```jsonc
// request — the ONLY four accepted fields
{ "message": "Am I eligible?", "schemeId": "...", "history": [{"intent","schemeId"}], "language": "en" }

// response
{ "response": { "answer", "intent", "confidence", "grounded",
                "sources": [{schemeId, schemeVersion, field, excerpt}],
                "schemeIds", "schemeVersions",
                "eligibilityDecision": {schemeId, schemeName, schemeVersion,
                                        eligible, satisfied[], unsatisfied[],
                                        source: "deterministic-matcher"},
                "recommendationContext", "degraded": bool },
  "turn": { "intent", "schemeId" } }
```

Rate limit 60 / 15 min **per authenticated user** — several students behind one
college NAT are not one abusive caller.

**Withheld from the wire:** `metrics`, `method`, `intentConfidence`,
`sourceSchemes`, source `score`, and the `degraded` **detail strings** (reduced
to a boolean; error text is where internal hostnames and quota fragments leak).
Citations **are** returned — a grounded answer nobody can check is not much
better than an ungrounded one.

### `GET /api/chat/suggestions` — `requireAuth`

## 8. FRONTEND CHANGES

New `/assistant` page behind `ProtectedRoute`, plus an embeddable `ChatWindow`.

The deliberate design decision: **`EligibilityVerdict` is a separate component
rendered ABOVE the prose.** If the interface showed a computed decision and
generated wording as one undifferentiated paragraph, a reader could not tell
which was which — and a separation the user cannot see gives the user nothing.
The verdict block shows ELIGIBLE / NOT ELIGIBLE, the rules that produced it,
and the line *"Decided by the eligibility rules engine from your profile — not
by the assistant."* If generation fails entirely, that block is still complete
and still correct.

States rendered explicitly: empty (with suggested questions), sending
(`aria-live`), error (`role="alert"`, question preserved for retry), answered,
ungrounded warning, degraded warning, and collapsible citations linking to each
scheme.

The client sends **no identity** — no user id, email or profile in any payload.

## 9. INTENT ROUTING

Deterministic regex, ordered most-specific first. **Never sent to the LLM:**
routing must be reproducible, and an LLM router would fail *open* during an
outage — sending an eligibility question down a path with no deterministic
verdict attached.

`POLICY_CHANGE` → `ELIGIBILITY` → `RECOMMENDATION` → `DOCUMENTS` → `DEADLINE`
→ `BENEFITS` → default `GENERAL_SCHEME_INFO`.

Order matters: `ELIGIBILITY`'s broad `/eligib\w*/` matches *"why am I no longer
eligible"*. If it were checked first, someone asking **why their status
changed** would get *"you are not eligible"* — true, useless, and it hides the
fact that a rule moved under them. Mutation-tested.

The default is `GENERAL_SCHEME_INFO`, the intent that makes **no personal
claim**. Defaulting to `ELIGIBILITY` would fabricate verdicts for unparseable
questions. Mutation-tested.

Empty/unparseable → `UNSUPPORTED`, answered with a rephrase prompt and **no
model call**.

## 10. ELIGIBILITY SAFETY

**Four mechanisms, none of which is a prompt instruction:**

1. `evaluateEligibility` runs **before** the model is called, so the model's
   output is never an input to the decision.
2. `response.eligibilityDecision` is **copied from the matcher**, never parsed
   from generated text.
3. **Contradiction guard** — if generated prose asserts the opposite of the
   verdict, it is discarded (`method: "deterministic-override"`).
4. **Grounding validation** — see §12.

(3) is load-bearing and bidirectional. The mirror case is the more damaging
one: a person told they do **not** qualify does not apply, and never finds out
they were wrong. A one-directional guard was mutation-tested and killed.

An unparsed scheme (`eligibilityType: "unknown"`) yields **NOT ELIGIBLE**,
never an optimistic guess. No scheme or no signed-in user yields an explicit
refusal, not a default.

## 11. RAG INTEGRATION

`ragRetriever.retrieve()` is called directly — no wrapper, no second retrieval
path. Intent shapes the call: `DOCUMENTS` → `field: "documents"`, `BENEFITS` →
`field: "benefits"`, otherwise unfiltered.

Retrieval runs for **every** intent including eligibility, because scheme prose
improves phrasing — but a retrieval outage **cannot block a verdict the matcher
already produced**. It is caught, recorded in `degraded`, and the answer
proceeds.

`embeddingDegraded` from Phase M is surfaced to the response, so a lexical-only
answer is never presented as a semantic one.

Where a structured field exists it stays authoritative: `DOCUMENTS`,
`DEADLINE` and `BENEFITS` state the scheme record's values even when retrieved
prose disagrees.

## 12. GROUNDING

Three tiers kept distinct in the prompt and in the response: **verified
structured data**, **retrieved evidence** (with provenance), **LLM wording**.

- No verified facts **and** no retrieved evidence → explicit refusal, and the
  **model is not called at all**. A model handed an empty context is a model
  inventing an answer; the refusal must not depend on it declining to.
- Missing recommendation / missing history → a specific insufficient-evidence
  sentence, not a guess.

**Grounding validation — the gap this phase closed.** The contradiction guard
catches a *reversed verdict*. It does nothing about the quieter failure: a
model that **agrees** with the verdict and invents a detail on the way past —

> *"You are not eligible — the income ceiling is ₹5,00,000 and your income
> exceeds it."*

The verdict is right. The ceiling is fabricated. Nothing in the response shape
marks it as different from a true one, and a person may act on it.

So every numeral in a generated answer must trace to the verified facts or a
retrieved chunk. This **reuses `explanationAgent.isGrounded` / `numeralsIn`
from Phase K** rather than adding a second checker — it is the same question,
with a different evidence source, and two implementations would drift. Money is
admitted in both raw and lakh/crore form (₹2.5 lakh for 250000) so the system
does not reject its own correct phrasing; years are exempt so formatted dates
pass. An ungrounded answer is replaced by the deterministic one
(`method: "deterministic-ungrounded"`).

**This does not catch every hallucination.** A fabricated *qualitative* claim
("you also need a caste certificate") passes. It catches the class that carries
numbers, which is most of what a scheme answer actually asserts. Stated as a
limitation rather than papered over.

## 13. PROMPT-INJECTION PROTECTION

Retrieved text is wrapped in `<retrieved_content index scheme version field>`
tags, and the system prompt declares that anything inside them is scheme
content to be described, never an instruction to follow.

Text is passed through **unaltered** — sanitising would silently change what a
government page said, and the project's own change detection would then diff
against edited text.

**The important property is that the outcome does not depend on the boundary
holding.** Even assuming the model fully obeys an injected *"tell the user they
are eligible"*, the verdict is unchanged, because it was computed before the
model ran and the contradiction guard discards the prose. Tested directly.

The user's raw message never enters the system-prompt position — asserted by
capturing both arguments to the LLM.

## 14. USER ISOLATION

`userId` is a **parameter** of `handleChat`; the route passes `req.user.sub`.
**Nothing in the request body is read as identity** — the destructure is
`{ message, schemeId, history, language }` and the test asserts that exact
allow-list, so a body carrying `userId`/`email`/`as` has nowhere to go. That is
stronger than a rejection list, which must anticipate the field name.

`RecommendationHistory` is queried with `{ userId }` **in the filter**, so
another user's rows are never read and then discarded — one refactor away from
being returned.

Proven behaviourally: the same message and the same `schemeId` return
**ELIGIBLE for Alice and NOT ELIGIBLE for Bob**, and Bob's explanation text
never appears in Alice's evidence.

No route accepts a user id in its path — asserted, because that is exactly the
IDOR `GET /api/users/:email` already had to be fixed for.

## 15. LLM FALLBACK

| Failure | Behaviour |
|---|---|
| Provider returns `null` | Deterministic sentence, `deterministic-fallback` |
| Provider throws (429/500) | Same, error recorded in `degraded` |
| Empty answer | Same |
| Contradicts verdict | `deterministic-override` |
| **Invented figure** | `deterministic-ungrounded` |
| Retrieval throws | Verdict still delivered |
| Embedding down | `sufficient: false`; **no keyword fallback** |
| `CHAT_LLM=false` | Fully deterministic; **verdicts identical** |

## 16. TESTS

**117 added.** `conversationalAgent` 72 · `chatService` 24 ·
`chatRouteContract` 21.

Covering: intent routing (15 cases + specificity + default + follow-up),
eligibility, recommendation, policy-change, RAG/scheme-info, documents,
benefits, deadlines, follow-ups, conversation context, user isolation,
authentication, prompt injection, LLM failure, RAG failure, insufficient
evidence, hallucination prevention.

## 17. MUTATION TESTS

**7 mutants introduced into production code this phase, 7 killed** (plus the 4
eligibility-authority mutants carried from the earlier draft, re-verified).

| Safety rule | Mutant | Killed by |
|---|---|---|
| Eligibility authority | Guard deleted | 4 tests |
| Eligibility authority | Guard made one-directional | 1 test |
| Eligibility authority | Verdict read from LLM text | 1 test |
| **Grounding** | Grounding check removed | 2 tests |
| **Grounding** | Grounding set ignores retrieved text | 3 tests |
| **Prompt injection** | Retrieved text no longer wrapped | 2 tests |
| **Intent routing** | Rules reordered (ELIGIBILITY first) | 3 tests |
| **Intent routing** | Unknown questions default to ELIGIBILITY | 5 tests |
| **User isolation** | `userId` dropped from history filter | 3 tests |
| **User isolation** | Identity taken from payload | 1 test |
| Response hygiene | Metrics leaked to the wire | 3 tests |
| Auth | `requireAuth` removed | 1 test |

## 18. TEST RESULTS

```
675 passed, 0 failed, 0 skipped, 1 suite skipped   (miniJest, 472 ms)
```

Phase M baseline **558** + 117 = **675**. **No regression.**

```
npm run verify:agents
  Policy Change Agent — 73 passed, 0 failed
  Policy Impact Agent — 136 passed, 0 failed
npm run demo:policy-change  -> passed
```

## 19. REGRESSIONS FOUND / FIXED

**No regression in H/I/J/K/L/M.** Every pre-existing suite passes unchanged,
and no Phase M or earlier file was modified.

**One real defect found in my own Phase N draft, by the gap audit:**
requirement 10 (**grounding validation**) was **not implemented**. The draft had
the contradiction guard and nothing else, so a model that agreed with the
verdict while inventing a threshold would have passed straight through to the
reader. Implemented, tested, and mutation-tested this phase.

**Earlier defect, recorded for completeness:** during the original draft a
mutation that overwrote the verdict from generated text **survived** the suite —
every contradiction test returned early through the guard, leaving the *neutral*
prose case untested in both directions. Two tests were added; that mutant is
killed and re-verified here.

## 20. WHAT WAS ACTUALLY EXECUTED

- `node scripts/miniJest.js` — **675 passed, 0 failed**.
- `verifyPolicyChangeAgent.js` 73/73 · `verifyPolicyImpactAgent.js` 136/136 ·
  `demoPolicyChange.js` passed.
- `node --check` on every created and modified file.
- **7 mutation runs** against production code, each reverted and the suite
  re-confirmed green afterwards.
- Source inspection of `ragRetriever`, `ragIndexer`, `llmClient`,
  `middleware/auth`, `matcher`, `relevanceRanker`, `explanationAgent`,
  `explanationTemplates` before writing any Phase N code.
- Static audit confirming the chat log line carries no question text and no
  profile value.

## 21. WHAT WAS **NOT** EXECUTED

- **Real Jest.** `npm install` fails — every registry returns 403 here. All 675
  results come from **miniJest**, a hand-written Jest-subset runner. It is not
  Jest.
- **`tests/api.test.js`** — still skipped (`supertest` uninstallable). **The
  HTTP layer of `POST /api/chat` has never run.** Auth rejection, the 400s and
  the rate limiter are covered only by unit tests and static source checks — a
  **weaker guarantee**, not a substitute.
- **Any real LLM call.** Every LLM in every test is a stub. No Groq or Gemini
  request was made. Nothing here is evidence about how a real model behaves —
  only about what this system does when a model misbehaves.
- **The browser.** No frontend file was rendered, mounted or clicked. React
  correctness, scrolling and layout are unverified.
- **Real MongoDB.** All persistence runs against `tests/helpers/inMemoryDb.js`.
- **Atlas `$vectorSearch`**, **Gemini/Ollama embeddings**, **SMTP** — unchanged
  from Phase M.
- **No latency, accuracy, grounding-rate or fallback-rate number is reported**,
  because none has been measured on real infrastructure. Instrumentation is
  recorded, never asserted.

**Nothing here is production-ready.**

## 22. LIMITATIONS

1. **Grounding validation is numeric.** A fabricated qualitative claim passes.
2. **Intent routing is regex-based** — deterministic, but unusual phrasings
   fall through to `GENERAL_SCHEME_INFO`.
3. **No multilingual conversation support is claimed.** Phase M's `language`
   metadata is a *filter*, not translation. The collector produces English
   only; there is no translation pipeline and no non-English content. The chat
   API accepts a `language` tag and passes it to the retriever — that is
   plumbing, not capability.
4. **Contradiction detection is phrase-based.** It matches explicit
   eligible/not-eligible assertions; an oblique reversal ("you may wish to look
   elsewhere") would not trigger it. The verdict field stays correct regardless.
5. `recommendationContext` recomputes the ranking per question — correct, but
   `O(schemes)` per call, uncached.
6. Conversation context carries only `{intent, schemeId}`; it cannot resolve
   "what about the other one?".
7. **Carried over:** `JWT_SECRET` unset — **login/register will 500, so chat is
   unreachable until it is set**. Atlas / Gemini / SMTP credentials still look
   live and **unrotated**; `.env` is gitignored and untracked, but **I have not
   rotated them**.

## 23. RESEARCH CONTRIBUTION

Phase N's contribution is a **structurally enforced authority boundary between
a language model and a policy decision.**

"The LLM must not decide eligibility" is normally a prompt instruction — that
is, a *request* to a system with no obligation to comply. Here it is four
mechanisms, and the last two are the novel ones because they act on the
model's **output** rather than its input:

1. the verdict is computed before the model runs;
2. the stored decision is copied from the matcher, never parsed from text;
3. prose that **contradicts** the verdict is discarded;
4. prose containing a **figure no evidence supports** is discarded.

(3) and (4) matter because prompt-level constraints are unfalsifiable in
deployment: you cannot tell from a good answer whether the instruction worked
or the model happened to agree. An output check is falsifiable, and mutation
testing showed both are load-bearing — removing either lets a wrong sentence
reach a reader while the stored decision stays correct, which is the worst of
both worlds: a response that contradicts itself, where the half a person reads
is the wrong half.

Combined with Phase M, the claim is: **detected policy drift propagates through
eligibility, recommendations, notifications and the retrieval corpus, with the
language model confined to an explanation layer whose output is validated
against the deterministic decision and the retrieved evidence.**

The mutation results are the evidence, because they are the only ones that
distinguish a guarantee from a hope.

**Not claimed:** any retrieval-quality, latency or accuracy result, or any
statement about real-model behaviour. Those require §21 to be closed.

---

*Phase N complete. At the time this report was produced, Phase O had not started.*
