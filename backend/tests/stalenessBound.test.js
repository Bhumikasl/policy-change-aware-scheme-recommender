/**
 * PHASE S — the staleness bound, and the scheduler hole it found.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE TESTS EXIST FOR
 * ---------------------------------------------------------------------------
 * `retryFailedPolicyProcessing` has existed since Phase J. It is implemented,
 * exported, unit-tested, and documented — and until Phase S it was reachable
 * ONLY by a human typing `npm run policy:retry`. Nothing scheduled it. The
 * comment on the notification sweep in `scheduler/cron.js` even refers to "the
 * policy retry sweep" as though it ran.
 *
 * So a transient failure in the impact or propagation stage marked the row
 * `policyRetryable: true` and then waited forever. The affected users kept a
 * recommendation the policy change had already invalidated, with NO BOUND on
 * how long — in a system whose entire claim is that a policy change propagates
 * automatically.
 *
 * Every unit test passed throughout. The function worked; nothing called it.
 * That is why the test at the bottom reads the scheduler's source and asserts
 * the wiring, rather than testing the function again.
 */
const fs = require("fs");
const path = require("path");

const {
  analyse,
  recoveryPaths,
  maxIntervalMinutes,
  STAGE,
  BOUND,
} = require("../src/evaluation/stalenessBound");

