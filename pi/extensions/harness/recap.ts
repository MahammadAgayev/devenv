/**
 * `/harness recap` — what is actually going on, in two sentences.
 *
 * `status` reads state.json and is free, but it cannot answer "what is it
 * doing"; that needs the transcript. Reading a transcript into the live session
 * is the one thing a long-running harness must not do, so this copies
 * `/handoff` (`extensions/task-handoff.ts`): dump the transcript to a temp
 * file, hand the path to a headless subagent, print the one line it returns.
 * The isolation comes from the subagent's own context window.
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

// Same clips as task-handoff.ts: tool results are the bulk of a transcript and
// the least of its meaning; assistant prose is where the decisions live.
const TOOL_RESULT_CLIP = 600;
const TEXT_CLIP = 4000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more chars]`;
}

function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Render the active branch as markdown.
 *
 * `buildContextEntries()` rather than `getEntries()`: it follows the live
 * branch and honours compaction, so the subagent sees what this session
 * actually has in context rather than abandoned branches or pre-compaction
 * history.
 */
function dumpTranscript(ctx: ExtensionCommandContext): string {
  const entries = ctx.sessionManager.buildContextEntries();
  const out: string[] = [];

  for (const entry of entries as any[]) {
    const msg = entry?.message;
    if (!msg) continue;

    switch (msg.role) {
      case "user":
        out.push(`## User\n\n${clip(partsToText(msg.content), TEXT_CLIP)}`);
        break;

      case "assistant": {
        const text = msg.content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
        const calls = msg.content
          .filter((p: any) => p.type === "toolCall")
          .map((p: any) => `- \`${p.name}\` ${clip(JSON.stringify(p.arguments ?? {}), 300)}`);
        const body = [text && clip(text, TEXT_CLIP), calls.length ? `Tool calls:\n${calls.join("\n")}` : ""]
          .filter(Boolean)
          .join("\n\n");
        if (body) out.push(`## Assistant\n\n${body}`);
        break;
      }

      case "toolResult":
        out.push(
          `## Tool result (${msg.toolName}${msg.isError ? ", ERROR" : ""})\n\n` +
            clip(partsToText(msg.content), TOOL_RESULT_CLIP),
        );
        break;

      case "bashExecution":
        out.push(
          `## Shell\n\n\`${msg.command}\` → exit ${msg.exitCode}\n\n${clip(msg.output ?? "", TOOL_RESULT_CLIP)}`,
        );
        break;

      case "compactionSummary":
        out.push(`## [earlier context, compacted]\n\n${msg.summary}`);
        break;

      case "branchSummary":
        out.push(`## [abandoned branch, summarized]\n\n${msg.summary}`);
        break;
    }
  }

  return out.join("\n\n---\n\n");
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

  const transcript = dumpTranscript(ctx);
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
