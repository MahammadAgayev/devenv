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
import { evaluate, runValidation } from "./oracle.ts";
import { finalNotePrompt, iterationPrompt, resetSeed } from "./prompts.ts";
import {
  appendLog,
  clearStop,
  readState,
  readTask,
  runDir,
  stopRequested,
  takeSteer,
  writeState,
  type HarnessState,
} from "./state.ts";

/** Why a run stopped. Recorded in state and used for the closing note. */
type EndReason =
  | "validation passed and review confirmed it"
  | "stopped by user"
  | "hit the iteration limit"
  | "hit the reset limit"
  | "the validation command is broken"
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

/** Percent of context used, or null when pi cannot say yet. */
function contextPercent(ctx: LoopContext): number | null {
  try {
    return ctx.getContextUsage()?.percent ?? null;
  } catch {
    return null;
  }
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
 * Run iterations until something ends the run.
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
    ctx.ui.notify(`harness: run "${name}" has no state.json — cannot continue`, "error");
    setActiveRun(null);
    return;
  }

  setActiveRun(name);
  state.status = "running";
  recordSession(state, ctx);
  writeState(state);

  let isFresh = freshSession;
  let pendingFindings: string | undefined;
  // Consecutive iterations where the validation command could not run at all.
  // Distinct from failing tests: a broken oracle means nothing is being
  // measured, so looping on it burns tokens producing no signal.
  let consecutiveErrors = 0;

  for (;;) {
    // ── Stop checks, before spending a turn ──────────────────────────────
    if (stopRequested(name)) {
      await finishRun(pi, ctx, state, "stopped by user", "stopped");
      return;
    }
    if (state.iteration >= CONFIG.maxIterations) {
      await finishRun(pi, ctx, state, "hit the iteration limit", "failed");
      return;
    }

    // ── Send the iteration prompt ────────────────────────────────────────
    const steer = takeSteer(name);
    if (steer) appendLog(name, `steer consumed: ${steer.slice(0, 120)}`);

    const prompt = iterationPrompt({
      state,
      task: readTask(name),
      runDir: runDir(name),
      evaluatorFindings: pendingFindings,
      steer: steer ?? undefined,
      freshSession: isFresh,
    });
    pendingFindings = undefined;
    isFresh = false;

    try {
      await sendPrompt(pi, ctx, prompt);
    } catch (err) {
      // Usually the session going away underneath us (reload, shutdown, manual
      // /new), which is not recoverable but is also not alarming.
      //
      // It is surfaced in the UI rather than only appended to log.md because
      // the first version of this loop swallowed a TypeError here — sending on
      // a context that has no `sendUserMessage` — and `/harness start` did
      // nothing at all, with no visible reason. A run that cannot send its
      // first prompt has failed; say so where the user is looking.
      const message = err instanceof Error ? err.message : String(err);
      appendLog(name, `send failed: ${message}`);
      state.status = "failed";
      writeState(state);
      setActiveRun(null);
      ctx.ui.notify(`harness "${name}": could not send the iteration prompt — ${message}`, "error");
      return;
    }

    await waitForTurn(ctx);

    // Re-read: the agent may have edited state.json, and the iteration counter
    // must not be clobbered by a stale in-memory copy.
    state = readState(name) ?? state;
    state.iteration += 1;

    // ── Consult the oracle ───────────────────────────────────────────────
    const validation = await runValidation(state.validationCommand, state.cwd, ctx.signal);
    state.lastVerdict = validation.verdict;
    state.lastOutput = validation.output;

    // Three strikes on a command that will not even execute. The agent has had
    // three iterations with an explicit "fix the oracle first" prompt; if it
    // still cannot run, something outside its reach is wrong.
    consecutiveErrors = validation.verdict === "ERROR" ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) {
      writeState(state);
      await finishRun(pi, ctx, state, "the validation command is broken", "failed");
      return;
    }

    let evaluatorVerdict: "PASS" | "NEEDS_WORK" | undefined;

    if (validation.verdict === "PASS" && CONFIG.useEvaluator) {
      ctx.ui.notify(`harness "${name}": validation passed — reviewing`, "info");
      const evaluation = await evaluate({
        cwd: state.cwd,
        task: readTask(name),
        validationCommand: state.validationCommand,
        validationOutput: validation.output,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        signal: ctx.signal,
      });
      evaluatorVerdict = evaluation.verdict;
      if (evaluation.verdict === "NEEDS_WORK") {
        pendingFindings = evaluation.findings;
        appendLog(name, `reviewer returned NEEDS_WORK: ${evaluation.findings.slice(0, 200)}`);
      }
    }

    state.history.push({
      iteration: state.iteration,
      verdict: validation.verdict,
      exitCode: validation.exitCode,
      ...(evaluatorVerdict ? { evaluator: evaluatorVerdict } : {}),
      timestamp: new Date().toISOString(),
    });
    writeState(state);

    if (CONFIG.commitEachIteration) {
      commitBackstop(state.cwd, `harness(${name}): iteration ${state.iteration} [${validation.verdict}]`);
    }

    // ── Done? ────────────────────────────────────────────────────────────
    const done = validation.verdict === "PASS" && (!CONFIG.useEvaluator || evaluatorVerdict === "PASS");
    if (done) {
      await finishRun(pi, ctx, state, "validation passed and review confirmed it", "done");
      return;
    }

    if (stopRequested(name)) {
      await finishRun(pi, ctx, state, "stopped by user", "stopped");
      return;
    }

    // ── Reset the context if it is filling up ────────────────────────────
    const percent = contextPercent(ctx);
    if (percent !== null && percent >= CONFIG.resetThresholdPercent) {
      const resets = state.sessionChain.length;
      if (resets >= CONFIG.maxResets) {
        await finishRun(pi, ctx, state, "hit the reset limit", "failed");
        return;
      }

      // Only plain strings cross this boundary. Everything else is re-read
      // from disk on the other side by the recursive runLoop call.
      const runName = state.name;
      const seed = resetSeed(state, runDir(runName));

      appendLog(runName, `context at ${Math.round(percent)}% — resetting session`);
      ctx.ui.notify(`harness "${runName}": context ${Math.round(percent)}% — starting fresh session`, "info");
      writeState(state);

      const result = await ctx.newSession({
        withSession: async (fresh) => {
          // `fresh` is the only valid context from here on. The `ctx` in scope
          // is now stale and must not be touched again on this path.
          await fresh.sendUserMessage(seed);
          await fresh.waitForIdle();
          await runLoop(pi, fresh, runName, true);
        },
      });

      if (result.cancelled) {
        appendLog(runName, "session reset was cancelled — ending run");
        // `ctx` is still valid precisely because the replacement did not happen.
        await finishRun(pi, ctx, state, "interrupted", "idle");
      }
      // The recursive call owns the run now. This frame is done either way.
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
