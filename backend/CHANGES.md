# Eligibility engine — end-to-end rework

This document explains the four fixes made to address the review comments.
Every change is backwards-compatible with the existing MongoDB documents.

## 1. `eligibilityType`: universal / constrained / unknown

`models/Scheme.js` now carries an `eligibilityType` inside
`eligibilityRules`, plus a `needsReview` boolean.

- **universal**   — open to everyone in a jurisdiction. Matches every user
  unless a specific rule (e.g. state) actively excludes them.
- **constrained** — has at least one restrictive rule. Matches a user only
  when there is a positive signal AND no failed rules (the fix for the
  "650-matches" bug is preserved).
- **unknown**     — eligibility text was missing or a placeholder AND
  nothing was parsed. Excluded from `/matches` by default. Callers can
  pass `?includeUnknown=true` for an admin review view.

The database default for legacy rows is `unknown`, so they will not
match anyone until the backfill runs.

## 2. Deterministic rule pre-parser

New file: `src/services/deterministicExtractor.js`.

A regex + keyword parser that runs BEFORE any LLM call and extracts age,
income (understanding "3 lakh" / "2,50,000"), gender, categories
(SC/ST/OBC/BPL/EWS/PwD/Widow/…), occupations, states, education (with
synonym support — "matriculate" → 10th, "PG" → Post Graduate) and marks.

Also classifies the eligibility text as universal / unknown from
language patterns ("open to all Indian citizens", "N/A", …).

It's fully deterministic — same text always gives the same rules — and
has zero external dependencies.

## 3. Hybrid extractor — LLM assists, does not decide

New file: `src/services/hybridExtractor.js`.

The pipeline now:

1. Runs the deterministic pass.
2. Runs the LLM pass (if enabled and the key is available).
3. Merges: deterministic values ALWAYS win on numeric conflicts. LLM only
   fills gaps deterministic left null. Array fields prefer the
   intersection when both sides agree, else union.
4. Records per-field `provenance` (deterministic / llm / both /
   deterministic+llm-conflict / none) and a `conflicts` list.
5. Blends confidence and sets `needsReview` when confidence < 0.5,
   any numeric conflict was detected, or the type is `unknown`.

`services/pipeline.js` and `scripts/backfillEligibility.js` call the
hybrid extractor. `services/eligibilityExtractor.js` (the LLM wrapper)
stays as-is and is used ONLY by the hybrid extractor.

## 4. Test suite — Jest

`package.json` adds jest + supertest as devDependencies and:

- `npm test` runs all suites
- `npm run test:coverage` produces a coverage report

Suites under `tests/`:

- `deterministicExtractor.test.js` — every parser (age / income / gender /
  categories / occupations / states / education / marks / universal /
  unknown), Indian number formats (lakh / crore / 2,50,000), end-to-end
  classification.
- `hybridExtractor.test.js` — deterministic-vs-LLM merge (LLM mocked),
  numeric conflict handling, gap-fill by LLM, universal fallback when
  neither side finds a signal, LLM throw path.
- `matcher.test.js` — age / income / gender / state / education /
  categories / occupations, missing-field strictness, one-failure-kills-
  eligibility, universal vs constrained vs unknown branches, score
  ordering, the "650-matches" regression.
- `comparator.test.js` — normalized-hash stability, per-field diffs on
  description / eligibility / benefits / lastDate / eligibilityRules.*,
  metadata-only edits not counted as changes, multi-field diffs.
- `notifier.test.js` — mocked User/NotificationLog/mailer. Verifies dedup
  via 11000 duplicate-key, that unknown schemes send no emails, universal
  schemes reach every user, and that a mail failure does not stop the
  pipeline.
- `api.test.js` — supertest against the Express app with mocked models.
  Verifies /health, POST /api/users, /matches (constrained + universal +
  exclusion of unknown), /matches/stats, /why, /schemes.

## Data migration

Existing schemes need one backfill run:

    npm run backfill:eligibility           # deterministic only
    npm run backfill:eligibility:llm       # deterministic + LLM assist

The script is resumable via `.backfill-checkpoint.json`.

## Frontend

Nothing broke — the existing `matchExplanation` shape is preserved and
now includes `eligibilityType`, `needsReview`, and `ruleConfidence` so
the UI can show a badge for universal vs constrained matches and mark
low-confidence rules for review.

## 5. Strict compound matching (v2)

The reviewer's example: a scheme for "physically disabled students" should
NOT recommend to a plain student without the PwD category. Fixed:

