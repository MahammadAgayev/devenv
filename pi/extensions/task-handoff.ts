/**
 * task-handoff.ts — /handoff + /takeover
 *
 * Maintains a single per-task handoff doc under `<repo>/.pi/tasks/<name>.md`
 * with Task / Goal / Summary / Log sections.
 *
 *   /handoff <name>   Update (or create) the handoff doc. The agent regenerates
 *                     the Summary from this session's work and appends a
 *                     timestamped Log entry. Task/Goal are preserved.
 *   /takeover <name>  Load an existing handoff doc into a fresh session so the
 *                     agent can pick up where the last one left off.
 *
 * Task names are auto-discovered from existing `*.md` files in the tasks dir.
 * `/handoff` also accepts a brand-new name (it seeds the template).
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Tasks live under the global agent config dir (~/.pi/tasks), not per-repo, so
// handoffs survive across repos and never land inside a git working tree.
function tasksDir(): string {
  return join(homedir(), CONFIG_DIR_NAME, "tasks");
}

function taskPath(name: string): string {
  return join(tasksDir(), `${sanitize(name)}.md`);
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

function template(name: string): string {
  return `# Task: ${name}

## Goal
<one-paragraph objective — set once, edited rarely>

## Summary
<current state: what's done, what's in flight, key decisions, files touched>

## Log
`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Write/update the handoff doc for a task (~/.pi/tasks/<name>.md)",
    getArgumentCompletions: (prefix) => completions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = sanitize(args);
      if (!name) {
        ctx.ui.notify("Usage: /handoff <taskname>", "error");
        return;
      }

      const dir = tasksDir();
      mkdirSync(dir, { recursive: true });
      const path = taskPath(name);
      const exists = existsSync(path);
      const current = exists ? readFileSync(path, "utf-8") : template(name);
      const now = new Date().toISOString().slice(0, 16).replace("T", " ");

      const prompt = [
        `Update the handoff doc for task "${name}" at ${path}.`,
        "",
        "Rules:",
        `- Keep the "# Task" heading and the "## Goal" section. If Goal is still the placeholder, fill it in from what you know about this task.`,
        `- Regenerate the "## Summary" section to reflect the CURRENT state of the work from this session (what's done, what's in flight, key decisions, files touched). Replace the old summary, don't append to it.`,
        `- Append ONE new bullet to the "## Log" section, prefixed "- ${now} — ", describing what happened this session. Keep older log entries.`,
        `- Write the full updated document back with the write/edit tool. Do not print it in chat.`,
        "",
        exists ? "Current document:" : "The document does not exist yet — create it from this template:",
        "",
        "```markdown",
        current,
        "```",
      ].join("\n");

      ctx.ui.notify(`${exists ? "Updating" : "Creating"} handoff: ${name}`, "info");
      await pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("takeover", {
    description: "Load a task's handoff doc into this session (~/.pi/tasks/<name>.md)",
    getArgumentCompletions: (prefix) => completions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = sanitize(args);
      if (!name) {
        ctx.ui.notify("Usage: /takeover <taskname>", "error");
        return;
      }

      const path = taskPath(name);
      if (!existsSync(path)) {
        const avail = listTasks();
        ctx.ui.notify(
          `No handoff doc for "${name}".` + (avail.length ? ` Available: ${avail.join(", ")}` : " No tasks yet."),
          "error",
        );
        return;
      }

      const doc = readFileSync(path, "utf-8");
      const prompt = [
        `You are taking over task "${name}". Below is its handoff doc (${path}).`,
        "Read the Goal, Summary, and Log. Open any files referenced in the Summary,",
        "confirm the current state, then continue the work from where the Log left off.",
        "",
        "```markdown",
        doc,
        "```",
      ].join("\n");

      ctx.ui.notify(`Taking over: ${name}`, "info");
      await pi.sendUserMessage(prompt);
    },
  });
}
