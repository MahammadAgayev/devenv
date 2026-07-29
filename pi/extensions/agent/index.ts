/**
 * agent — background-native agent delegation.
 *
 * One tool family, background-first. `agent` launches a registry agent in a
 * separate `pi` subprocess and, by default, returns a runId immediately so you
 * are never blocked. Pass `wait: true` when you actually want the answer inline
 * (rendered with live tool calls + Markdown + usage).
 *
 * There is no dedicated parallel/chain mode: parallel is just calling `agent`
 * N times in one turn; chain is `agent` → `agent_wait` → `agent` with the prior
 * output. The primitives compose.
 *
 * Tools:
 *   agent          launch (returns runId; wait:true to block + render inline)
 *   agent_status   status / turns / elapsed for a runId
 *   agent_result   final output (errors if still running)
 *   agent_wait     block until done, streaming inline output
 *   agent_list     list all runs, newest first
 *   agent_kill     cancel a running run
 *
 * Human surface: the `/agent` command (list / result / kill).
 *
 * State is persisted to disk (see runtime.ts) and reconciled after a soft
 * /reload. A live below-editor widget (widget.ts) shows running agents.
 *
 * Agents come from the registry: a pi/registry/*.md file with both `agent:` and
 * `description:` frontmatter.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as path from "node:path";
import { getFinalOutput, renderAgentRun, type UsageStats } from "./render.ts";
import {
	getRunResult,
	getRunStatus,
	killRun,
	launchRun,
	listRuns,
	readRunMessages,
	readStatus,
	type RunStatus,
	waitForRun,
} from "./runtime.ts";
import { registerBgAgentWidget } from "./widget.ts";

type ToolResult = AgentToolResult<Record<string, unknown>> & { isError?: boolean };

interface WaitDetails {
	runId: string;
	status: RunStatus;
	agent: string;
	messages: Message[];
	usage: UsageStats;
}

const DEFAULT_WAIT_MS = 300_000;

function fmtElapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** One line for `agent_list` / `/agent list`: id, status, agent, folder, label. */
function fmtRunLine(r: { runId: string; status: string; agent: string; label: string; cwd: string }): string {
	const folder = r.cwd ? path.basename(r.cwd) : "?";
	return `${r.runId}  ${r.status.padEnd(8)}  ${r.agent}  ${folder}  "${r.label}"`;
}

/** Shared wait+stream+render used by both `agent` (wait:true) and `agent_wait`. */
async function waitAndRender(
	runId: string,
	label: string,
	timeoutMs: number,
	onUpdate: ((partial: ToolResult) => void) | undefined,
): Promise<ToolResult> {
	const snapshot = (status: RunStatus): WaitDetails => {
		const { messages, usage } = readRunMessages(runId);
		return { runId, status, agent: label, messages, usage };
	};

	const final = await waitForRun(runId, timeoutMs, ({ messages, usage }) => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(messages) || "(running…)" }],
			details: { runId, status: "running", agent: label, messages, usage },
		});
	});

	if (final === "running") {
		return {
			content: [{ type: "text", text: `Wait timed out; run "${runId}" is still running in the background.` }],
			details: snapshot("running"),
		};
	}
	const body = getRunResult(runId) ?? "(no output)";
	return {
		content: [{ type: "text", text: `Run "${runId}" completed (${final}):\n\n${body}` }],
		details: snapshot(final),
		isError: final === "failed" || final === "aborted",
	};
}

function renderWait(result: ToolResult, theme: any): Text | ReturnType<typeof renderAgentRun> {
	const d = result.details as WaitDetails | undefined;
	if (!d || !d.messages) {
		const t = result.content[0];
		return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
	}
	return renderAgentRun({ agent: d.agent, status: d.status, messages: d.messages, usage: d.usage }, theme);
}

