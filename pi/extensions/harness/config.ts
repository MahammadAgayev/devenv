/**
 * Harness settings.
 *
 * A typed constant rather than a config file, matching `statusline/` — a bad
 * value is a compile error, not a silent fallback at 2am in iteration 40.
 *
 * This lives in its own module rather than `index.ts` (where the plan put it)
 * only to keep the import graph acyclic: `loop.ts` needs CONFIG, and `index.ts`
 * needs `loop.ts`.
 *
 * Per-run settings — the validation command above all — are NOT here. They are
 * asked for at `/harness init` and stored in the run's `state.json`, because
 * they are properties of the project, not of the harness.
 */

export interface HarnessConfig {
  /**
   * Context-usage percent at which the loop resets the session.
   *
   * The whole point of the in-process design: compaction alone "doesn't give
   * the agent a clean slate," so crossing this line starts a genuinely fresh
   * session seeded from the run's notes.
   */
  resetThresholdPercent: number;

  /** Hard stop on iterations, so a wedged run ends by itself. */
  maxIterations: number;

  /**
   * Hard stop on session resets, which bounds recursion depth.
   *
   * Each reset nests one more `newSession(withSession: …)` frame. 50 was the
   * number the plan worried about; this keeps it well under.
   */
  maxResets: number;

  /** Timeout for a single validation-command run. */
  validationTimeoutMs: number;

  /** Validation output kept in state and shown to the agent, in characters. */
  validationOutputClip: number;

  /**
   * How long to wait for a turn to actually start after sending a prompt.
   *
   * `sendUserMessage()` returns before the agent begins streaming, so calling
   * `waitForIdle()` immediately can resolve against the *previous* idle state
   * and spin the loop. The loop waits for non-idle first, bounded by this.
   */
  turnStartTimeoutMs: number;

  /** Poll interval for the idle transitions above. */
  pollIntervalMs: number;

  /**
   * Run the evaluator subagent once the validation command passes.
   *
   * The validation command is the primary oracle; the evaluator is a second
   * opinion from a context that never watched the code get written, which is
   * what catches "passes the test by special-casing the test."
   */
  useEvaluator: boolean;

  /** Commit any dirty worktree after each iteration, as a monitoring backstop. */
  commitEachIteration: boolean;
}

export const CONFIG: HarnessConfig = {
  resetThresholdPercent: 70,
  maxIterations: 50,
  maxResets: 25,
  validationTimeoutMs: 10 * 60 * 1000,
  validationOutputClip: 4000,
  turnStartTimeoutMs: 15000,
  pollIntervalMs: 100,
  useEvaluator: true,
  commitEachIteration: true,
};
