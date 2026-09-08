/**
 * Plan Mode
 *
 * Read-only exploration and design. While active, tools that mutate the
 * filesystem are disabled and bash is limited to an allowlist, so the agent can
 * investigate freely but cannot change anything.
 *
 * The point is the conversation before the plan: the agent asks about decisions
 * one at a time through a `plan_question` tool that renders a real options UI,
 * and looks up facts itself instead of asking. When the plan is ready you choose
 * whether to build it.
 *
 * `plan_question` is adapted from pi's own `examples/extensions/question.ts`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isSafeCommand } from "./utils.ts";

const QUESTION_TOOL = "plan_question";

/**
 * Emitted by the model when the plan is finished.
 *
 * Without it the "build it?" prompt fires after every turn, including ones that
 * were only exploring — so the model, not the turn boundary, decides when the
 * plan is done.
 */
const PLAN_READY_MARKER = "[PLAN READY]";

/** Tools plan mode guarantees are available while it is on. */
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", QUESTION_TOOL];

/**
 * Tools disabled while planning.
 *
 * `replace` / `undo_last_replace` come from pi-hashline-edit-pro and mutate
 * files just as much as `write` does — omitting them left plan mode read-only
 * in name only.
 */
const PLAN_MODE_DISABLED_TOOLS = new Set(["edit", "write", "replace", "undo_last_replace"]);

interface PlanModeState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short label for the option" }),
	description: Type.Optional(Type.String({ description: "One line on what this choice implies" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The single decision to put to the user" }),
	options: Type.Array(OptionSchema, {
		description: "Two or more concrete choices. Include your recommendation first.",
	}),
});

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let toolsBeforePlanMode: string[] | undefined;
	/** Set when the model emits the ready marker; consumed by the agent_end menu. */
	let planReady = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("plan-mode", planModeEnabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		const planTools = [
			...toolsBeforePlanMode.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		];
		pi.setActiveTools([...new Set(planTools)]);
	}

	function restoreNormalModeTools(): void {
		if (toolsBeforePlanMode) {
			pi.setActiveTools(toolsBeforePlanMode);
		} else {
			// No snapshot (e.g. plan mode came from --plan before any turn): just
			// drop the question tool, which is meaningless outside plan mode.
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== QUESTION_TOOL));
		}
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", { enabled: planModeEnabled, toolsBeforePlanMode });
	}

	function setPlanMode(ctx: ExtensionContext, on: boolean): void {
		planModeEnabled = on;
		planReady = false;
		if (on) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode on — read-only. I'll ask about decisions as they come up.", "info");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode off — full access restored.", "info");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration and design)",
		handler: async (_args, ctx) => setPlanMode(ctx, !planModeEnabled),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => setPlanMode(ctx, !planModeEnabled),
	});

	// ── The question tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: QUESTION_TOOL,
		label: "Question",
		description: [
			"Put ONE decision to the user and wait for their answer.",
			"Use for choices only they can make — priorities, tradeoffs, scope, preferences.",
			"Do not use for facts you can look up yourself; read the code instead.",
			"Ask one question per call and wait for the answer before asking the next.",
		].join(" "),
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const simpleOptions = params.options.map((o) => o.label);
			const fail = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
			});

			if (ctx.mode !== "tui") return fail("Error: no interactive UI available");
			if (params.options.length === 0) return fail("Error: no options provided");

			const allOptions = [
				...params.options.map((o) => ({ ...o, isOther: false })),
				{ label: "Something else…", description: undefined, isOther: true },
			];

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cached: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					const refresh = () => {
						cached = undefined;
						tui.requestRender();
					};

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
						} else {
							// Empty submit means "never mind" — fall back to the list
							// rather than answering with nothing.
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}
						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							const selected = allOptions[optionIndex];
							if (selected.isOther) {
								editMode = true;
								refresh();
							} else {
								done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
							}
							return;
						}
						if (matchesKey(data, Key.escape)) done(null);
					}

					function render(width: number): string[] {
						if (cached) return cached;
						const lines: string[] = [];
						const w = Math.max(1, width);

						const addWrapped = (prefix: string, text: string) => {
							const pw = visibleWidth(prefix);
							if (pw >= w) {
								lines.push(...wrapTextWithAnsi(prefix + text, w));
								return;
							}
							const wrapped = wrapTextWithAnsi(text, w - pw);
							const cont = " ".repeat(pw);
							wrapped.forEach((l, i) => lines.push(`${i === 0 ? prefix : cont}${l}`));
						};

						lines.push(theme.fg("accent", "─".repeat(w)));
						addWrapped(" ", theme.fg("text", params.question));
						lines.push("");

						allOptions.forEach((opt, i) => {
							const selected = i === optionIndex;
							const prefix = selected ? theme.fg("accent", "❯ ") : "  ";
							const label = `${i + 1}. ${opt.label}${opt.isOther && editMode ? " ✎" : ""}`;
							addWrapped(prefix, theme.fg(selected || (opt.isOther && editMode) ? "accent" : "text", label));
							if (opt.description) addWrapped("     ", theme.fg("muted", opt.description));
						});

						if (editMode) {
							lines.push("");
							addWrapped(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
						}

						lines.push("");
						addWrapped(
							" ",
							theme.fg(
								"dim",
								editMode ? "Enter to submit • Esc to go back" : "↑↓ navigate • Enter to select • Esc to cancel",
							),
						);
						lines.push(theme.fg("accent", "─".repeat(w)));

						cached = lines;
						return lines;
					}

					return { render, invalidate: () => { cached = undefined; }, handleInput };
				},
			);

			if (!result) {
				return {
					content: [{ type: "text", text: "User dismissed the question. Ask again only if you truly cannot proceed." }],
					details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: result.wasCustom ? `User wrote: ${result.answer}` : `User chose: ${result.answer}`,
					},
				],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: result.wasCustom,
				} as QuestionDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				text += `\n${theme.fg("dim", `  ${opts.map((o: { label: string }, i: number) => `${i + 1}. ${o.label}`).join(" · ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as QuestionDetails | undefined;
			if (!d) return new Text("", 0, 0);
			if (d.answer === null) return new Text(theme.fg("warning", "dismissed"), 0, 0);
			const tag = d.wasCustom ? theme.fg("muted", "(wrote) ") : "";
			return new Text(theme.fg("success", "✓ ") + tag + theme.fg("accent", d.answer), 0, 0);
		},
	});

	// ── Enforcement ──────────────────────────────────────────────────────────

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		// Belt and braces: the tool is already inactive, but a model working from
		// a stale tool list can still try, and the error message is clearer here.
		if (PLAN_MODE_DISABLED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode is on — \`${event.toolName}\` is disabled. Describe the change in the plan instead, or ask the user to run /plan.`,
			};
		}

		if (event.toolName !== "bash") return;
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: \`${command}\` is not on the read-only allowlist. Use a read-only command, or ask the user to run /plan.`,
			};
		}
	});

	// Drop stale plan-mode instructions from context once plan mode is off, so a
	// resumed session doesn't keep acting on rules that no longer apply.
	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return {
			messages: event.messages.filter((m) => (m as { customType?: string }).customType !== "plan-mode-context"),
		};
	});

	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;
		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE]

