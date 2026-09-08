/**
 * task-handoff.ts — /handoff + /takeover
 *
 * Handoff docs live at `~/.pi/tasks/<name>.md` (Task / Goal / Summary / Log) and
 * exist so a future session can resume work without the session that produced it.
 *
 *   /handoff [name]   Dump this session's transcript and hand it to the `handoff`
 *                     subagent, which writes the doc. Runs out-of-band: no message
 *                     enters this conversation, so it is safe to fire mid-turn and
 *                     costs the main context almost nothing.
 *   /takeover [name]  Load a doc into context as background reading. With no
 *                     argument it picks the best match for the current
 *                     repo/branch/cwd. Loads only — it does not start work.
 *
 * Why a subagent for /handoff: writing the doc means re-reading the whole session
 * and re-emitting several KB of prose. Done inline that lands in this context
 * window twice over. The subagent gets the transcript as a file and returns one line.
 */

import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runAgentHeadless } from "./agents/index.ts";
import { renderTranscript } from "./lib/transcript.ts";

// Tasks live under the global agent config dir (~/.pi/tasks), not per-repo, so
// handoffs survive across repos and never land inside a git working tree.
function tasksDir(): string {
  return join(homedir(), CONFIG_DIR_NAME, "tasks");
}

// Keep names filesystem-safe and predictable for autocompletion.
function sanitize(name: string): string {
  return name
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function listTasks(): string[] {
  const dir = tasksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort();
}

function completions(prefix: string): AutocompleteItem[] | null {
  const items = listTasks()
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ value: name, label: name, description: "existing task" }));
  return items.length > 0 ? items : null;
}

/** Read-only git facts, or undefined outside a repo. */
function gitInfo(cwd: string): { branch?: string; repo?: string } {
  const run = (...args: string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };
  const root = run("rev-parse", "--show-toplevel");
  return {
    branch: run("rev-parse", "--abbrev-ref", "HEAD"),
    repo: root ? basename(root) : undefined,
  };
}

/**
 * Score a task doc against the current environment.
 *
 * A doc that names a *feature* branch is a strong signal; the repo is a decent
 * one; cwd weaker still (many docs mention a path in passing). Ties break by
 * mtime, since the doc touched last is usually the thread being continued.
 *
 * Trunk branch names are ignored outright: scoring on `main` matched every doc
 * containing the word, which picked the wrong task in testing.
 */
const TRUNK_BRANCHES = new Set(["main", "master", "trunk", "develop", "HEAD"]);

