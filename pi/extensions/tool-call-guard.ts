// tool-call-guard.ts — Pre-tool guard for common, preventable tool-call errors.
//
// Listens on pi's "tool_call" event and intercepts three high-frequency error
// patterns:
//
//   1. `read` on a directory → EISDIR (78 errors, 3% of all read calls).
//      The `read` tool only accepts files. The model frequently passes a
//      directory path (e.g. an extension or plugin dir) intending to list it.
//      This guard stats the resolved path and blocks with a pointer to
//      `bash ls -la` before the error ever reaches the model.
//
//   2. `fffind` / `ffgrep` with an absolute `path` outside the workspace
//      (49+ errors, ~10% of fffind calls). The fff index is workspace-scoped:
//      `normalizePathConstraint` in @ff-labs/pi-fff/src/query.ts rejects any
//      path that relativizes to `../`. Almost every observed failure is the
//      model passing `/home/user/playground/...` while cwd is a different
//      workspace (e.g. go-code). The guard rewrites in-workspace absolute
//      paths to repo-relative form (so the call succeeds), and blocks
//      out-of-workspace paths with a pointer to `bash`, `sg_search`, or
//      `sg_read_file` which CAN reach across workspaces.
//
//   3. `git push` on a feature branch → should use `arh publish` instead.
//      `arh publish` handles lint, tests, PR creation/update, and stack
//      management in one command. Raw `git push` bypasses all of that and
//      can't create or update PRs for `arc diff`/`arh publish` flows anyway.
//      The guard checks the current git branch and blocks if it's not
//      main/master/develop (legitimate push targets for infra/release ops).
//
// All decisions are pure, exported functions (see test/tool-call-guard.test.ts).
// The extension wiring only translates the decision into a ToolCallEventResult.
//
// Fail-open policy: on any fs error during the directory check (ENOENT,
// permission, broken symlink), the guard allows the call — the `read` tool's
// own error message is clearer for those cases than a pre-flight guess.

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

import {
  checkAgentArgs,
  checkEmptyRequiredArgs,
  checkGitPush,
  checkReadDirectory,
  normalizeFffPath,
} from "./lib/tool-call-guard-rules.ts";

// The rules live in their own module so they can be tested without pi on the
// module graph. Re-exported here so this file stays the single entry point.
export * from "./lib/tool-call-guard-rules.ts";

// ── Extension wiring ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", (event: ToolCallEvent, ctx): ToolCallEventResult | void => {
    const cwd = ctx.cwd;

    // 0. Empty required arguments — block before any tool-specific checks.
    const emptyReason = checkEmptyRequiredArgs(event.toolName, event.input as Record<string, unknown> | undefined);
    if (emptyReason) return { block: true, reason: emptyReason };

    // 0b. `agent` is multi-modal, so it needs its own mode-aware check rather
    // than an entry in the flat REQUIRED_ARGS table.
    if (event.toolName === "agent") {
      const reason = checkAgentArgs(event.input as Record<string, unknown> | undefined);
      if (reason) return { block: true, reason };
      return;
    }

    // 1. read on a directory — use isToolCallEventType for typed input narrowing
    if (isToolCallEventType("read", event)) {
      const rawPath = event.input.path;
      if (rawPath) {
        const reason = checkReadDirectory(rawPath, cwd);
        if (reason) return { block: true, reason };
      }
      return;
    }

    // 2. git push on a feature branch — redirect to `arh publish`
    if (isToolCallEventType<"bash", { command?: string }>("bash", event)) {
      const command = event.input.command;
      if (command) {
        let branch = "";
        try {
          branch = execSync("git rev-parse --abbrev-ref HEAD", {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 2000,
          }).trim();
        } catch {
          // Not a git repo or git unavailable — fail open.
        }
        const reason = checkGitPush(command, branch);
        if (reason) return { block: true, reason };
      }
    }

    // 3. fffind / ffgrep with an out-of-workspace or absolutized path
    // These are custom tools (not built-in), so we pass explicit type params
    // per the isToolCallEventType docs for custom tool input narrowing.
    if (isToolCallEventType<"fffind", { path?: string }>("fffind", event) ||
        isToolCallEventType<"ffgrep", { path?: string }>("ffgrep", event)) {
      const rawPath = event.input.path;
      if (!rawPath) return;
      const decision = normalizeFffPath(rawPath, cwd);
      if (!decision) return;
      if (decision.kind === "block") {
        return { block: true, reason: decision.reason };
      }
      // Rewrite in place — mutating event.input patches the args before
      // execution (per pi ExtensionAPI tool_call contract). An empty string
      // signals "no path constraint" to fff, matching `normalizeFffPath`'s
      // treatment of the cwd root.
      if (decision.path === "") {
        delete event.input.path;
      } else {
        event.input.path = decision.path;
      }
    }
  });
}
