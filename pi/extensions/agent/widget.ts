/**
 * agent/widget.ts — live below-editor widget for background agent runs.
 *
 * Polls the run store once a second and paints a compact status line under the
 * editor while any agent is active, so you can keep working and still see
 * progress:
 *
 *   ⏳ scout      0:42
 *   ✓ reviewer   done  (lingers ~10s, then drops off)
 *
 * When nothing is running (and no recent completion is lingering) the widget is
 * cleared entirely. This is the non-blocking counterpart to agent_wait's
 * on-demand full render.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listRuns, reapOldRuns, RETENTION_MS, type RunStatus } from "./runtime.ts";

const WIDGET_KEY = "bg-agents";
const POLL_MS = 1000;
// How long a finished run keeps showing (as ✓/✗) before it drops off the widget.
const LINGER_MS = 10_000;
// Task preview length on the second line.
const TASK_PREVIEW = 56;

function icon(status: RunStatus): string {
	switch (status) {
		case "running":
			return "⏳";
		case "done":
			return "✓";
		default:
			return "✗"; // failed | aborted
	}
}

function fmtClock(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const m = Math.floor(s / 60);
	return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function trunc(s: string, width: number): string {
	return s.length <= width ? s : s.slice(0, width - 1) + "…";
}

export function registerBgAgentWidget(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let shownLastTick = false;

	const stop = (ctx: { ui: { setWidget: (k: string, c: string[] | undefined, o?: any) => void } }) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (shownLastTick) {
			ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
			shownLastTick = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// No TUI in headless / --print / RPC sessions — nothing to paint.
		if (!ctx.hasUI) return;
		// Guard against a second session_start (resume/reload) leaking a timer.
		if (timer) clearInterval(timer);
		reapOldRuns(RETENTION_MS);

		const render = () => {
			const now = Date.now();
			// Two lines per run (A+B): a dense status line, then a dimmed task line.
			//   ⏳ reviewer · devenv · 0:42
			//      ↳ Review the agent-consolidation refactor…
			// Show every running run, plus finished ones that ended within LINGER_MS.
			const rows: string[] = [];
			for (const r of listRuns()) {
				if (r.status !== "running" && now - r.mtimeMs >= LINGER_MS) continue;
				const when = r.status === "running" ? fmtClock(now - r.started) : r.status;
				const folder = r.cwd ? path.basename(r.cwd) : "";
				const head = [r.agent, folder, when].filter(Boolean).join(" · ");
				rows.push(`${icon(r.status)} ${head}`);
				if (r.task) rows.push(`   ↳ ${trunc(r.task, TASK_PREVIEW)}`);
			}

			if (rows.length === 0) {
				if (shownLastTick) {
					ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
					shownLastTick = false;
				}
				return;
			}
			ctx.ui.setWidget(WIDGET_KEY, rows, { placement: "belowEditor" });
			shownLastTick = true;
		};

		timer = setInterval(render, POLL_MS);
		timer.unref?.();
		render();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});
}