- Deterministic extractor now returns `categoryGroups: string[][]` — an
  AND-of-OR representation. `"SC/ST/OBC candidates"` → `[["SC","ST","OBC"]]`
  (one OR-group). `"physically disabled students from OBC families"` →
  `[["Person with Disability"], ["OBC"]]` (two AND-required groups) plus
  `occupations: ["Student"]`.
- Matcher enforces: user must satisfy EVERY group (at least one keyword
  from each). A student without PwD now fails the PwD group and is
  correctly rejected. An SC user still matches an "SC/ST/OBC" scheme.
- Legacy rows with flat `categories` and no groups are treated as strict
  AND (each category becomes its own singleton group), so an "SC + Widow"
  scheme requires both — no more accidental matches on partial overlap.
- Model, normalizer, comparator, pipeline, and backfill all pass
  `categoryGroups` through end-to-end. The comparator hash is stable
  because normalizeEligibilityRules sorts inner and outer arrays.
- New tests in `matcher.test.js` cover the PwD-student rejection, the
  SC/ST/OBC OR case, the `(SC OR ST) AND BPL` compound case, and the
  legacy flat-categories AND fallback.

## 6. Two-stage recommendation with LLM verifier (v3)

The recommendation engine is now:

1. **Deterministic rules** (`services/matcher.js`) — fast, cheap, auditable.
   Reads structured eligibilityRules + categoryGroups, applies strict
   AND-of-OR semantics. Every recommendation MUST pass this gate.
2. **LLM verifier** (`services/schemeVerifier.js`) — for each candidate
   that passed stage 1, chunks the full scheme document (name +
   description + eligibility + benefits + documents + ministry + state)
   via `services/schemeChunker.js`, ranks chunks by profile-keyword
   overlap (eligibility chunks always included), and asks Gemini to
   confirm eligibility criterion-by-criterion against the full user
   profile (state, gender, age, occupation, income, categories,
   education, marks, documentsAvailable) through a strict JSON response
   schema.

**Combining verdicts** (`decideRecommendation`):

| rules  | verifier                         | recommendation           |
|--------|----------------------------------|--------------------------|
| reject | anything                         | REJECT (rules are gate)  |
| pass   | unavailable                      | recommend (`rules-only`) |
| pass   | verified=true                    | recommend (`rules+llm`)  |
| pass   | verified=false, only missingInfo | recommend + needsMoreInfo|
| pass   | verified=false, failedCriteria   | REJECT (`verifier-veto`) |

The verifier can only downgrade or flag — it **cannot** promote a
rules-rejected scheme, so a hallucinating model can never sneak an
ineligible user in.

**Chunking** (`services/schemeChunker.js`):
- Sentence-boundary split with 80-char overlap, 600-char target size
- Tagged by section (eligibility / description / benefits / documents / …)
- `rankChunksForUser` scores by keyword overlap with the profile and
  always includes at least one eligibility chunk

**Cost control**:
- In-process LRU cache keyed by hash(userProfileHash + scheme.contentHash) —
  the same (user, scheme) pair only costs tokens once until either changes
- `?verify=false` disables the LLM stage per-request
- `?maxVerify=N` caps LLM calls per request (default 20, top-scored first)
- `SCHEME_VERIFIER_ENABLED=false` env var disables verifier globally
- `GEMINI_VERIFIER_MODEL` env var lets you point the verifier at a
  different model than the extractor (e.g. cheaper flash for extract,
  stronger pro for verify)

**API changes**:
- `GET /api/users/:email/matches?verify=true|false&maxVerify=N&showVetoed=true`
  now returns `matchExplanation.stage` (rules-only / rules+llm / rules+llm-partial),
  `matchExplanation.recommend`, `matchExplanation.needsMoreInfo`,
  and `matchExplanation.verifier` (full verifier output when available).
- `GET /api/users/:email/why/:schemeId` includes a `verifier` field with
  the full second-opinion output for that one scheme.

**New tests**:
- `tests/schemeChunker.test.js` — sentence splitter, section chunking,
  long-text splitting, profile-keyword ranking, always-include-eligibility.
- `tests/schemeVerifier.test.js` — cache key stability (order-independent),
  LLM-mocked verified path, cache-hit second call, LLM-throw fallback,
  all five branches of `decideRecommendation`.

## 7. Relevance ranking — eligibility ≠ recommendation (v4)

**The bug the reviewer found.** `maxVerify=20` capped how many candidates
were sent to the LLM, NOT how many were returned. Everything past the cap
kept its rules verdict and was still recommended, so a broad profile got
157-650 results. Verification was throttled; output was not.

