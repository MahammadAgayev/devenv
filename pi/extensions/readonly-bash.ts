/**
 * readonly-bash.ts — a bash tool that only runs read-only / non-destructive
 * commands, gated by the same `isSafeCommand` allowlist used by plan mode.
 *
 * Safe to expose everywhere (main session + spawned registry agents): it is
 * strictly a subset of `bash`. Agents that need shell access should list
 * `readonly_bash` instead of `bash`.
 *
 * TODO(later): refactor plan-mode's bash gating to route through this tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSafeCommand } from "./plan-mode/utils.ts";

// Shell operators that chain/compose commands. isSafeCommand only inspects the
// leading command, so `cat x | python -c "..."` would pass just because it
// starts with `cat`. Split on these and require EVERY segment to be safe.
const SEGMENT_SPLIT = /\|\||&&|[|;&\n]/;
// Command/process substitution runs nested commands the allowlist can't see.
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

/** Fail-closed gate: reject substitution, and require each piped/chained
 * segment to independently pass the read-only allowlist. */
function isSafeCommandLine(command: string): boolean {
  if (SUBSTITUTION.test(command)) return false;
  const segments = command.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every((seg) => isSafeCommand(seg));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "readonly_bash",
    label: "Readonly Bash",
    description:
      "Run a read-only shell command (e.g. git log/diff/show, rg, grep, ls, cat, jq). " +
      "Destructive or state-changing commands are rejected. Use this instead of bash " +
      "when you only need to inspect, not modify.",
    promptSnippet: "Run read-only shell commands (git log/diff, rg, ls, cat…) without risk of mutation",
    promptGuidelines: [
      "Use readonly_bash instead of bash when a command only needs to read/inspect (git log, rg, ls, cat, jq).",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "The read-only shell command to run." }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 30000)." })),
    }),

    async execute(_toolCallId, params, signal) {
      const command = params.command.trim();
      if (!isSafeCommandLine(command)) {
        return {
          content: [
            {
              type: "text",
              text: `Refused: "${command}" is not on the read-only allowlist (it may be destructive or unrecognized). Use the bash tool if a mutating command is truly required.`,
            },
          ],
          details: { refused: true },
          isError: true,
        };
      }

      const result = await pi.exec("bash", ["-c", command], {
        signal,
        timeout: params.timeout ?? 30000,
      });
      const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trimEnd();
      return {
        content: [{ type: "text", text: out || "(no output)" }],
        details: { exitCode: result.code, killed: result.killed },
        isError: result.code !== 0,
      };
    },
  });
}