export default function (pi: ExtensionAPI) {
	registerBgAgentWidget(pi);

	// ── agent ──────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "agent",
		label: "Agent",
		description: [
			"Delegate a task to a registry agent in a separate pi subprocess (isolated context).",
			"Returns a runId immediately so you are not blocked; monitor with agent_status, get",
			"output with agent_result, or block with agent_wait.",
			"There is no dedicated parallel or chain mode — compose the primitives:",
			"PARALLEL: call `agent` multiple times in one turn to fan out, then agent_wait on each runId.",
			"CHAIN: call `agent` with wait:true (or agent then agent_wait) to get run A's output,",
			"then call `agent` again with that output pasted into run B's task; repeat to chain N steps,",
			"stopping early if a step's returned status is not 'done'.",
			"Pass wait:true to block and render the result inline instead of returning a runId.",
		].join(" "),
		promptSnippet: "Delegate to a background agent (returns a runId; wait:true to block)",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (the `agent:` value in a pi/registry/*.md file)" }),
			task: Type.String({ description: "Task to delegate to the agent" }),
			label: Type.Optional(Type.String({ description: "Human-readable label for this run" })),
			wait: Type.Optional(
				Type.Boolean({ description: "Block until the agent finishes and render inline. Default: false." }),
			),
			timeoutMs: Type.Optional(
				Type.Number({ description: "Max wait when wait:true (default 300000)", minimum: 100 }),
			),
		}),
		async execute(_id, params, _signal, onUpdate, ctx): Promise<ToolResult> {
			const agent = params.agent as string;
			const task = params.task as string;
			const label = (params.label as string) || agent;
			const runId = launchRun(agent, task, label, ctx.cwd);
			// launchRun fails synchronously for an unknown agent — surface that as an error.
			if (readStatus(runId) === "failed") {
				return {
					content: [{ type: "text", text: getRunResult(runId) ?? `Failed to launch agent "${agent}".` }],
					details: { runId, agent, label },
					isError: true,
				};
			}
			if (params.wait) {
				return waitAndRender(runId, label, (params.timeoutMs as number) ?? DEFAULT_WAIT_MS, onUpdate);
			}
			return {
				content: [{ type: "text", text: `Background run started.\nrunId: ${runId}\nagent: ${agent}\nlabel: ${label}` }],
				details: { runId, agent, label },
			};
		},
		renderCall(args, theme) {
			const preview = args.task ? args.task.slice(0, 80) + (args.task.length > 80 ? "…" : "") : "…";
			const suffix = args.wait ? theme.fg("muted", " (wait)") : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("agent ")) +
					theme.fg("accent", args.agent ?? "?") +
					suffix +
					"\n  " +
					theme.fg("dim", preview),
				0,
				0,
			);
		},
		renderResult(result, _opts, theme) {
			// Only wait:true carries messages; a plain launch renders its text body.
			return renderWait(result as ToolResult, theme);
		},
	});

	// ── agent_status ─────────────────────────────────────────────────────────
	pi.registerTool({
		name: "agent_status",
		label: "Agent Status",
		description: "Check an agent run's status, approximate turn count, and elapsed time.",
		promptSnippet: "Check an agent run's status (runId → status, turns, elapsed)",
		parameters: Type.Object({
			runId: Type.String({ description: "Run ID returned by agent" }),
		}),
		async execute(_id, params): Promise<ToolResult> {
			const runId = params.runId as string;
			const status = getRunStatus(runId);
			if (!status) {
				return { content: [{ type: "text", text: `Unknown runId: "${runId}"` }], details: {}, isError: true };
			}
			const text = [
				`runId:   ${runId}`,
				`label:   ${status.label}`,
				`status:  ${status.status}`,
				`turns:   ${status.turns}`,
				`elapsed: ${fmtElapsed(status.elapsedMs)}`,
			].join("\n");
			return { content: [{ type: "text", text }], details: { runId, ...status } };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_status ")) + theme.fg("dim", args.runId ?? "?"), 0, 0);
		},
	});

	// ── agent_result ───────────────────────────────────────────────────────────
	pi.registerTool({
		name: "agent_result",
		label: "Agent Result",
		description: "Retrieve the final output of a completed agent run. Errors if the run is still running.",
		promptSnippet: "Get a completed agent run's final output (error if still running)",
		parameters: Type.Object({
			runId: Type.String({ description: "Run ID returned by agent" }),
		}),
		async execute(_id, params): Promise<ToolResult> {
			const runId = params.runId as string;
			const info = getRunStatus(runId);
			if (!info) {
				return { content: [{ type: "text", text: `Unknown runId: "${runId}"` }], details: {}, isError: true };
			}
			const status = info.status;
			if (status === "running") {
				return {
					content: [{ type: "text", text: `Run "${runId}" is still running. Use agent_wait to block, or check later.` }],
					details: { runId, status },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getRunResult(runId) ?? "(no output)" }],
				details: { runId, status },
				isError: status === "failed" || status === "aborted",
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_result ")) + theme.fg("dim", args.runId ?? "?"), 0, 0);
		},
	});

	// ── agent_wait ─────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "agent_wait",
		label: "Agent Wait",
		description: "Block until an agent run completes, streaming output as it arrives. Returns the final status.",
		promptSnippet: "Block until an agent run completes, streaming output (default 5min)",
		parameters: Type.Object({
			runId: Type.String({ description: "Run ID returned by agent" }),
			timeoutMs: Type.Optional(Type.Number({ description: "Max wait in ms (default 300000)", minimum: 100 })),
		}),
		async execute(_id, params, _signal, onUpdate): Promise<ToolResult> {
			const runId = params.runId as string;
			const initial = getRunStatus(runId);
			if (!initial) {
				return { content: [{ type: "text", text: `Unknown runId: "${runId}"` }], details: {}, isError: true };
			}
			if (initial.status !== "running") {
				const { messages, usage } = readRunMessages(runId);
				const body = getRunResult(runId) ?? "(no output)";
				return {
					content: [{ type: "text", text: `Run "${runId}" already completed (${initial.status}):\n\n${body}` }],
					details: { runId, status: initial.status, agent: initial.label, messages, usage },
					isError: initial.status === "failed" || initial.status === "aborted",
				};
			}
			return waitAndRender(runId, initial.label, (params.timeoutMs as number) ?? DEFAULT_WAIT_MS, onUpdate);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_wait ")) + theme.fg("dim", args.runId ?? "?"), 0, 0);
		},
		renderResult(result, _opts, theme) {
			return renderWait(result as ToolResult, theme);
		},
	});

	// ── agent_list ─────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "agent_list",
		label: "Agent List",
		description: "List all agent runs (from disk), newest first.",
		promptSnippet: "List all agent runs, newest first",
		parameters: Type.Object({}),
		async execute(): Promise<ToolResult> {
			const runs = listRuns();
			const text =
				runs.length === 0
					? "No agent runs found."
					: runs.map(fmtRunLine).join("\n");
			return { content: [{ type: "text", text }], details: { runs, total: runs.length } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_list")), 0, 0);
		},
	});

	// ── agent_kill ─────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "agent_kill",
		label: "Agent Kill",
		description: "Cancel a running agent run. No-op if the run already finished.",
		promptSnippet: "Cancel a running agent run",
		parameters: Type.Object({
			runId: Type.String({ description: "Run ID returned by agent" }),
		}),
		async execute(_id, params): Promise<ToolResult> {
			const runId = params.runId as string;
			if (!readStatus(runId)) {
				return { content: [{ type: "text", text: `Unknown runId: "${runId}"` }], details: {}, isError: true };
			}
			const killed = killRun(runId);
			return {
				content: [{ type: "text", text: killed ? `Run "${runId}" cancelled.` : `Run "${runId}" was already finished.` }],
				details: { runId, killed },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_kill ")) + theme.fg("dim", args.runId ?? "?"), 0, 0);
		},
	});

	// ── /agent command (human surface) ───────────────────────────────────────
	pi.registerCommand("agent", {
		description: "Background agents. Subcommands: list (default), result <id>, kill <id>.",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			const firstSpace = trimmed.indexOf(" ");

			// Still typing the subcommand → complete list/result/kill.
			if (firstSpace === -1) {
				const subs = [
					{ value: "list", label: "list", description: "List all agent runs" },
					{ value: "result", label: "result <id>", description: "Show a finished run's output" },
					{ value: "kill", label: "kill <id>", description: "Cancel a running run" },
				];
				return subs.filter((s) => s.value.startsWith(trimmed.toLowerCase()));
			}

			// Subcommand chosen → for result/kill, complete with runIds.
			const sub = trimmed.slice(0, firstSpace).toLowerCase();
			if (sub !== "result" && sub !== "kill") return null;
			const idPrefix = trimmed.slice(firstSpace + 1).trimStart();
			return listRuns()
				.filter((r) => r.runId.startsWith(idPrefix))
				.map((r) => ({
					value: `${sub} ${r.runId}`,
					label: `${r.runId}  ${r.status}`,
					description: `${r.agent} "${r.label}"`,
				}));
		},
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
			const runId = trimmed.slice(sub.length).trim().split(/\s+/)[0];

			switch (sub) {
				case "":
				case "list": {
					const runs = listRuns();
					if (runs.length === 0) {
						ctx.ui.notify("No agent runs.", "info");
						return;
					}
					const lines = runs.map(fmtRunLine);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "result": {
					if (!runId) return ctx.ui.notify("Usage: /agent result <runId>", "warning");
					const status = readStatus(runId);
					if (!status) return ctx.ui.notify(`Unknown runId: ${runId}`, "warning");
					if (status === "running") return ctx.ui.notify(`${runId} is still running.`, "info");
					ctx.ui.notify(`${runId} (${status}):\n${getRunResult(runId) ?? "(no output)"}`, "info");
					return;
				}
				case "kill": {
					if (!runId) return ctx.ui.notify("Usage: /agent kill <runId>", "warning");
					if (!readStatus(runId)) return ctx.ui.notify(`Unknown runId: ${runId}`, "warning");
					const killed = killRun(runId);
					ctx.ui.notify(killed ? `Cancelled ${runId}.` : `${runId} was already finished.`, killed ? "info" : "warning");
					return;
				}
				default:
					ctx.ui.notify(`Unknown /agent subcommand: ${sub}. Try list, result <id>, kill <id>.`, "warning");
			}
		},
	});
}
