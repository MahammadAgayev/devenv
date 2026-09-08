/**
 * tool-call-guard rules — the pure decision layer.
 *
 * Split from `../tool-call-guard.ts` for two reasons, one of which is a hard
 * requirement:
 *
 * 1. pi loads every top-level `.ts` in `extensions/` as an extension and
 *    rejects any file without a default factory export. A sibling module would
 *    fail to load with "does not export a valid factory function", so shared
 *    code lives in `lib/` — same as `paths.ts` and `tui-shared.ts`.
 *
 * 2. The wiring module imports `isToolCallEventType` from
 *    `@earendil-works/pi-coding-agent`, a peer dependency supplied by the pi
 *    runtime. This repo has no node_modules, so a test reaching these functions
 *    through the wiring module could not resolve it.
 *
 * Nothing here touches pi's API. Every function is a pure predicate over
 * (tool name, arguments, cwd) returning a block-reason string or null, which is
 * what makes them testable at all — see `../test/tool-call-guard.test.ts`.
 */

import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  // `edit` is replaced by pi-hashline-edit-pro's `replace` tool. Only the two
  // hash anchors are guarded: `path` is optional by design (auto-resolved from
  // the anchors as a fallback), and `replacement_lines: []` is the documented
  // way to delete a range — neither may be treated as an empty-arg error.
  replace: ["remove_from", "remove_to"],
  write: ["path", "content"],
  Agent: ["subagent_type", "prompt"],
  // `agent` is deliberately absent: it is multi-modal (single / parallel /
  // chain), so no argument is unconditionally required. See checkAgentArgs.
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

// ── Multi-modal `agent` guard ────────────────────────────────────────────────

/**
 * Validate an `agent` tool call across its three mutually exclusive modes.
 *
 * The flat REQUIRED_ARGS table cannot express this tool: it accepts
 * `{agent, task}` (single) OR `{tasks: [...]}` (parallel) OR `{chain: [...]}`
 * (sequential), so demanding `agent`+`task` unconditionally blocked every
 * parallel and chain call.
 *
 * That was not merely a false positive, it was a trap. Blocked for a "missing"
 * `agent`, the model helpfully adds `agent`+`task` *alongside* `tasks` — at
 * which point the tool itself rejects the call for specifying two modes at
 * once. The two checks disagreed, and the model oscillated between them until
 * it gave up and fell back to one call at a time.
 *
 * So this mirrors the tool's own `modeCount` rule (agents/index.ts:496-510)
 * rather than inventing a second, stricter one. Where the tool already
 * validates, defer to it and stay silent.
 */
export function checkAgentArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return (
      'BLOCKED: tool "agent" called with no arguments. Provide exactly one mode: ' +
      "{agent, task} for single, {tasks: [...]} for parallel, or {chain: [...]} for sequential."
    );
  }

  const tasks = Array.isArray(args.tasks) ? args.tasks : undefined;
  const chain = Array.isArray(args.chain) ? args.chain : undefined;

  // Match the tool exactly: a mode counts as present only when non-empty, and
  // single mode requires BOTH fields.
  const hasTasks = (tasks?.length ?? 0) > 0;
  const hasChain = (chain?.length ?? 0) > 0;
  const hasSingle = Boolean(args.agent && args.task);
  const modeCount = Number(hasTasks) + Number(hasChain) + Number(hasSingle);

  // Ambiguous or absent: let the tool's own error explain it. Duplicating the
  // message here risks the two drifting apart, which is what caused the loop.
  if (modeCount !== 1) return null;

  // Exactly one mode. Check only that mode's entries are substantive.
  const items = hasTasks ? tasks : hasChain ? chain : undefined;
  if (items) {
    const label = hasTasks ? "tasks" : "chain";
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return `BLOCKED: tool "agent" ${label}[${i}] is not an object. Each entry needs {agent, task}.`;
      }
      const entry = item as Record<string, unknown>;
      for (const key of ["agent", "task"] as const) {
        const value = entry[key];
        if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
          return `BLOCKED: tool "agent" ${label}[${i}] is missing a meaningful "${key}".`;
        }
      }
    }
    return null;
  }

  // Single mode: hasSingle already proved both fields are truthy, so only the
  // whitespace-only case remains.
  for (const key of ["agent", "task"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim() === "") {
      return `BLOCKED: tool "agent" argument "${key}" is empty. Provide a meaningful value.`;
    }
  }
  return null;
}