You are planning, not building. File-mutating tools are disabled and bash is
restricted to read-only commands.

Work in this order:

1. Investigate first. Every question that has an answer in the codebase, the
   filesystem, or command output is yours to answer — go and look. Never ask the
   user something you could have read.

2. Put the decisions to the user with \`${QUESTION_TOOL}\`. Genuine decisions
   only: scope, priorities, tradeoffs, preferences, anything with more than one
   defensible answer. Ask ONE at a time and wait for the answer — it usually
   changes what to ask next. Lead with your recommended option and say briefly
   why. Two to four options is right; a free-form "Something else" is added for you.
   A plan built on guesses is worse than one question too many.

3. Write the plan once the decisions are settled. Number the steps, say what
   each one changes and how it gets verified, and name the files involved. Call
   out anything you are still unsure about rather than papering over it.
   End the message with the line ${PLAN_READY_MARKER} on its own, and nothing
   after it. That line is what offers the user the choice to build; omit it
   while you are still exploring or asking questions.

Do not make changes. Describe them.`,
				display: false,
			},
		};
	});

	// The marker is a signal to this extension, not something to read, so strip it
	// from the finished message before it is displayed or stored.
	//
	// This runs before `agent_end`, so the stripped text is gone by the time the
	// menu would look for it — hence the flag rather than a re-scan.
	pi.on("message_end", async (event) => {
		if (!planModeEnabled || event.message.role !== "assistant") return;
		if (!Array.isArray(event.message.content)) return;
		if (!event.message.content.some((c) => c.type === "text" && c.text.includes(PLAN_READY_MARKER))) return;

		planReady = true;

		return {
			message: {
				...event.message,
				content: event.message.content.map((c) =>
					c.type === "text" ? { ...c, text: c.text.replace(PLAN_READY_MARKER, "").trimEnd() } : c,
				),
			},
		};
	});

	// Offer the exit, but only once the model says the plan is done.
	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI || !planReady) return;
		planReady = false;

		const choice = await ctx.ui.select("Plan mode", [
			"Build it — exit plan mode and start",
			"Keep planning",
			"Exit plan mode, don't build",
		]);

		if (choice?.startsWith("Build it")) {
			setPlanMode(ctx, false);
			await pi.sendUserMessage("Go ahead and implement the plan.", { deliverAs: "followUp" });
		} else if (choice?.startsWith("Exit plan mode")) {
			setPlanMode(ctx, false);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) planModeEnabled = true;

		const restored = ctx.sessionManager
			.getEntries()
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (restored?.data) {
			planModeEnabled = restored.data.enabled ?? planModeEnabled;
			toolsBeforePlanMode = restored.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		if (planModeEnabled) enablePlanModeTools();
		updateStatus(ctx);
	});
}
