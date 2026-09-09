/**
 * The loop.
 *
 * `runLoop(ctx)` is entered from the `/harness start` command handler and does
 * not return until the run ends. Iterations happen inside it; when context
 * pressure crosses the threshold it calls `newSession()` and re-enters itself
 * with the fresh context handed to `withSession`. Recursion depth equals reset
 * count, bounded by `CONFIG.maxResets`.
 *
 * Why a command handler and not `agent_settled`: `newSession()` lives on
 * `ExtensionCommandContext`, not on the plain `ExtensionContext` that event
 * handlers receive (`dist/core/extensions/types.d.ts:254-266`, commented
 * "session control methods only safe in user-initiated commands"). An event-driven
 * loop could only call `compact()`, and compaction is explicitly not a clean
 * slate. So the loop lives where the reset is legal.
 *
 * The rule that shapes everything here: **no loop state in closure scope.**
 * After `newSession()` the old `pi` and `ctx` are stale and throw if touched
 * (`docs/extensions.md:1242-1290`), and `withSession` runs after the old
 * extension instance's shutdown. Only plain data survives the hop, so all state
 * goes through `state.json` and each recursion level touches only the ctx it
 * was handed.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ReplacedSessionContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { CONFIG } from "./config.ts";
import { setActiveRun } from "./control.ts";
import { evaluate } from "./oracle.ts";
import { finalNotePrompt, iterationPrompt, resetSeed } from "./prompts.ts";
import {
  appendLog,
  clearStop,
  describeReadFailure,
  readState,
  readTask,
  runDir,
  stopRequested,
  takeSteer,
  writeState,
  type HarnessState,
  type Verdict,
} from "./state.ts";

/** Why a run stopped. Recorded in state and used for the closing note. */
type EndReason =
  | "the reviewer confirmed it is done"
  | "stopped by user"
  | "hit the iteration limit"
  | "hit the reset limit"
  | "the reviewer could not be run"
  | "interrupted";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Any context the loop can run against.
 *
 * The two differ in one way that matters: `ReplacedSessionContext` (handed to
 * `withSession` after a reset) carries its own bound `sendUserMessage`, while
 * the plain `ExtensionCommandContext` from a command handler does NOT — sending
 * from there goes through the `pi` API object instead. See `sendPrompt`.
 */
type LoopContext = ExtensionCommandContext | ReplacedSessionContext;

/**
 * Send a user message from whichever context we hold.
 *
 * `sendUserMessage` lives on `ExtensionAPI` and on `ReplacedSessionContext`,
 * but *not* on `ExtensionCommandContext` (verified against
 * `dist/core/extensions/types.d.ts`: the command-context interface has only
 * `getSystemPromptOptions`, `waitForIdle`, `newSession`, `fork`,
 * `navigateTree`, `switchSession`, and `reload`).
 *
 * Calling `ctx.sendUserMessage(...)` on a command context is a TypeError, which
 * is precisely how the first version of this loop failed: `/harness start`
 * threw on its very first send, the surrounding catch logged to the run's
 * log.md and returned, and the user saw nothing happen at all.
 *
 * After a reset the replacement context is the correct sender — it is bound to
 * the new session, whereas `pi` may still reference the old one — so prefer it
 * when present and fall back to the API object otherwise.
 */
async function sendPrompt(pi: ExtensionAPI, ctx: LoopContext, content: string): Promise<void> {
  const bound = (ctx as ReplacedSessionContext).sendUserMessage;
  if (typeof bound === "function") {
    await bound.call(ctx, content);
    return;
  }
  await pi.sendUserMessage(content);
}

/**
 * Wait for the agent to pick up the message we just sent, then go idle again.
 *
 * `sendUserMessage()` resolves before streaming begins, so a bare
 * `waitForIdle()` can observe the *previous* idle state and return instantly —
 * which spins the loop at full speed sending prompt after prompt. Waiting for
 * the non-idle edge first is what makes one iteration mean one turn.
 *
 * If the turn never starts within the timeout, we fall through rather than
 * hanging: better a wasted iteration than a run wedged forever.
 */
async function waitForTurn(ctx: LoopContext): Promise<void> {
  const deadline = Date.now() + CONFIG.turnStartTimeoutMs;
  while (ctx.isIdle() && Date.now() < deadline) {
    await sleep(CONFIG.pollIntervalMs);
  }
  await ctx.waitForIdle();
}

