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
 * Everything here is a property of the harness. Anything specific to the work —
 * including how the project is built and tested — belongs in the run's
 * `task.md`, where the agent and the reviewer both read it.
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

  /** Reviewer findings kept in state and shown to the agent, in characters. */
  findingsClip: number;

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
   * Consecutive iterations where the reviewer itself failed to run before the
   * run gives up.
   *
   * A crashed subagent measured nothing, so looping on it produces no signal.
   * Distinct from NEEDS_WORK, which is a real reading and means keep going.
   */
  maxEvaluatorErrors: number;

  /** Commit any dirty worktree after each iteration, as a monitoring backstop. */
  commitEachIteration: boolean;
}

export const CONFIG: HarnessConfig = {
  resetThresholdPercent: 70,
  maxIterations: 50,
  maxResets: 25,
  findingsClip: 4000,
  turnStartTimeoutMs: 15000,
  pollIntervalMs: 100,
  maxEvaluatorErrors: 3,
  commitEachIteration: true,
};
