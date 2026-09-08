/**
 * harness — unattended long-running agent runs.
 *
 * Lets pi work toward a criterion across many context windows: fresh context
 * per reset, an external oracle deciding done-ness, and durable state on disk
 * so no session carries the project in its head.
 *
 *   /harness init [name]     create a run — asks for the goal and the
 *                            validation command
 *   /harness start [name]    run it. Does not return until the run ends.
 *   /harness status [name]   deterministic, no model, instant
 *   /harness recap [name]    two sentences from a forked context
 *   /harness stop [name]     write AGENT_STOP
 *   /harness list            every run and where it got to
 *
 * A run is a folder: `~/.pi/harness/<name>/`. See `state.ts` for why it lives
 * there rather than in the project.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { getActiveRun, registerStopGate, setActiveRun } from "./control.ts";
import { startRun } from "./loop.ts";
import { recap } from "./recap.ts";
import {
  createRun,
  listRuns,
  readState,
  requestStop,
  runDir,
  runExists,
  runsByRecency,
  sanitize,
  stopPath,
  stopRequested,
  steerPath,
  taskPath,
} from "./state.ts";

/** Sub-commands, for autocompletion and the usage line. */
const SUBCOMMANDS = ["init", "start", "status", "recap", "stop", "list"] as const;

const SUBCOMMAND_HELP: Record<string, string> = {
  init: "create a new run",
  start: "run it until done or stopped",
  status: "iteration, verdict, resets — no model call",
  recap: "two sentences on what is happening",
  stop: "halt the active run",
  list: "all runs",
};

function parseArgs(args: string): { sub: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { sub: "", rest: "" };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { sub: trimmed, rest: "" };
  return { sub: trimmed.slice(0, idx), rest: trimmed.slice(idx + 1).trim() };
}

/**
 * Resolve which run a command applies to.
 *
 * Named run wins; otherwise the active one; otherwise the most recent. The
 * fallback matters more than it looks — every command except `init` and `list`
 * is normally typed with no argument.
 */
function resolveRun(rest: string): string | null {
  const named = sanitize(rest);
  if (named) return named;
  const active = getActiveRun();
  if (active) return active;
  return runsByRecency()[0] ?? null;
}

function completions(prefix: string): AutocompleteItem[] | null {
  const { sub, rest } = parseArgs(prefix);

  // Still typing the sub-command.
  if (!prefix.includes(" ")) {
    const items = SUBCOMMANDS.filter((s) => s.startsWith(sub)).map((value) => ({
      value,
      label: value,
      description: SUBCOMMAND_HELP[value],
    }));
    return items.length > 0 ? items : null;
  }

  if (sub === "init" || sub === "list") return null;

  const items = listRuns()
    .filter((name) => name.startsWith(rest))
    .map((name) => {
      const state = readState(name);
      return {
        value: `${sub} ${name}`,
        label: name,
        description: state ? `${state.status} · iteration ${state.iteration} · ${state.lastVerdict}` : "run",
      };
    });
  return items.length > 0 ? items : null;
}


/** Deterministic one-liner. No LLM call, instant, correct by construction. */
function formatStatus(name: string): string {
  const state = readState(name);
  if (!state) return `harness: no run named "${name}"`;

  const bits = [
    `harness "${name}"`,
    state.status,
    `iteration ${state.iteration}`,
    `last verdict ${state.lastVerdict}`,
  ];
  const resets = Math.max(0, state.sessionChain.length - 1);
  if (resets > 0) bits.push(`${resets} reset${resets === 1 ? "" : "s"}`);
  if (stopRequested(name)) bits.push("AGENT_STOP present");
  if (existsSync(steerPath(name))) bits.push("STEER.md pending");
  return bits.join(" · ");
}

