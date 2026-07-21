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
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// ── Pure decision functions (exported for testing) ───────────────────────────

/**
 * Resolve a tool-supplied path against the workspace cwd, the same way the
 * `read` tool does (absolute paths used as-is, relative paths joined to cwd).
 * Tilde expansion is handled by the tool itself; here we only need the
 * directory-vs-file check, so we mirror `resolveToCwd`'s absolute/relative
 * behavior without the macOS-screenshot variants.
 */
export function resolvePath(filePath: string, cwd: string): string {
  if (!filePath) return cwd;
  if (filePath.startsWith("~")) return resolve(cwd, filePath);
  if (isAbsolute(filePath)) return filePath;
  return resolve(cwd, filePath);
}

/**
 * Decide whether a `read` call targets a directory and should be blocked.
 *
 * Returns a block reason string (suggesting `ls`) when the resolved path
 * exists and is a directory, or null to allow. Fail-open on any stat error
 * (ENOENT, EACCES, etc.) — the read tool's native error is more informative
 * for non-directory failures.
 */
export function checkReadDirectory(rawPath: string, cwd: string): string | null {
  if (!rawPath) return null;
  const resolved = resolvePath(rawPath, cwd);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(resolved);
  } catch {
    return null; // doesn't exist / not accessible — let the read tool report it
  }
  if (st.isDirectory()) {
    return `BLOCKED: "${rawPath}" is a directory, and read only accepts files.\n` +
      `To list a directory, use bash:  ls -la ${rawPath}\n` +
      `To find files inside it, use fffind with a repo-relative path or glob, or ffgrep for content.`;
  }
  return null;
}

/**
 * Normalize an fffind/ffgrep `path` argument for the workspace.
 *
 * - Relative paths are returned unchanged (fff handles them).
 * - Absolute paths INSIDE the workspace are rewritten to repo-relative form
 *   (drop the cwd prefix) so fff's `normalizePathConstraint` accepts them.
 * - Absolute paths OUTSIDE the workspace cannot be searched by fff (its index
 *   is workspace-scoped). Returns a block-reason string directing to a tool
 *   that CAN reach across workspaces.
 * - null/undefined/empty path → null (no constraint, allow).
 *
 * Returns either `{ kind: "rewrite", path }` or `{ kind: "block", reason }`
 * or `null` (allow, no change needed).
 */
export function normalizeFffPath(
  rawPath: string | undefined,
  cwd: string,
): { kind: "rewrite"; path: string } | { kind: "block"; reason: string } | null {
  if (!rawPath || !rawPath.trim()) return null;
  const trimmed = rawPath.trim();

  if (!isAbsolute(trimmed)) return null; // already relative — let fff handle it

  const rel = relative(cwd, trimmed);
  const outside = rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);

  if (outside) {
    return {
      kind: "block",
      reason:
        `BLOCKED: fffind/ffgrep can only search within the current workspace (${cwd}).\n` +
        `The path "${rawPath}" is outside the workspace — fff's frecency index does not cover it.\n` +
        `Use one of these instead:\n` +
        `  • bash:  ls -la ${rawPath}  (listing)  /  grep -rn "pattern" ${rawPath}  (content)\n` +
        `  • mcp__code_mcp__sg_search  (Sourcegraph cross-repo code search)\n` +
        `  • mcp__code_mcp__sg_read_file  (read a single file from another repo)`,
    };
  }

  // Inside the workspace: rewrite to repo-relative. fff expects paths relative
  // to the workspace root; an absolute path works only if it's the cwd itself.
  if (rel === "") {
    // path IS the cwd — drop it (no constraint). fff treats absent path as
    // "whole workspace", which is what the model meant.
    return { kind: "rewrite", path: "" };
  }
  // Preserve a trailing slash so a directory prefix stays a directory prefix
  // (fff's parser distinguishes "src/" from "src").
  const trailingSlash = trimmed.endsWith("/") ? "/" : "";
  return { kind: "rewrite", path: rel + trailingSlash };
}

// ── checkGitPush ─────────────────────────────────────────────────────────────

/**
 * Branches where `git push` is a legitimate operation (infra/release flows),
 * not a PR-publishing flow that should use `arh publish`.
 */