/**
 * Commit whatever is in the tree, as a monitoring backstop.
 *
 * Not for tidiness — it is so that a run that goes wrong overnight leaves a
 * bisectable history instead of one enormous diff. Failures are swallowed: no
 * repo, nothing staged, or a pre-commit hook saying no are all fine and none of
 * them should end the run.
 */
function commitBackstop(cwd: string, message: string): void {
  const run = (args: string[]) =>
    new Promise<void>((resolve) => {
      const child = spawn("git", args, { cwd, stdio: "ignore" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
  void (async () => {
    await run(["add", "-A"]);
    await run(["commit", "-m", message, "--no-verify"]);
  })();
}


function recordSession(state: HarnessState, ctx: LoopContext): void {
  let file: string | undefined;
  try {
    file = ctx.sessionManager.getSessionFile?.();
  } catch {
    /* in-memory session, or a manager that does not expose it */
  }
  const id = file ?? `(session ${state.sessionChain.length + 1})`;
  if (state.sessionChain[state.sessionChain.length - 1] !== id) {
    state.sessionChain.push(id);
  }
}

/**
 * End a run: record the reason, ask for a closing note, release the gate.
 *
 * The closing note is best-effort. A run that ended because the user stopped it
 * may well get its final turn blocked by the very stop gate that ended it —
 * which is correct behaviour, and not worth complicating either side to avoid.
 */
async function finishRun(
  pi: ExtensionAPI,
  ctx: LoopContext,
  state: HarnessState,
  reason: EndReason,
  status: HarnessState["status"],
): Promise<void> {
  state.status = status;
  writeState(state);
  appendLog(state.name, `run ended — ${reason} (${state.iteration} iterations)`);

  const stoppedByUser = reason === "stopped by user";
  if (!stoppedByUser) {
    try {
      await sendPrompt(pi, ctx, finalNotePrompt(state, runDir(state.name), reason));
      await waitForTurn(ctx);
    } catch {
      /* the run is over; a missing closing note is not worth surfacing */
    }
  }

  setActiveRun(null);
  ctx.ui.notify(
    `harness "${state.name}": ${reason} · ${state.iteration} iterations · last verdict ${state.lastVerdict}`,
    status === "done" ? "info" : "warning",
  );
}

/**
 * Abandon a run without a closing note.
 *
 * Distinct from `finishRun`: this is for the case where we could not talk to the
 * agent at all, so asking it for a summary is pointless. The failure goes to the
 * UI and not just log.md, because the symptom — `/harness start` appearing to do
 * nothing — is otherwise invisible.
 */
function abortRun(ctx: LoopContext, state: HarnessState, message: string): void {
  appendLog(state.name, `send failed: ${message}`);
  state.status = "failed";
  writeState(state);
  setActiveRun(null);
  ctx.ui.notify(`harness "${state.name}": could not send the iteration prompt — ${message}`, "error");
}

/**
 * Should the run stop before spending another turn?
 *
 * Checked at the top of every iteration and again after the oracle, so a stop
 * requested mid-turn is honoured at the next boundary rather than after another
 * full turn's worth of tokens.
 */
function haltReason(state: HarnessState): { reason: EndReason; status: HarnessState["status"] } | null {
  if (stopRequested(state.name)) return { reason: "stopped by user", status: "stopped" };
  if (state.iteration >= CONFIG.maxIterations) {
    return { reason: "hit the iteration limit", status: "failed" };
  }
  return null;
}

/**
 * Assemble this iteration's prompt and send it.
 *
 * Returns null on success, or the error message if the send failed — usually the
 * session going away underneath us (reload, shutdown, a manual `/new`), which is
 * not recoverable but is also not alarming.
 *
 * Consuming `STEER.md` is part of sending rather than a separate step: the steer
 * is destroyed by reading it, so it must not be taken until the prompt that
 * carries it is actually being built.
 */
async function sendIterationPrompt(
  pi: ExtensionAPI,
  ctx: LoopContext,
  state: HarnessState,
  opts: { findings?: string; freshSession: boolean },
): Promise<string | null> {
  const steer = takeSteer(state.name);
  if (steer) appendLog(state.name, `steer consumed: ${steer.slice(0, 120)}`);

  const prompt = iterationPrompt({
    state,
    task: readTask(state.name),
    runDir: runDir(state.name),
    evaluatorFindings: opts.findings,
    steer: steer ?? undefined,
    freshSession: opts.freshSession,
  });

  try {
    await sendPrompt(pi, ctx, prompt);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Pick the state back up after a turn and count the iteration.
 *
 * Re-read rather than reused: the agent may have edited state.json during its
 * turn, and an in-memory copy captured before the turn would clobber those
 * edits — including its own log of what it did.
 */
function reloadAfterTurn(state: HarnessState): HarnessState {
  const current = readState(state.name) ?? state;
  current.iteration += 1;
  return current;
}

/** What the oracle concluded this iteration. */
interface OracleReading {
  verdict: Verdict;
  /** The reviewer's complaint, fed into the next prompt. Set only on NEEDS_WORK. */
  findings?: string;
  /** The reviewer judged the work finished. */
  done: boolean;
}

/**
 * Ask the reviewer where the work stands.
 *
 * Runs every iteration, and its verdict is the whole reading: PASS ends the run,
 * NEEDS_WORK becomes FAIL and the findings go into the next prompt.
 *
 * A reviewer that could not be dispatched at all is ERROR rather than FAIL. The
 * difference is what the loop does next — FAIL means keep working, ERROR means
 * nothing is being measured and iterating cannot help.
 *
 * Mutates and persists `state`: the verdict and the findings belong to the
 * iteration that just ended, and a crash between here and the next write should
 * not lose them.
 */
async function consultOracle(ctx: LoopContext, state: HarnessState): Promise<OracleReading> {
  ctx.ui.notify(`harness "${state.name}": reviewing`, "info");

  const evaluation = await evaluate({
    cwd: state.cwd,
    task: readTask(state.name),
    iteration: state.iteration,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    signal: ctx.signal,
  });

  state.lastOutput = evaluation.findings;

  if (evaluation.errored) {
    state.lastVerdict = "ERROR";
    appendLog(state.name, `reviewer could not be run: ${evaluation.findings.slice(0, 200)}`);
    return { verdict: "ERROR", done: false };
  }

  const passed = evaluation.verdict === "PASS";
  state.lastVerdict = passed ? "PASS" : "FAIL";
  if (!passed) {
    appendLog(state.name, `reviewer returned NEEDS_WORK: ${evaluation.findings.slice(0, 200)}`);
  }

  return {
    verdict: state.lastVerdict,
    findings: passed ? undefined : evaluation.findings,
    done: passed,
  };
}

/**
 * Append the iteration to the history and take the commit snapshot.
 *
 * Separate from `consultOracle` so the caller can decline to record: an
 * iteration killed by a third unrunnable reviewer measured nothing, and gets
 * neither a history row nor a snapshot. Reading the oracle and writing
 * down what it said are also just different jobs — one talks to the outside
 * world, the other only touches `state`.
 */
function recordIteration(state: HarnessState, reading: OracleReading): void {
  state.history.push({
    iteration: state.iteration,
    verdict: reading.verdict,
    timestamp: new Date().toISOString(),
  });
  writeState(state);

  if (CONFIG.commitEachIteration) {
    commitBackstop(state.cwd, `harness(${state.name}): iteration ${state.iteration} [${reading.verdict}]`);
  }
}

/**
 * How much of the context window is gone, or null when pi cannot say yet.
 *
 * Returns null rather than 0 for "unknown", so an unavailable reading never
 * looks like an empty context and never triggers or suppresses a reset.
 */
function contextPercent(ctx: LoopContext): number | null {
  try {
    return ctx.getContextUsage()?.percent ?? null;
  } catch {
    return null;
  }
}

/** What `attemptReset` decided. */
type ResetOutcome =
  /** A fresh session took over; this frame has nothing left to do. */
  | { kind: "handedOff" }
  /** The reset did not happen and the run is over for the given reason. */
  | { kind: "end"; reason: EndReason; status: HarnessState["status"] };

/**
 * Swap in a fresh session and continue the run inside it.
 *
 * The recursion is the awkward part, so to be explicit about what happens:
 * `newSession()` tears down this extension instance and builds a new one, then
 * calls `withSession` with a context bound to the replacement. `runLoop` is
 * re-entered there and runs the *rest of the run* to completion inside that
 * call — so by the time `newSession()` returns, the run has already ended.
 * There is nothing sensible for this frame to do afterwards, which is why the
 * caller returns immediately on `handedOff` rather than looping.
 *
 * Depth therefore equals the number of resets, bounded by `CONFIG.maxResets`.
 *
 * Only strings cross the boundary. `state` and `ctx` are stale the moment the
 * replacement happens, so the far side re-reads everything from disk; the one
 * exception is the cancelled path, where the swap did not occur and this frame's
 * `ctx` is therefore still the live one.
 */
async function attemptReset(
  pi: ExtensionAPI,
  ctx: LoopContext,
  state: HarnessState,
  percent: number,
): Promise<ResetOutcome> {
  if (state.sessionChain.length >= CONFIG.maxResets) {
    return { kind: "end", reason: "hit the reset limit", status: "failed" };
  }

  const runName = state.name;
  const seed = resetSeed(state, runDir(runName));
  const rounded = Math.round(percent);

  appendLog(runName, `context at ${rounded}% — resetting session`);
  ctx.ui.notify(`harness "${runName}": context ${rounded}% — starting fresh session`, "info");
  writeState(state);

  const result = await ctx.newSession({
    withSession: async (fresh) => {
      // `fresh` is the only valid context from here on. The `ctx` in scope is
      // now stale and must not be touched again on this path.
      await fresh.sendUserMessage(seed);
      await fresh.waitForIdle();
      await runLoop(pi, fresh, runName, true);
    },
  });

  if (result.cancelled) {
    appendLog(runName, "session reset was cancelled — ending run");
    return { kind: "end", reason: "interrupted", status: "idle" };
  }
  return { kind: "handedOff" };
}

/**
 * Run iterations until something ends the run.
 *
 * The body is deliberately just the sequence — halt, send, wait, measure, decide
 * — with each step's detail behind a named helper above. Everything that must
 * survive a session reset lives in `state.json`; the three locals here are the
 * only loop-carried values, and all three are re-derived after a reset because
 * the fresh session re-enters this function from the top.
 *
 * `freshSession` is true on the first call and on the first iteration after
 * every reset; it switches the prompt into "you have no memory, read the log"
 * mode.
 */
export async function runLoop(
  pi: ExtensionAPI,
  ctx: LoopContext,
  name: string,
  freshSession: boolean,
): Promise<void> {
  // Re-read state from disk on entry rather than taking it as an argument.
  // After a reset this function is running in a new session, and a HarnessState
  // captured before the hop is exactly the kind of stale data that causes the
  // bugs this design exists to avoid.
  let state = readState(name);
  if (!state) {
    ctx.ui.notify(`${describeReadFailure(name)} — cannot continue`, "error");
    setActiveRun(null);
    return;
  }

  setActiveRun(name);
  state.status = "running";
  recordSession(state, ctx);
  writeState(state);

  let isFresh = freshSession;
  let pendingFindings: string | undefined;
  // Consecutive iterations where the reviewer could not be dispatched at all.
  // Distinct from NEEDS_WORK: a broken oracle means nothing is being measured, so
  // looping on it burns tokens producing no signal.
  let consecutiveErrors = 0;

  for (;;) {
    const halt = haltReason(state);
    if (halt) {
      await finishRun(pi, ctx, state, halt.reason, halt.status);
      return;
    }

    const sendError = await sendIterationPrompt(pi, ctx, state, {
      findings: pendingFindings,
      freshSession: isFresh,
    });
    pendingFindings = undefined;
    isFresh = false;
    if (sendError !== null) {
      abortRun(ctx, state, sendError);
      return;
    }

    await waitForTurn(ctx);
    state = reloadAfterTurn(state);

    const reading = await consultOracle(ctx, state);
    pendingFindings = reading.findings;

    // A few strikes on a reviewer that will not dispatch at all. This is not the
    // reviewer saying the work is unfinished — it is the reviewer never having
    // run, which no amount of iterating will fix.
    //
    // Checked before recording: an iteration that measured nothing earns no
    // history entry and no snapshot, so a broken oracle does not pad the run's
    // record with identical ERROR rows.
    consecutiveErrors = reading.verdict === "ERROR" ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= CONFIG.maxEvaluatorErrors) {
      writeState(state);
      await finishRun(pi, ctx, state, "the reviewer could not be run", "failed");
      return;
    }

    recordIteration(state, reading);

    if (reading.done) {
      await finishRun(pi, ctx, state, "the reviewer confirmed it is done", "done");
      return;
    }

    // Checked again here because the turn we just spent is the long part of an
    // iteration; a stop arriving during it should not cost another one.
    if (stopRequested(name)) {
      await finishRun(pi, ctx, state, "stopped by user", "stopped");
      return;
    }

    const percent = contextPercent(ctx);
    if (percent !== null && percent >= CONFIG.resetThresholdPercent) {
      const outcome = await attemptReset(pi, ctx, state, percent);
      if (outcome.kind === "end") {
        await finishRun(pi, ctx, state, outcome.reason, outcome.status);
      }
      // Either the recursive call owns the run now, or we just closed it out.
      return;
    }
  }
}

/** Entry point for `/harness start`. Clears any stale stop flag first. */
export async function startRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  clearStop(name);
  await runLoop(pi, ctx, name, true);
}