export default function (pi: ExtensionAPI) {
  registerStopGate(pi);

  pi.registerCommand("harness", {
    description: "Long-running unattended agent runs (init|start|status|recap|stop|list)",
    getArgumentCompletions: (prefix) => completions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { sub, rest } = parseArgs(args);

      switch (sub) {
        case "":
        case "help":
          ctx.ui.notify(
            `harness: /harness <${SUBCOMMANDS.join("|")}> [name]\n` +
              Object.entries(SUBCOMMAND_HELP)
                .map(([k, v]) => `  ${k.padEnd(7)} ${v}`)
                .join("\n"),
            "info",
          );
          return;

        case "list": {
          const runs = listRuns();
          if (runs.length === 0) {
            ctx.ui.notify("No harness runs yet. Create one with /harness init", "info");
            return;
          }
          ctx.ui.notify(runs.map(formatStatus).join("\n"), "info");
          return;
        }

        case "init": {
          await initRun(ctx, sanitize(rest));
          return;
        }

        case "status": {
          const name = resolveRun(rest);
          if (!name) {
            ctx.ui.notify("No harness runs yet. Create one with /harness init", "info");
            return;
          }
          ctx.ui.notify(formatStatus(name), "info");
          return;
        }

        case "recap": {
          const name = resolveRun(rest);
          if (!name) {
            ctx.ui.notify("No harness runs yet. Create one with /harness init", "info");
            return;
          }
          await recap(ctx, name);
          return;
        }

        case "stop": {
          const name = resolveRun(rest);
          if (!name || !runExists(name)) {
            ctx.ui.notify(`harness: no run named "${name ?? ""}"`, "error");
            return;
          }
          requestStop(name);
          ctx.ui.notify(
            `harness "${name}": stop requested — it will halt at the next tool call.\n` +
              `Remove ${stopPath(name)} to allow it to run again.`,
            "warning",
          );
          return;
        }

        case "start": {
          const name = resolveRun(rest);
          if (!name || !runExists(name)) {
            ctx.ui.notify(
              rest
                ? `harness: no run named "${sanitize(rest)}". Create it with /harness init ${sanitize(rest)}`
                : "harness: no run to start. Create one with /harness init",
              "error",
            );
            return;
          }

          if (getActiveRun()) {
            ctx.ui.notify(
              `harness: run "${getActiveRun()}" is already going in this session. Stop it first.`,
              "error",
            );
            return;
          }

          const state = readState(name);
          if (!state) {
            ctx.ui.notify(`harness: run "${name}" has no readable state.json`, "error");
            return;
          }

          const proceed = await ctx.ui.confirm(
            `Start harness run "${name}"?`,
            [
              `Working directory: ${state.cwd}`,
              `Validation: ${state.validationCommand}`,
              `Up to ${CONFIG.maxIterations} iterations, resetting context at ${CONFIG.resetThresholdPercent}%.`,
              "",
              "This session will drive the run until it finishes.",
              `Stop it any time with /harness stop, or: touch ${stopPath(name)}`,
            ].join("\n"),
          );
          if (!proceed) return;

          await startRun(ctx, name);
          return;
        }

        default:
          ctx.ui.notify(`harness: unknown subcommand "${sub}". Try /harness help`, "error");
      }
    },
  });

  // A run is bound to the session driving it. If that session goes away, the
  // gate must not keep blocking tool calls in whatever replaces it.
  pi.on("session_shutdown", async () => {
    setActiveRun(null);
  });
}

/**
 * Create a run: ask for the goal and the validation command, write the folder.
 *
 * The validation command is asked for rather than defaulted, deliberately.
 * Only the user knows whether this project is `pytest -x -q`, `bun test`, or
 * `make check`, and a wrong default is worse than a prompt — a harness whose
 * oracle does not measure the right thing will confidently finish having done
 * nothing.
 */
async function initRun(ctx: ExtensionCommandContext, requested: string): Promise<void> {
  const name =
    requested ||
    sanitize((await ctx.ui.input("Name for this run", "e.g. auth-token-refresh")) ?? "");

  if (!name) {
    ctx.ui.notify("harness: a run needs a name", "error");
    return;
  }

  if (runExists(name)) {
    ctx.ui.notify(`harness: run "${name}" already exists at ${runDir(name)}`, "error");
    return;
  }

  const goal = (
    await ctx.ui.input("What should it achieve?", "one line — you can expand task.md afterwards")
  )?.trim();
  if (!goal) {
    ctx.ui.notify("harness: a run needs a goal", "error");
    return;
  }

  const validationCommand = (
    await ctx.ui.input("Command that proves it is done (exit 0 = done)", "e.g. pytest -x -q")
  )?.trim();
  if (!validationCommand) {
    ctx.ui.notify("harness: a run needs a validation command — it is the oracle", "error");
    return;
  }

  const task = [
    `# Task: ${name}`,
    "",
    "## Goal",
    "",
    goal,
    "",
    "## Done when",
    "",
    `\`${validationCommand}\` exits 0, and an independent reviewer agrees the work is`,
    "genuinely complete rather than merely passing.",
    "",
    "## Constraints",
    "",
    "- Stay within the goal above. Do not refactor code it did not ask about.",
    "- Leave the working tree in a state that builds.",
    "",
    "## Notes",
    "",
    "(Add detail here before starting — the more precise this file is, the less the",
    "run drifts. It is re-read at the top of every iteration.)",
    "",
  ].join("\n");

  createRun({ name, cwd: ctx.cwd, validationCommand, task });

  ctx.ui.notify(
    [
      `harness "${name}" created.`,
      "",
      `  task:       ${taskPath(name)}`,
      `  folder:     ${runDir(name)}`,
      `  validation: ${validationCommand}`,
      `  cwd:        ${ctx.cwd}`,
      "",
      "Edit task.md to sharpen the contract, then: /harness start",
    ].join("\n"),
    "info",
  );
}