**The deeper issue.** The old `score` (count of matched rules) measured
"how many of this scheme's constraints did we verify" — which rewards
schemes that happen to declare many fields, not schemes that fit this user.
Eligibility is a FILTER; relevance is a RANKING. They are different
questions and were conflated.

**New four-stage pipeline** (`routes/users.js`):

    ~4,700 Active schemes
          ↓  [1] ELIGIBILITY GATE   services/matcher.js
             "CAN they apply?" strict AND-of-OR rules. Authoritative.
          ↓  ~100-600 eligible
          ↓  [2] RELEVANCE RANKING  services/relevanceRanker.js  ← NEW
             "Which are most USEFUL?" No LLM.
          ↓  [3] TRUNCATE to ?limit (default 20)   ← fixes the 157 bug
          ↓  [4] LLM VERIFICATION of the shortlist
             confirm / veto / flag missing info
          ↓  Top 5-20 recommendations

**The ranker** (`services/relevanceRanker.js`, no external deps):

- **BM25-lite lexical overlap** with IDF computed over the candidate set,
  k1 saturation and length normalisation, cached per corpus.
- **Profile → intent expansion**: "Student" also queries scholarship /
  fellowship / tuition / stipend; "SC" → scheduled caste / welfare;
  "Female" → mahila / women / maternity. Direct facts weight 1.0,
  inferred expansions 0.6.
- **Stated intent suppresses inferred intent**: `?intent=business loan`
  weights those terms 2.5 AND damps expansions to 0.15, so a Student
  asking for a loan stops getting scholarships ranked first. Verified:
  loan 2.20 → 9.41 while scholarship 8.03 → 6.76.
- **Specificity**: a narrowly-targeted scheme the user satisfies beats a
  broad one (capped at positives actually matched, so declaring
  constraints the user didn't satisfy earns nothing).
- **Universal penalty** (-2.0): open-to-all schemes carry the least
  personalisation signal, so they rank below targeted matches.
- **Benefit concreteness**: cash/loan/scholarship > medal-only awards
  (-1.5 for an award with no monetary benefit).
- **Document readiness**, **deadline urgency**, **rule confidence**.

**New query flags on `/matches`:**

    ?limit=N          how many to RETURN (default 20, 0 = everything)
    ?intent=text      free-text ask, reranks and damps inferred terms
    ?explain=true     include the per-signal relevance breakdown
    ?meta=true        envelope with the funnel counts at every stage
    ?maxVerify=N      LLM call cap (now defaults to min(limit, 20))

`?meta=true` returns `{ funnel: { totalActive, eligible, shortlisted,
llmVerified, vetoed, returned }, intent, results }` so "why 20 and not 181"
is answerable from the response. Also exposed as X-Eligible-Count /
X-Returned-Count / X-Verified-Count headers.

## 8. LLM as exception handler, not primary extractor (v4)

`scripts/backfillEligibility.js` used to call the LLM for every scheme with
non-trivial eligibility text — 4,786 requests, which exhausts any free tier
long before reaching the schemes that actually need help.

Now the deterministic pass runs first and the LLM is only escalated when
the deterministic result is weak:

    confidence >= LLM_ESCALATE_BELOW (default 0.7)  → DONE, no LLM call
    confidence <  threshold                          → escalate
    eligibilityType === "unknown"                    → escalate
    zero signals from non-trivial text               → escalate

Progress lines now report `confidentNoLlm=N` so you can see how many calls
were avoided. Set `LLM_ESCALATE_BELOW=1.1` to force the old behaviour.

Default provider also flipped from `gemini` to `groq` in `llmClient.js`,
`eligibilityExtractor.js` and `schemeVerifier.js` — Gemini's free tier
(~50/day) is not viable for a 4,786-scheme corpus; Groq's is 14,400/day.

## 9. Frontend (v4)

- **Intent search bar** on My Matches — "What are you looking for?" is sent
  as `?intent=` and reranks server-side.
- **Funnel line** — "181 schemes you're eligible for · ranked by relevance ·
  showing the top 20 · 12 AI-verified · 3 filtered out by the verifier".
- **Relevance pill** on each card next to "Why matched".
- Trust badges (AI-verified / Needs more info / Rules match), trust-filter
  chips with counts, state/category/ministry filters, Load-more pagination.

**New tests**: `tests/relevanceRanker.test.js` (17 cases — tokenizer,
query building, intent suppression, specificity, benefit scoring, and the
core "topical beats generic" / "targeted beats universal" / "intent
reorders" / "doc-readiness breaks ties" / stability claims) plus 5 new
API cases covering limit, limit=0, the meta envelope, relevance presence
and the explain breakdown.
