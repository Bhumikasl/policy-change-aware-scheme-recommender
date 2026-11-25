/**
 * Jest environment setup — runs before every test file.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The first real Jest run took 157 seconds and timed out across
 * `pipelineIntegration`, `endToEndK0` and `chatService`.
 *
 * The cause was not slow code. Those suites mock the models and the collector
 * but NOT `services/llmClient`, and the real pipeline reaches it through
 * `eligibilityExtractor` and `schemeVerifier`. With a real `GROQ_API_KEY` or
 * `GEMINI_API_KEY` in the developer's environment, the suite was making **live
 * API calls** — dozens of them, several seconds each.
 *
 * That is a test-isolation defect, and the damage is worse than slowness:
 *
 *   - results depend on whose machine runs them, and on network weather;
 *   - the suite spends real API quota every run;
 *   - a passing run proves nothing repeatable.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES — AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * It clears the provider credentials for the test process only. That is
 * ENVIRONMENT ISOLATION, not mocking: no application module is replaced, no
 * function is stubbed, and no assertion changes.
 *
 * With no key, `llmClient` throws "…_API_KEY not set" before any socket is
 * opened, `generateStructured` catches it and returns `null`, and every caller
 * takes its documented rules-only path. That path is real production
 * behaviour, and it is the behaviour the offline design has always been built
 * around — the LLM is an enhancement, never a dependency.
 *
 * Tests that genuinely need to exercise LLM behaviour do NOT rely on the
 * ambient client: they inject their own `llm` stub through `deps`, which is
 * unaffected by anything here. Grep for `llm:` in tests/ to see them.
 *
 * ---------------------------------------------------------------------------
 * RUNNING A TEST AGAINST A REAL PROVIDER
 * ---------------------------------------------------------------------------
 * Deliberately awkward, because it should be. Set ALLOW_REAL_LLM_IN_TESTS=1:
 *
 *     $env:ALLOW_REAL_LLM_IN_TESTS=1; npx jest tests/conversationalAgent.test.js
 *
 * Expect it to be slow and to cost quota. Never do it in CI.
 */

if (process.env.ALLOW_REAL_LLM_IN_TESTS !== "1") {
  // Providers: cleared so no socket is ever opened from a test.
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // Ollama has no key to clear, so point it at a port nothing listens on and
  // bound the wait — otherwise a developer running Ollama locally would get
  // live calls from the suite on their machine and nowhere else.
  process.env.OLLAMA_HOST = "http://127.0.0.1:1";
  process.env.LLM_TIMEOUT_MS = process.env.LLM_TIMEOUT_MS || "2000";
}

// Throttling exists to protect a real provider's rate limit. With no provider
// reachable it is pure dead time, multiplied by every call in the suite.
process.env.LLM_CALL_DELAY_MS = "0";

// Never let a test read a developer's real database, and never let a missing
// value fall back to one.
delete process.env.MONGODB_URI;

// Deterministic, obviously-fake signing key. Tests that exercise auth need
// *some* key ≥32 chars; using the developer's real one would make results
// depend on their .env and risks it reaching a snapshot or a log.
process.env.JWT_SECRET =
  process.env.JWT_SECRET_TEST_OVERRIDE ||
  "test-only-jwt-secret-not-a-real-credential-0000000000";

// SMTP: no host, so nodemailer cannot reach a real server.
delete process.env.SMTP_USER;
delete process.env.SMTP_APP_PASSWORD;
