/**
 * The oracle: is the work finished yet?
 *
 * One layer. A reviewer subagent, in a context that never watched the code get
 * written, reads the diff against the task and answers PASS or NEEDS_WORK.
 *
 * There is deliberately no validation command. An earlier version made one
 * mandatory at init, on the theory that a shell exit code is not a model
 * judgement and an agent asked "are you finished?" says yes. That theory is
 * sound and the mechanism was still wrong: it demanded a single exit-0 command
 * before the work existed, which many tasks do not have, and a made-up one is
 * worse than none — an oracle measuring the wrong thing finishes confidently
 * having done nothing. In practice the field got filled with prose, which is not
 * a command, and the run spent every iteration on exit 127.
 *
 * So the check the project actually has now belongs in `task.md`, where the
 * reviewer will read it, and where it can be a paragraph rather than one line.
 * The reviewer is told to find and run the build and tests itself; a verdict
 * reached without running anything is the failure mode to watch for, and it is
 * what the prompt spends most of its length guarding against.
 *
 * `evaluate` spawns a subagent so it is not pure, but `evaluatorTask`,
 * `parseEvaluatorVerdict`, and `clip` are, and that is where the mistakes live.
 */

import { CONFIG } from "./config.ts";

/**
 * Load `runAgentHeadless` on demand.
 *
 * A static import would pull in `../agents/index.ts`, and with it typebox and
 * the pi-tui renderers that the `agent` *tool* needs but a headless dispatch
 * does not. That makes this module unloadable outside a pi runtime, which in
 * turn makes the pure functions here untestable. Deferring the import keeps
 * the cost where it belongs: paid once, only when an evaluator actually runs.
 */
async function loadRunAgentHeadless() {
  const mod = await import("../agents/index.ts");
  return mod.runAgentHeadless;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // Keep the tail: test runners put the failure summary at the end, and that is
  // the part the agent needs. A head-clip would hand it the banner instead.
  return `… [${text.length - max} earlier chars omitted]\n${text.slice(-max)}`;
}

export type EvaluatorVerdict = "PASS" | "NEEDS_WORK";

export interface EvaluationResult {
  verdict: EvaluatorVerdict;
  /** The evaluator's reasoning, fed into the next iteration's prompt. */
  findings: string;
  /**
   * The subagent itself failed to run — a crash, a bad model, a cancelled
   * dispatch. Distinct from NEEDS_WORK: nothing was measured, so iterating on it
   * produces no signal and the loop counts these toward its error budget.
   */
  errored: boolean;
}

/**
 * Extract the verdict from the evaluator's reply.
 *
 * Scans from the end: the contract asks for the verdict on the last line, and
 * models routinely discuss both words ("this is not NEEDS_WORK because…")
 * before committing. The last occurrence is the decision; earlier ones are
 * deliberation.
 *
 * Defaults to NEEDS_WORK when neither token appears. An unparseable evaluator
 * must not be able to declare a run finished — the failure mode has to be
 * "keeps working", never "stops early and claims success".
 */
export function parseEvaluatorVerdict(text: string): EvaluatorVerdict {
  const lines = text.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].toUpperCase();
    if (line.includes("NEEDS_WORK")) return "NEEDS_WORK";
    if (line.includes("PASS")) return "PASS";
  }
  return "NEEDS_WORK";
}

/**
 * Build the reviewer's instruction.
 *
 * Pure, and separate from `evaluate` so the wording — the part that decides
 * whether a run ends correctly — is testable without spawning anything.
 *
 * Most of this text exists to stop one specific failure: a reviewer that reads
 * the diff, finds it plausible, and says PASS without ever running the code.
 * That is a model grading a model, and it is exactly what the old validation
 * command was there to prevent. Making the reviewer establish the facts first is
 * what replaces it.
 */
export function evaluatorTask(opts: { task: string; iteration: number }): string {
  return [
    "Judge whether the work in this repository genuinely satisfies its task.",
    "",
    "## The task",
    "",
    opts.task,
    "",
    "## You are the only check",
    "",
    `This is iteration ${opts.iteration} of an unattended run. There is no validation`,
    "command: nothing was measured before you and nothing will be measured after you.",
    "Your verdict alone decides whether the run ends, and a PASS ships the work as",
    "finished.",
    "",
    "So do not judge from the diff alone. Establish the facts first:",
    "",
    "1. Work out how this project builds and tests — a Makefile, package.json scripts,",
    "   go.mod, Cargo.toml, pyproject.toml, or whatever the task and the run's log.md",
    "   say has been used. If the task names a specific command, that one is",
    "   authoritative; use it.",
    "2. Run it yourself. Say what you ran and what it printed.",
    "3. If it does not build, or the tests do not run, that is NEEDS_WORK regardless of",
    "   how well the code reads.",
    "",
    "Then judge as you otherwise would: tests that assert nothing, a function",
    "special-cased for its test, a criterion met in letter but not substance, work that",
    "is stubbed rather than implemented.",
    "",
    "Read the diff (`git diff`, `git log`, `git status`) and the files it touches.",
    "",
    "## Reply format",
    "",
    "A few sentences on what you checked — including what you ran — and what you found.",
    "Then a final line that is exactly `PASS` or `NEEDS_WORK` and nothing else.",
    "If NEEDS_WORK, be specific about what to fix — your text is handed to the builder verbatim.",
  ].join("\n");
}

/**
 * Review from a fresh context.
 *
 * Runs headless via the same mechanism as `/handoff`, so it costs the main
 * session one short string rather than a full review transcript.
 */
export async function evaluate(opts: {
  cwd: string;
  task: string;
  iteration: number;
  model?: string;
  signal?: AbortSignal;
}): Promise<EvaluationResult> {
  const task = evaluatorTask({ task: opts.task, iteration: opts.iteration });

  const runAgentHeadless = await loadRunAgentHeadless();
  const result = await runAgentHeadless({
    cwd: opts.cwd,
    agent: "evaluator",
    task,
    model: opts.model,
    signal: opts.signal,
  });

  if (result.exitCode !== 0) {
    // A crashed evaluator is not a passing evaluator. It is also not a failing
    // one: nothing was judged, so this is flagged as an error and the loop stops
    // after a few in a row rather than spending fifty iterations on a broken
    // dispatch.
    return {
      verdict: "NEEDS_WORK",
      findings: `Evaluator failed to run: ${result.stderr.slice(0, 300) || "unknown error"}`,
      errored: true,
    };
  }

  const findings = clip(result.output.trim(), CONFIG.findingsClip);
  return { verdict: parseEvaluatorVerdict(findings), findings, errored: false };
}
