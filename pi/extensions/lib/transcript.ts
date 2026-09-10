/**
 * transcript.ts — render a session's active branch as markdown.
 *
 * `/handoff` (`../task-handoff.ts`) needs a plain-text dump of the conversation,
 * small enough to hand to a headless subagent as a file.
 *
 * Why `lib/`: pi loads every top-level `.ts` under `extensions/` as an extension
 * and rejects files with no default factory export, so shared modules must live
 * one level down — same reason as `paths.ts` and `tool-call-guard-rules.ts`.
 *
 * Nothing here imports pi. The session is taken as the structural
 * `TranscriptSource` below rather than `ExtensionCommandContext`, so this module
 * loads without a node_modules and `renderTranscript` is directly testable
 * against hand-built entries — see `../test/transcript.test.ts`.
 *
 * No default export — library module, not a pi extension.
 */

/** The one method of pi's session manager this module needs. */
export interface TranscriptSource {
  /**
   * Follows the live branch and honours compaction, unlike `getEntries()`, so
   * the dump matches what the session actually has in context rather than
   * including abandoned branches or pre-compaction history.
   */
  buildContextEntries(): unknown[];
}

/**
 * How much of each message survives the dump.
 *
 * Long tool results are the bulk of a transcript and the least of its meaning,
 * so they get clipped hard. Assistant prose is where the decisions live, so it
 * gets an order of magnitude more room.
 */
export const TOOL_RESULT_CLIP = 600;
export const TEXT_CLIP = 4000;
/** Tool arguments are identifying, not interesting; a line's worth is plenty. */
const TOOL_ARGS_CLIP = 300;

/** Truncate with a visible marker, so the reader knows something was dropped. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more chars]`;
}

/** Flatten a content field that may be a bare string or an array of parts. */
export function partsToText(content: unknown): string {
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
 * One message → one markdown section, or null for roles we do not render.
 *
 * Returning null rather than an empty string keeps "nothing to say" distinct
 * from "said nothing", which is what lets the caller join sections with a rule
 * without emitting stray separators.
 */
function renderMessage(msg: any): string | null {
  switch (msg.role) {
    case "user":
      return `## User\n\n${clip(partsToText(msg.content), TEXT_CLIP)}`;

    case "assistant": {
      const text = msg.content
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n");
      const calls = msg.content
        .filter((p: any) => p.type === "toolCall")
        .map((p: any) => `- \`${p.name}\` ${clip(JSON.stringify(p.arguments ?? {}), TOOL_ARGS_CLIP)}`);
      const body = [text && clip(text, TEXT_CLIP), calls.length ? `Tool calls:\n${calls.join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n");
      // A turn that was pure thinking has neither prose nor calls; skip it.
      return body ? `## Assistant\n\n${body}` : null;
    }

    case "toolResult":
      return (
        `## Tool result (${msg.toolName}${msg.isError ? ", ERROR" : ""})\n\n` +
        clip(partsToText(msg.content), TOOL_RESULT_CLIP)
      );

    case "bashExecution":
      return `## Shell\n\n\`${msg.command}\` → exit ${msg.exitCode}\n\n${clip(msg.output ?? "", TOOL_RESULT_CLIP)}`;

    case "compactionSummary":
      return `## [earlier context, compacted]\n\n${msg.summary}`;

    case "branchSummary":
      return `## [abandoned branch, summarized]\n\n${msg.summary}`;

    default:
      return null;
  }
}

/** Render the session's active branch as markdown. Empty string when there is nothing. */
export function renderTranscript(sessionManager: TranscriptSource): string {
  const out: string[] = [];
  for (const entry of sessionManager.buildContextEntries() as any[]) {
    const msg = entry?.message;
    if (!msg) continue;
    const section = renderMessage(msg);
    if (section !== null) out.push(section);
  }
  return out.join("\n\n---\n\n");
}
