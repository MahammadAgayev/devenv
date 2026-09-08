/**
 * Kill switch and steering.
 *
 * Both exist because an unattended run needs to be interruptible by someone who
 * is not watching it and cannot type into the session:
 *
 *   touch ~/.pi/harness/<name>/AGENT_STOP     halt
 *   $EDITOR ~/.pi/harness/<name>/STEER.md     redirect
 *
 * The stop check runs in two places, and the redundancy is deliberate:
 *
 *   1. `loop.ts` checks between iterations — the clean stop.
 *   2. The `tool_call` gate here blocks mid-iteration — the fast stop.
 *
 * Without (2), `touch AGENT_STOP` during a long iteration does nothing until
 * the agent finishes, which can be minutes. Without (1), the run would stop
 * only by having every tool call fail, which is a mess to read afterwards.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stopRequested } from "./state.ts";

/**
 * Which run, if any, this session is currently driving.
 *
 * Module-level rather than closure state in `loop.ts` because the `tool_call`
 * handler is registered once at extension load and must see changes made by a
 * loop that started later. Set to null whenever no run is active, so the gate
 * costs one null check in normal use.
 */
let activeRun: string | null = null;

export function setActiveRun(name: string | null): void {
  activeRun = name;
}

export function getActiveRun(): string | null {
  return activeRun;
}

/**
 * Block every tool call once AGENT_STOP appears.
 *
 * Blocking rather than aborting: `ctx.abort()` from inside a tool-call handler
 * races the agent loop, and the observable result is a half-finished tool call
 * with an unclear error. A block gives the model a sentence it can act on, and
 * it will wind down its turn on its own — at which point the loop's own check
 * ends the run cleanly.
 */
export function registerStopGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async () => {
    if (!activeRun) return;
    if (!stopRequested(activeRun)) return;
    return {
      block: true,
      reason:
        `The harness run "${activeRun}" has been stopped by the user (AGENT_STOP exists).\n` +
        "Stop what you are doing. Do not call any more tools. " +
        "Finish your turn with a one-line summary of where you got to.",
    };
  });
}
