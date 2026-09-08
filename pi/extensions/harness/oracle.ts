/**
 * The oracle: does the work meet its criterion yet?
 *
 * Two layers, in order of authority:
 *
 *   1. The validation command — a shell command the user named at init. Exit 0
 *      means done. This is the load-bearing part, and it is deliberately not a
 *      model judgement: an agent asked "are you finished?" says yes.
 *
 *   2. The evaluator subagent — runs only once the command passes, in a context
 *      that never watched the code get written. It reads the diff against the
 *      task and can send the run back with NEEDS_WORK. This is what catches a
 *      test suite that passes because the test was special-cased.
 *
 * `runValidation` shells out and `evaluate` spawns a subagent, so neither is
 * pure — but the parsing they depend on (`parseEvaluatorVerdict`, `clip`) is,
 * and that is where the mistakes live.
 */

import { spawn } from "node:child_process";
import { CONFIG } from "./config.ts";
import type { Verdict } from "./state.ts";

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

export interface ValidationResult {
  verdict: Verdict;
  /** Null when the command could not be run or was killed by the timeout. */
  exitCode: number | null;
  /** Combined stdout+stderr, clipped. */
  output: string;
  timedOut: boolean;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // Keep the tail: test runners put the failure summary at the end, and that is
  // the part the agent needs. A head-clip would hand it the banner instead.
  return `… [${text.length - max} earlier chars omitted]\n${text.slice(-max)}`;
}

/**
 * Run the validation command via the user's shell.
 *
 * `sh -c` rather than a parsed argv: the command comes from a human who typed
 * something like `pytest -x -q 2>&1 | tail -40`, and pipes and redirections are
 * a reasonable thing for them to have written.
 */
export function runValidation(command: string, cwd: string, signal?: AbortSignal): Promise<ValidationResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // Spawn failure (no shell, bad cwd): ERROR, not FAIL. The distinction
      // matters — FAIL means "keep working", ERROR means "the oracle is broken
      // and iterating will not fix it."
      resolve({
        verdict: "ERROR",
        exitCode: null,
        output: `Validation command could not be run: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
      });
      return;
    }

    let out = "";
    let timedOut = false;
    let settled = false;

    // Bound the buffer: a runaway command that prints forever must not grow the
    // heap until pi dies. Twice the clip is plenty to keep a meaningful tail.
    const cap = CONFIG.validationOutputClip * 2;
    const append = (chunk: Buffer) => {
      out += chunk.toString("utf-8");
      if (out.length > cap) out = out.slice(-cap);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CONFIG.validationTimeoutMs);

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: ValidationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", (err) => {
      finish({
        verdict: "ERROR",
        exitCode: null,
        output: `Validation command could not be run: ${err.message}`,
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      const output = clip(out.trim(), CONFIG.validationOutputClip);

      if (timedOut) {
        finish({
          verdict: "ERROR",
          exitCode: null,
          output: output || `Validation timed out after ${Math.round(CONFIG.validationTimeoutMs / 1000)}s`,
          timedOut: true,
        });
        return;
      }

      // A null code means the process was signalled rather than exiting. That
      // is not a test failure, so it must not read as one.
      if (code === null) {
        finish({ verdict: "ERROR", exitCode: null, output: output || "Validation was terminated by a signal", timedOut: false });
        return;
      }

      // 126/127 are the shell's own "could not execute" codes: command not
      // found, or found but not executable. That is a broken oracle, not a
      // failing test — a typo in the validation command would otherwise look
      // exactly like a test suite that never passes, and the run would burn
      // every one of its iterations before giving up.
      if (code === 126 || code === 127) {
        finish({
          verdict: "ERROR",
          exitCode: code,
          output:
            `The validation command could not be executed (exit ${code}).\n` +
            `Check that \`${command.split(/\s+/)[0]}\` exists and is on PATH.\n\n${output}`,
          timedOut: false,
        });
        return;
      }

      finish({
        verdict: code === 0 ? "PASS" : "FAIL",
        exitCode: code,
        output,
        timedOut: false,
      });
    });
  });
}

export type EvaluatorVerdict = "PASS" | "NEEDS_WORK";

export interface EvaluationResult {
  verdict: EvaluatorVerdict;
  /** The evaluator's reasoning, fed into the next iteration's prompt. */
  findings: string;
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
 * Second-opinion review from a fresh context.
 *
 * Runs headless via the same mechanism as `/handoff`, so it costs the main
 * session one short string rather than a full review transcript.
 */
export async function evaluate(opts: {
  cwd: string;
  task: string;
  validationCommand: string;
  validationOutput: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<EvaluationResult> {
  const task = [
    "Judge whether the work in this repository genuinely satisfies its task.",
    "",
    "## The task",
    "",
    opts.task,
    "",
    "## Validation",
    "",
    `The command \`${opts.validationCommand}\` exits 0, so the mechanical check passes.`,
    "Your job is to find the ways that could be true while the task is not actually done:",
    "tests that assert nothing, a function special-cased for its test, a criterion met in",
    "letter but not substance, work that is stubbed rather than implemented.",
    "",
    "Read the diff (`git diff`, `git log`, `git status`) and the files it touches.",
    "",
    "Last validation output:",
    "```",
    opts.validationOutput || "(empty)",
    "```",
    "",
    "## Reply format",
    "",
    "A few sentences on what you checked and what you found. Then a final line that is",
    "exactly `PASS` or `NEEDS_WORK` and nothing else.",
    "If NEEDS_WORK, be specific about what to fix — your text is handed to the builder verbatim.",
  ].join("\n");

  const runAgentHeadless = await loadRunAgentHeadless();
  const result = await runAgentHeadless({
    cwd: opts.cwd,
    agent: "evaluator",
    task,
    model: opts.model,
    signal: opts.signal,
  });

  if (result.exitCode !== 0) {
    // A crashed evaluator is not a passing evaluator.
    return {
      verdict: "NEEDS_WORK",
      findings: `Evaluator failed to run: ${result.stderr.slice(0, 300) || "unknown error"}`,
    };
  }

  const findings = result.output.trim();
  return { verdict: parseEvaluatorVerdict(findings), findings };
}
