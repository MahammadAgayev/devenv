/**
 * `/harness recap` — what is actually going on, in two sentences.
 *
 * `status` reads state.json and is free, but it cannot answer "what is it
 * doing"; that needs the transcript. Reading a transcript into the live session
 * is the one thing a long-running harness must not do, so this takes the same
 * route as `/handoff` (`extensions/task-handoff.ts`): render the transcript to
 * a temp file, hand the path to a headless subagent, print the one line it
 * returns. The isolation comes from the subagent's own context window.
 *
 * The rendering itself is shared with `/handoff` via `lib/transcript.ts` — the
 * two used to hold verbatim copies of it.
 *
 * Note this is deliberately *not* `ctx.fork()`. Forking replaces the live
 * session, which is the opposite of what is wanted — the run must continue
 * undisturbed.
 *
 * The two-sentence cap is enforced in three places, because models do not
 * respect soft length requests: the agent's own system prompt, the dispatch
 * prompt below, and `truncateToSentences` here as the backstop that actually
 * guarantees it.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTranscript } from "../lib/transcript.ts";
import { readState, runDir } from "./state.ts";

/**
 * Load `runAgentHeadless` on demand — see the same helper in `oracle.ts`.
 *
 * Keeps this module importable without a node_modules, so
 * `truncateToSentences` (the thing that actually enforces the two-sentence
 * cap) can be unit-tested.
 */
async function loadRunAgentHeadless() {
  const mod = await import("../agents/index.ts");
  return mod.runAgentHeadless;
}

/**
 * Hard-truncate to at most `max` sentences.
 *
 * The backstop that makes the cap real. Splits on sentence-ending punctuation
 * followed by whitespace; a trailing fragment with no terminator is dropped
 * rather than kept, since a half-sentence reads worse than a missing one.
 *
 * Exported for testing — this is the piece most likely to be wrong.
 */
export function truncateToSentences(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";

  const sentences: string[] = [];
  let start = 0;
  const re = /[.!?]+(?=\s|$)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(collapsed)) !== null) {
    sentences.push(collapsed.slice(start, m.index + m[0].length).trim());
    start = m.index + m[0].length;
    if (sentences.length === max) break;
  }

  // No terminator anywhere: one unpunctuated blurt. Keep it rather than
  // returning nothing, but give it a full stop.
  if (sentences.length === 0) return `${collapsed}.`;

  return sentences.join(" ");
}

export async function recap(ctx: ExtensionCommandContext, name: string): Promise<void> {
  const state = readState(name);
  if (!state) {
    ctx.ui.notify(`harness: no run named "${name}"`, "error");
    return;
  }

  // Fired mid-turn, the transcript stops at the in-flight tool call and the
  // recap describes its outcome as unknown. Same guard as /handoff.
  if (!ctx.isIdle()) {
    ctx.ui.notify("Recap queued — waiting for the current turn to finish…", "info");
    await ctx.waitForIdle();
  }

  const transcript = renderTranscript(ctx.sessionManager);
  if (!transcript.trim()) {
    ctx.ui.notify("Nothing to recap — this session is empty", "error");
    return;
  }

  const transcriptPath = join(tmpdir(), `pi-harness-recap-${Date.now()}.md`);
  writeFileSync(transcriptPath, transcript, { encoding: "utf-8", mode: 0o600 });

  const task = [
    `Recap the harness run "${name}" from the session transcript at: ${transcriptPath}`,
    "",
    `Run folder: ${runDir(name)}`,
    `Iterations completed: ${state.iteration}`,
    `Last verdict: ${state.lastVerdict}`,
    "",
    "Answer exactly two things: what it is working on right now, and what is in its way.",
    "",
    "HARD LIMIT: two sentences. This is a contract, not a preference — anything",
    "beyond the second sentence is discarded before the user sees it.",
    "",
    "Do not list completed work. The user already has that from `/harness status`;",
    "repeating it wastes both sentences.",
  ].join("\n");

  ctx.ui.notify("Reading the run…", "info");

  const runAgentHeadless = await loadRunAgentHeadless();
  const result = await runAgentHeadless({
    cwd: ctx.cwd,
    agent: "recap",
    task,
    // Cheap pinned model from the agent's own frontmatter, not the session
    // model: this runs often and says little.
    thinkingLevel: ctx.thinkingLevel,
  });

  if (result.exitCode !== 0) {
    ctx.ui.notify(`Recap failed: ${result.stderr.slice(0, 300) || "unknown error"}`, "error");
    return;
  }

  const text = truncateToSentences(result.output.trim(), 2);
  ctx.ui.notify(text || "(no recap returned)", "info");
}