const PUSH_OK_BRANCHES = new Set(["main", "master", "develop", ""]);

/**
 * Detect a `git push` command in a bash command string.
 *
 * Matches `git push` at the start of the command (after optional whitespace),
 * including `git push --force`, `git push origin <branch>`, etc. Does NOT
 * match `git push` inside a quoted string, comment, or echo — only when it's
 * the actual command being executed.
 */
export function isGitPushCommand(command: string): boolean {
  if (!command) return false;
  // Match `git push` at the start of the command or after a `&&` / `;` / `|`
  // separator. This covers the common forms:
  //   git push origin ...
  //   git push --force
  //   cd foo && git push
  //   git add . && git commit && git push
  return /(?:^|&&|;|\|)\s*git\s+push\b/.test(command);
}

/**
 * Decide whether a `git push` command should be blocked in favor of
 * `arh publish`.
 *
 * Returns a block reason string when the command is a `git push` AND the
 * current branch is a feature branch (not main/master/develop), or null to
 * allow. An empty/unknown branch (not in a git repo) allows the call — the
 * git command's own error message is clearer for that case.
 *
 * This is a pure function: the caller supplies the branch name obtained from
 * `git rev-parse --abbrev-ref HEAD` in the extension wiring.
 */
export function checkGitPush(command: string, branch: string): string | null {
  if (!isGitPushCommand(command)) return null;
  if (PUSH_OK_BRANCHES.has(branch)) return null;

  return `BLOCKED: \`git push\` on feature branch \`${branch}\` — use \`arh publish\` instead.\n\n` +
    `\`arh publish\` handles lint, tests, PR creation/update, and stack management\n` +
    `in one command. Raw \`git push\` bypasses all of that and can't create or\n` +
    `update PRs for arc diff / arh publish flows.\n\n` +
    `Instead, run:\n` +
    `  arh publish                   # publish current feature branch\n` +
    `  arh publish --no-interactive  # skip prompts, auto-apply lint fixes\n` +
    `  arh publish --full-stack      # publish entire stack\n\n` +
    `If this is a non-PR push (e.g. force-pushing to a release branch), switch to\n` +
    `the target branch first or use a different command.`;
}

// ── Empty required-argument guard ───────────────────────────────────────────

/**
 * Tools whose required arguments must not be empty/whitespace. Maps tool name
 * to the required argument name(s). A call with a missing or blank required
 * argument is blocked with a concise message; the model can then issue a
 * real call with meaningful arguments.
 */
const REQUIRED_ARGS: Record<string, string[]> = {
  bash: ["command"],
  read: ["path"],
  ffgrep: ["pattern"],
  fffind: ["pattern"],
  edit: ["path", "edits"],
  write: ["path", "content"],
  Agent: ["subagent_type", "prompt"],
  subagent: ["agent", "task"],
  subagent_parallel: ["tasks"],
  subagent_chain: ["chain"],
  bg_agent_run: ["agent", "task"],
  Workflow: ["scriptPath"],
};

/**
 * Check whether a tool call has a required argument that is empty, missing, or
 * all whitespace. Returns a block reason string, or null to allow.
 */
export function checkEmptyRequiredArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  const required = REQUIRED_ARGS[toolName];
  if (!required) return null;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return `BLOCKED: tool "${toolName}" called with no arguments. Required: ${required.join(", ")}.`;
  }
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null) {
      return `BLOCKED: tool "${toolName}" missing required argument "${key}".`;
    }
    if (typeof value === "string" && value.trim() === "") {
      return `BLOCKED: tool "${toolName}" argument "${key}" is empty. Provide a meaningful value.`;
    }
    if (Array.isArray(value) && value.length === 0) {
      return `BLOCKED: tool "${toolName}" argument "${key}" is an empty array. Provide at least one entry.`;
    }
  }
  return null;
}

// ── Extension wiring ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", (event: ToolCallEvent, ctx): ToolCallEventResult | void => {
    const cwd = ctx.cwd;

    // 0. Empty required arguments — block before any tool-specific checks.
    const emptyReason = checkEmptyRequiredArgs(event.toolName, event.input as Record<string, unknown> | undefined);
    if (emptyReason) return { block: true, reason: emptyReason };

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
