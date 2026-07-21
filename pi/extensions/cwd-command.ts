// @desc: /cd slash command — change pi's session working directory at runtime.
// Supports git worktrees, relative paths, ~ expansion, and path completion.
// After changing cwd, triggers ctx.reload() so built-in tools (bash, read,
// edit, write, find, grep) are recreated with the new cwd.
import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Expand a path: resolve ~/, relative paths, and absolute paths.
 * Returns the resolved absolute path, or null if it doesn't exist.
 */
function expandPath(p: string, baseCwd: string): string | null {
  const home = process.env.HOME || homedir();
  let resolved: string;
  if (p === "~") {
    resolved = home;
  } else if (p.startsWith("~/")) {
    resolved = join(home, p.slice(2));
  } else if (isAbsolute(p)) {
    resolved = p;
  } else {
    resolved = resolve(baseCwd, p);
  }
  if (!existsSync(resolved)) return null;
  const stat = statSync(resolved);
  if (!stat.isDirectory()) return null;
  return resolved;
}

/**
 * List git worktrees for the current repo, returning { path, branch } pairs.
 * Used for path completion suggestions.
 */
function listWorktrees(cwd: string): Array<{ path: string; branch: string }> {
  try {
    const { execSync } = require("node:child_process");
    const output = execSync("git worktree list --porcelain", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    });
    const worktrees: Array<{ path: string; branch: string }> = [];
    let currentPath = "";
    let currentBranch = "";
    for (const line of output.trim().split("\n")) {
      if (line.startsWith("worktree ")) {
        if (currentPath) {
          worktrees.push({ path: currentPath, branch: currentBranch });
        }
        currentPath = line.slice("worktree ".length);
        currentBranch = "";
      } else if (line.startsWith("branch ")) {
        currentBranch = line.slice("branch ".length).replace("refs/heads/", "");
      }
    }
    if (currentPath) {
      worktrees.push({ path: currentPath, branch: currentBranch });
    }
    return worktrees;
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cd", {
    description: "Change the session working directory. Supports relative paths, ~ expansion, and git worktree paths. Usage: /cd <path>",
    getArgumentCompletions: (prefix: string) => {
      // Suggest git worktrees when the prefix is empty or starts with a path
      const worktrees = listWorktrees(process.cwd());
      const items = worktrees.map(wt => ({
        label: wt.branch ? `${wt.path}  (${wt.branch})` : wt.path,
        value: wt.path,
      }));
      if (!prefix) return items;
      return items.filter(item =>
        item.value.includes(prefix) || item.label.toLowerCase().includes(prefix.toLowerCase()),
      );
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const target = args.trim();

      if (!target) {
        // No arg — show current cwd and available worktrees
        const worktrees = listWorktrees(ctx.cwd);
        const lines = [`Current cwd: ${ctx.cwd}`];
        if (worktrees.length > 0) {
          lines.push("", "Git worktrees:");
          for (const wt of worktrees) {
            const marker = wt.path === ctx.cwd ? " ← current" : "";
            lines.push(`  ${wt.branch ?? "(detached)"}\t${wt.path}${marker}`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const resolved = expandPath(target, ctx.cwd);
      if (!resolved) {
        ctx.ui.notify(`cd: no such directory: ${target}`, "error");
        return;
      }

      if (resolved === ctx.cwd) {
        ctx.ui.notify(`Already in ${resolved}`, "info");
        return;
      }

      // Change the process cwd — this affects process.cwd() calls in the
      // devflow gate, session-context, and other extensions that use it.
      process.chdir(resolved);

      // Reload extensions so built-in tools (bash, read, edit, find, grep)
      // are recreated with the new cwd. Without this, tools would still
      // operate in the old directory.
      ctx.ui.notify(`Changed cwd to ${resolved} — reloading…`, "info");
      await ctx.reload();
    },
  });
}
