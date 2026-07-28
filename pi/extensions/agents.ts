/**
 * agents.ts — background, watchable, steerable sub-agents.
 *
 * The registry's /<agent> tools BLOCK the turn (they're tools; the model awaits
 * them). This extension adds the human-driven counterpart: fire agents in the
 * background, keep working, watch them in a live widget, inspect/steer/cancel
 * them via /agents, and have results delivered without interrupting you.
 *
 * Transport is a persistent `pi --mode rpc` child per job (see rpc-agent.ts),
 * so jobs are truly concurrent and can be steered mid-run.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AgentBrief, discover, findAgentCapability, formatBrief } from "./lib/agents/capabilities.ts";
import { type Job, JobManager } from "./lib/agents/job-manager.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./lib/agents/spinner.ts";

const WIDGET_KEY = "agents";
const RESULT_TYPE = "agents-result";

function fmtElapsed(job: Job): string {
  const end = job.endedAt ?? Date.now();
  const s = Math.floor((end - job.startedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function statusIcon(job: Job, frame: string): string {
  switch (job.status) {
    case "running":
      return frame;
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
  }
}

export default function (pi: ExtensionAPI) {
  let manager: JobManager | null = null;
  let widgetTimer: ReturnType<typeof setInterval> | null = null;
  let uiCtx: any = null;

  // Background results are delivered as custom messages (see deliverResult).
  pi.registerMessageRenderer(RESULT_TYPE, (message: any, _options: any, theme: any) => {
    return new Text(theme.fg("success", "✓ ") + String(message.content ?? ""), 0, 0);
  });

  function spinnerFrame(): string {
    return SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
  }

  function renderWidget(): void {
    if (!manager || !uiCtx?.hasUI) return;
    try {
      const jobs = manager.list();
      if (jobs.length === 0) {
        uiCtx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      const frame = spinnerFrame();
      const lines = jobs.slice(0, 8).map((job) => {
        const icon = statusIcon(job, frame);
        const tail = job.status === "running" && job.lastTool ? ` → ${job.lastTool}` : "";
        return `${icon} ${job.id} ${job.label} (${fmtElapsed(job)})${tail}  ${job.title}`;
      });
      lines.unshift(`agents — ${manager.activeCount()} running  ·  /agents to inspect`);
      uiCtx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    } catch {
      // Captured ctx can go stale across session replacement; ignore.
    }
  }

  function ensureWidgetTimer(): void {
    if (widgetTimer || !manager) return;
    // Self-driven redraw so running spinners animate independent of job events.
    // Stops itself once no jobs are active, to avoid a forever-ticking interval.
    widgetTimer = setInterval(() => {
      if (!manager || manager.activeCount() === 0) {
        if (widgetTimer) clearInterval(widgetTimer);
        widgetTimer = null;
        renderWidget();
        return;
      }
      renderWidget();
    }, SPINNER_INTERVAL_MS);
  }

  function ensureManager(ctx: any): JobManager {
    uiCtx = ctx;
    if (manager) return manager;
    manager = new JobManager(
      ctx.cwd ?? process.cwd(),
      () => renderWidget(),
      (job) => deliverResult(job),
    );
    return manager;
  }

  // Inject text as a user message. If the MAIN agent is mid-turn, sendUserMessage
  // would throw "Agent is already processing" unless we pick a streaming behavior;
  // queue it as a follow-up so injecting mid-turn never crashes.
  function injectUser(ctx: any, text: string): void {
    const opts = ctx.isIdle?.() === false ? { deliverAs: "followUp" as const } : undefined;
    pi.sendUserMessage(text, opts);
  }

  function deliverResult(job: Job): void {
    const summary =
      `Background agent finished — ${job.label} (${job.id}, ${fmtElapsed(job)}):\n\n` +
      `Task: ${job.title}\n\n${job.finalText || "(no output)"}`;
    // nextTurn: never interrupts; surfaces the next time you send a message.
    pi.sendMessage({ customType: RESULT_TYPE, content: summary, display: true }, { deliverAs: "nextTurn" });
    if (uiCtx?.hasUI) uiCtx.ui.notify(`✓ ${job.label} (${job.id}) finished — result queued`, "info");
    renderWidget();
  }

  // ── /agent <name> <brief> — fire a background job, return instantly ──────
  pi.registerCommand("agent", {
    description: "Run a registry agent in the background (non-blocking): /agent <name> <question>",
    getArgumentCompletions: (prefix: string) => {
      // Only complete the first token (the agent name); once a space is typed,
      // the user is writing the question, so stop suggesting.
      if (prefix.includes(" ")) return null;
      const items = discover()
        .filter((c) => c.agent)
        .map((c) => ({ value: c.agent!, label: c.agent!, description: `background ${c.name} agent` }))
        .filter((i) => i.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: any) => {
      const text = (args ?? "").trim();
      const sp = text.indexOf(" ");
      if (sp < 0) {
        ctx.ui?.notify("Usage: /agent <name> <question>", "warning");
        return;
      }
      const capName = text.slice(0, sp).trim();
      const question = text.slice(sp + 1).trim();
      const cap = findAgentCapability(capName);
      if (!cap || !cap.agent) {
        ctx.ui?.notify(`Unknown agent "${capName}". Try one from pi/registry/.`, "error");
        return;
      }
      const mgr = ensureManager(ctx);
      const brief: AgentBrief = { goal: question, task: question };
      const job = mgr.start({
        cap: cap.name,
        label: cap.agent,
        title: question.length > 60 ? `${question.slice(0, 60)}…` : question,
        systemPrompt: cap.body,
        model: cap.model,
        tools: cap.tools,
        prompt: formatBrief(brief),
      });
      ensureWidgetTimer();
      ctx.ui?.notify(`▶ ${cap.agent} started in background (${job.id}). Keep working; /agents to watch.`, "info");
    },
  });

  // ── /agents — inspect, steer, cancel background jobs ──────────────────────
  pi.registerCommand("agents", {
    description: "Inspect background agent jobs: view output, steer, cancel, or tidy",
    handler: async (args: string, ctx: any) => {
      const mgr = ensureManager(ctx);
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "cancel-all") {
        const n = mgr.cancelAll();
        ctx.ui?.notify(`Cancelled ${n} job${n === 1 ? "" : "s"}.`, "info");
        renderWidget();
        return;
      }
      if (sub === "tidy") {
        const n = mgr.tidy();
        ctx.ui?.notify(`Cleared ${n} finished job${n === 1 ? "" : "s"}.`, "info");
        renderWidget();
        return;
      }
      const jobs = mgr.list();
      if (jobs.length === 0) {
        ctx.ui?.notify("No background agents. Start one with /agent <name> <question>.", "info");
        return;
      }
      if (!ctx.hasUI) return;
      const frame = spinnerFrame();
      const INJECT_ALL = "↓ Inject all results into chat";
      const finished = jobs.filter((j) => j.finalText);
      const jobLabels = jobs.map(
        (j) => `${statusIcon(j, frame)} ${j.id} ${j.label} (${fmtElapsed(j)}) — ${j.title}`,
      );
      const labels = finished.length ? [INJECT_ALL, ...jobLabels] : jobLabels;
      const pick = await ctx.ui.select("Background agents", labels);
      if (!pick) return;
      if (pick === INJECT_ALL) {
        const combined = finished
          .map((j) => `## ${j.label} (${j.id}) — ${j.title}\n\n${j.finalText}`)
          .join("\n\n---\n\n");
        injectUser(ctx, `Results from ${finished.length} background agent(s):\n\n${combined}`);
        ctx.ui.notify(`Injected ${finished.length} result(s).`, "info");
        return;
      }
      // Match by index against the exact labels passed to select(): fmtElapsed
      // for running jobs drifts with the clock, so a rebuilt string won't match.
      const job = jobs[jobLabels.indexOf(pick)];
      if (!job) return;
      await jobActions(ctx, mgr, job);
    },
  });

  async function jobActions(ctx: any, mgr: JobManager, job: Job): Promise<void> {
    const actions =
      job.status === "running" || job.status === "done"
        ? ["View output", "Inject result into chat", "Ask / steer", "Cancel"]
        : ["View output", "Inject result into chat"];
    const action = await ctx.ui.select(`${job.label} (${job.id}) — ${job.status}`, actions);
    if (!action) return;
    switch (action) {
      case "View output": {
        const transcript = job.items
          .map((it) => (it.type === "tool" ? `  → ${it.text}` : it.text))
          .join("\n\n");
        ctx.ui.notify(transcript || job.finalText || "(no output yet)", "info");
        break;
      }
      case "Inject result into chat":
        injectUser(
          ctx,
          `From background agent ${job.label} (${job.id}) — ${job.title}:\n\n${job.finalText || "(no output yet)"}`,
        );
        break;
      case "Ask / steer": {
        const msg = await ctx.ui.input(`Message to ${job.label}`, "Ask a follow-up or steer…");
        if (msg?.trim()) {
          if (mgr.ask(job.id, msg.trim())) {
            ctx.ui.notify(`Sent to ${job.label} (${job.id}).`, "info");
            ensureWidgetTimer();
            renderWidget();
          } else {
            ctx.ui.notify("Job is not accepting messages.", "warning");
          }
        }
        break;
      }
      case "Cancel":
        mgr.cancel(job.id);
        ctx.ui.notify(`Cancelled ${job.id}.`, "info");
        renderWidget();
        break;
    }
  }

  pi.on("session_shutdown", () => {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
    manager?.disposeAll();
    manager = null;
  });
}