// ---------------------------------------------------------------------------
// The interval arithmetic
// ---------------------------------------------------------------------------
describe("S — worst-case wait for a cron schedule", () => {
  it("computes the shapes this project actually configures", () => {
    expect(maxIntervalMinutes("* * * * *")).toBe(1);
    expect(maxIntervalMinutes("*/5 * * * *")).toBe(5); // notification sweep
    expect(maxIntervalMinutes("0 * * * *")).toBe(60); // policy + RAG sweeps
    expect(maxIntervalMinutes("0 */6 * * *")).toBe(360);
    expect(maxIntervalMinutes("0 3 * * *")).toBe(1440); // collection default
  });

  /**
   * The refusal is the point. A bound that is quoted as a guarantee must never
   * be a guess: a day-of-week schedule's worst case depends on the calendar, so
   * this returns null and the report prints NOT MEASURED.
   */
  it("returns null rather than guessing an unsupported shape", () => {
    expect(maxIntervalMinutes("0 0 * * 1")).toBeNull(); // weekly
    expect(maxIntervalMinutes("0 0 1 * *")).toBeNull(); // monthly
    expect(maxIntervalMinutes("not a cron")).toBeNull();
    expect(maxIntervalMinutes("")).toBeNull();
    expect(maxIntervalMinutes(null)).toBeNull();
    expect(maxIntervalMinutes("*/0 * * * *")).toBeNull(); // a zero step is not a schedule

    // FIVE fields, but syntax the parser does not implement — ranges, lists
    // and names. These reach the field check rather than the arity check, and
    // a mutation that made that check return a number instead of null
    // SURVIVED until these cases existed. A fabricated bound is worse than an
    // absent one: it gets quoted as a guarantee.
    expect(maxIntervalMinutes("0 0 * * MON")).toBeNull();
    expect(maxIntervalMinutes("1-30 * * * *")).toBeNull();
    expect(maxIntervalMinutes("0,30 * * * *")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------
describe("S — a stage with no recovery path makes the system UNBOUNDED", () => {
  const env = {
    CRON_SCHEDULE: "0 3 * * *",
    POLICY_RETRY_CRON: "0 * * * *",
    NOTIFICATION_RETRY_CRON: "*/5 * * * *",
    RAG_REINDEX_CRON: "0 * * * *",
  };

  it("is BOUNDED when every stage recovers", () => {
    const out = analyse({ env });
    expect(out.status).toBe(BOUND.BOUNDED);
    expect(out.unrecoveredStages).toEqual([]);
    // 24 h to detect + 1 h to re-run the policy stage.
    expect(out.derived.worstCaseCorrectionMinutes).toBe(1500);
  });

  /**
   * The pre-Phase-S state, reproduced.
   *
   * ONE unrecovered stage makes the WHOLE system unbounded. Averaging it away
   * with the three stages that do recover would describe a system that does not
   * exist — the user whose policy stage failed is not helped by the notification
   * sweep running every five minutes.
   */
  it("is UNBOUNDED when the policy stage has nothing to re-run it", () => {
    const out = analyse({ env, options: { policySweepScheduled: false } });

    expect(out.status).toBe(BOUND.UNBOUNDED);
    expect(out.unrecoveredStages).toEqual([STAGE.POLICY]);
    // And no window is reported at all: there is no worst case to state.
    expect(out.derived.worstCaseCorrectionMinutes).toBeNull();
  });

  it("names the consequence of each stage failing, not just the stage", () => {
    const policy = recoveryPaths(env).find((p) => p.stage === STAGE.POLICY);
    expect(policy.consequence).toMatch(/invalidated recommendation/);
    const rag = recoveryPaths(env).find((p) => p.stage === STAGE.RAG);
    // RAG failing is a freshness problem, NOT an eligibility one. Conflating
    // the two would rank the wrong sweep as urgent.
    expect(rag.consequence).toMatch(/correct/);
  });

  it("reports NOT_MEASURED — not a number — for an unsupported schedule", () => {
    const out = analyse({ env: { ...env, POLICY_RETRY_CRON: "0 0 * * 1" } });
    expect(out.status).toBe(BOUND.NOT_MEASURED);
    expect(out.derived.worstCaseCorrectionMinutes).toBeNull();
  });

  it("keeps DERIVED and MEASURED apart", () => {
    // The derived window is arithmetic on a config value. Presenting it as a
    // measurement would turn a setting into a benchmark result.
    const out = analyse({ env });
    expect(out.derived.basis).toMatch(/configured cron intervals/);
    expect(out.measured.processingMs).toBeNull();
    expect(out.measured.note).toMatch(/NOT MEASURED/);

    const timed = analyse({ env, processingMs: 1234 });
    expect(timed.measured.processingMs).toBe(1234);
    expect(timed.measured.note).not.toMatch(/NOT MEASURED/);
  });

  it("reads the deployment's own schedules, not hardcoded defaults", () => {
    const out = analyse({ env: { ...env, POLICY_RETRY_CRON: "*/10 * * * *" } });
    const policy = out.paths.find((p) => p.stage === STAGE.POLICY);
    expect(policy.maxWaitMinutes).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------
/**
 * THE TEST THAT WOULD HAVE CAUGHT IT.
 *
 * Asserted against the scheduler's SOURCE, because the defect was never in the
 * retry function — it was in nothing calling it. A test of
 * `retryFailedPolicyProcessing` passes identically whether or not anything
 * schedules it, which is exactly how this survived every suite up to Phase R.
 */
describe("S — every recoverable stage is actually wired into the scheduler", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "scheduler", "cron.js"),
    "utf8"
  );
  // Strip comments so a doc block that MENTIONS a sweep cannot satisfy a check.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * Each sweep must be CALLED FROM INSIDE a cron job, not merely imported.
   *
   * An earlier version of these tests asserted that the symbol appeared
   * anywhere in the source — and a mutation that replaced the call with a
   * no-op SURVIVED, because the import line still carried the name. That is
   * the original defect exactly: the function present, and nothing invoking
   * it. Splitting on `cron.schedule(` and dropping the header is what makes
   * the assertion mean "something runs this".
   */
  const jobBodies = code.split("cron.schedule(").slice(1);
  const calledInAJob = (name) => jobBodies.some((b) => b.includes(`${name}(`));

  it("schedules the policy retry sweep", () => {
    expect(jobBodies.length).toBeGreaterThan(0);
    expect(calledInAJob("retryFailedPolicyProcessing")).toBe(true);
  });

  it("schedules the notification retry sweep", () => {
    expect(calledInAJob("retryFailedNotifications")).toBe(true);
  });

  it("schedules the RAG re-index sweep", () => {
    expect(calledInAJob("reindexStaleSchemes")).toBe(true);
  });

  it("schedules the collection cycle", () => {
    expect(calledInAJob("runCollectionCycle")).toBe(true);
  });

  it("registers one job per sweep and uses ONE scheduler", () => {
    const jobs = code.match(/cron\.schedule\(/g) || [];
    expect(jobs.length).toBe(4);
  });

  it("guards every sweep against overlapping itself", () => {
    // A slow sweep outlasting its interval must skip, not run twice: two
    // concurrent sweeps would claim from the same set of due rows.
    for (const flag of ["isRunning", "notificationSweepRunning", "ragSweepRunning", "policySweepRunning"]) {
      expect(code).toMatch(new RegExp(`if\\s*\\(${flag}\\)`));
    }
  });

  it("gives the policy sweep its own configurable schedule", () => {
    expect(code).toMatch(/POLICY_RETRY_CRON/);
    const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
    expect(envExample).toMatch(/POLICY_RETRY_CRON/);
  });
});