function rankTasks(cwd: string, git: { branch?: string; repo?: string }): { name: string; score: number }[] {
  return listTasks()
    .map((name) => {
      const file = join(tasksDir(), `${name}.md`);
      let text: string;
      let mtime = 0;
      try {
        text = readFileSync(file, "utf-8").toLowerCase();
        mtime = statSync(file).mtimeMs;
      } catch {
        return { name, score: 0, mtime: 0 };
      }
      let score = 0;
      if (git.branch && !TRUNK_BRANCHES.has(git.branch) && text.includes(git.branch.toLowerCase())) score += 5;
      if (git.repo && text.includes(git.repo.toLowerCase())) score += 3;
      if (text.includes(cwd.toLowerCase())) score += 2;
      if (git.repo && name.toLowerCase().includes(git.repo.toLowerCase())) score += 2;
      return { name, score, mtime };
    })
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime)
    .filter((t) => t.score > 0)
    .map(({ name, score }) => ({ name, score }));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Write/update a task handoff doc via the handoff subagent (name optional)",
    getArgumentCompletions: (prefix) => completions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const requested = sanitize(args);
      const dir = tasksDir();
      mkdirSync(dir, { recursive: true });

      // Fired mid-turn, the transcript would stop at the in-flight tool call and
      // the doc would record its outcome as unknown (observed in testing). Let the
      // turn settle first so the summary covers it. This never throws, unlike a
      // bare sendUserMessage during streaming.
      if (!ctx.isIdle()) {
        ctx.ui.notify("Handoff queued — waiting for the current turn to finish…", "info");
        await ctx.waitForIdle();
      }

      const transcript = renderTranscript(ctx.sessionManager);
      if (!transcript.trim()) {
        ctx.ui.notify("Nothing to hand off — this session is empty", "error");
        return;
      }

      const transcriptPath = join(tmpdir(), `pi-handoff-${Date.now()}.md`);
      writeFileSync(transcriptPath, transcript, { encoding: "utf-8", mode: 0o600 });

      const git = gitInfo(ctx.cwd);
      const now = new Date().toISOString().slice(0, 16).replace("T", " ");

      const task = [
        `Write the handoff doc for the session transcribed at: ${transcriptPath}`,
        "",
        `Tasks directory: ${dir}`,
        `Existing tasks: ${listTasks().join(", ") || "(none)"}`,
        `Working directory: ${ctx.cwd}`,
        `Git repo: ${git.repo ?? "(not a repo)"}`,
        `Git branch: ${git.branch ?? "(none)"}`,
        `Timestamp for the log entry: ${now}`,
        "",
        requested
          ? `The user explicitly named this task "${requested}" — use that name.`
          : "The user did not name the task. Choose the name yourself per your instructions.",
        "",
        "Read the transcript, then create or update the doc.",
      ].join("\n");

      ctx.ui.notify("Handoff agent writing task doc…", "info");

      const result = await runAgentHeadless({
        cwd: ctx.cwd,
        agent: "handoff",
        task,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      });

      // A non-zero exit is the subagent reporting failure, not an exception, so
      // it has to be surfaced explicitly. Anything that actually throws is left
      // to propagate.
      if (result.exitCode !== 0) {
        ctx.ui.notify(`Handoff failed: ${result.stderr.slice(0, 300) || "unknown error"}`, "error");
        return;
      }
      ctx.ui.notify(result.output.trim() || "Handoff written", "info");
    },
  });

  pi.registerCommand("takeover", {
    description: "Load a task handoff doc into context as background reading (auto-detects if unnamed)",
    getArgumentCompletions: (prefix) => completions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const requested = sanitize(args);
      let name = requested;

      if (!name) {
        const git = gitInfo(ctx.cwd);
        const ranked = rankTasks(ctx.cwd, git);
        if (ranked.length === 0) {
          const all = listTasks();
          ctx.ui.notify(
            all.length
              ? `No task matches this directory. Name one explicitly: ${all.join(", ")}`
              : "No task docs yet. Use /handoff to create one.",
            "error",
          );
          return;
        }
        name = ranked[0].name;
      }

      const path = join(tasksDir(), `${name}.md`);
      if (!existsSync(path)) {
        const all = listTasks();
        ctx.ui.notify(
          `No handoff doc for "${name}".` + (all.length ? ` Available: ${all.join(", ")}` : " No tasks yet."),
          "error",
        );
        return;
      }

      const doc = readFileSync(path, "utf-8");
      const content = [
        `Handoff doc for task "${name}" (${path}), loaded as background context.`,
        "It describes work already in progress. Do not act on it yet — wait for the",
        "user's instruction, then use it to orient. When work does start, open the",
        "files it references and confirm the current state before trusting it.",
        "",
        "```markdown",
        doc,
        "```",
      ].join("\n");

      ctx.ui.notify(`Loaded task: ${name}${requested ? "" : " (auto-detected)"}`, "info");
      // A custom message, not a user message: takeover loads context, it does not
      // ask for anything. `nextTurn` rides along with whatever the user types next
      // and never triggers a turn on its own, so this is also safe mid-stream.
      await pi.sendMessage(
        { customType: "task-handoff", content, display: false },
        { deliverAs: "nextTurn" },
      );
    },
  });
}
