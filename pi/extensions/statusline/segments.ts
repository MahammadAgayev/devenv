/**
 * Segment builders.
 *
 * Each builder turns live session data into one {@link Segment}. All data comes
 * from stock pi's public extension surface (`ExtensionContext`,
 * `ReadonlyFooterDataProvider`) — no fork APIs — so these stay portable.
 *
 * Returning `undefined` (or empty text) drops the segment from the chain.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { type Glyphs, paletteFor } from "./theme.ts";
import type { Segment } from "./powerline.ts";

/** Every segment this extension knows how to render. */
export type SegmentId =
  | "model"
  | "thinking"
  | "path"
  | "git"
  | "context"
  | "cost"
  | "tokens"
  | "window"
  | "session"
  | "time"
  | "status";

export interface SegmentInput {
  ctx: ExtensionContext;
  theme: Theme;
  glyphs: Glyphs;
  footer: ReadonlyFooterDataProvider | undefined;
  /** Cumulative token/cost totals, recomputed once per render. */
  totals: Totals;
  /** Current thinking level, from `pi.getThinkingLevel()`. */
  thinking: string;
  /** Compact mode drops icons' trailing labels and shortens numbers. */
  compact: boolean;
}

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Sum usage across all assistant messages in the session. */
export function computeTotals(ctx: ExtensionContext): Totals {
  const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    const usage = message.usage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }
  return totals;
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". */
export function formatNumber(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Replace `$HOME` with `~` and optionally shorten to the trailing segments. */
export function shortenPath(cwd: string, maxLength: number): string {
  const home = process.env.HOME;
  let out = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (out.length <= maxLength) return out;
  const parts = out.split("/");
  while (parts.length > 2 && parts.join("/").length > maxLength) parts.shift();
  out = parts.join("/");
  return out.length > maxLength ? `…${out.slice(-(maxLength - 1))}` : out;
}

function icon(glyph: string, label: string, compact: boolean): string {
  if (!glyph) return label;
  return compact ? `${glyph} ${label}` : `${glyph} ${label}`;
}

/**
 * Build one segment by id, or `undefined` when it has nothing to show.
 *
 * Colors are picked from the stock theme so the bar re-themes automatically.
 */
export function buildSegment(id: SegmentId, input: SegmentInput): Segment | undefined {
  const { ctx, theme, glyphs, compact } = input;

  switch (id) {
    case "model": {
      const model = ctx.model;
      if (!model) return undefined;
      const name = compact ? model.id : `${model.id}`;
      return { id, text: icon(glyphs.model, name, compact), palette: paletteFor(theme, "accent", "text") };
    }

    case "thinking": {
      const level = input.thinking;
      if (!level || level === "off") return undefined;
      return { id, text: level, palette: paletteFor(theme, "thinkingHigh", "text") };
    }

    case "path": {
      const p = shortenPath(ctx.cwd, compact ? 24 : 40);
      // `muted`, not `borderMuted`: the latter is tuned for box chrome and is
      // too dark to read as text on the terminal background.
      return { id, text: icon(glyphs.folder, p, compact), palette: paletteFor(theme, "muted", "text") };
    }

    case "git": {
      const branch = input.footer?.getGitBranch();
      if (!branch) return undefined;
      return { id, text: icon(glyphs.branch, branch, compact), palette: paletteFor(theme, "warning", "text") };
    }

    case "context": {
      const usage = ctx.getContextUsage();
      const window = usage?.contextWindow ?? ctx.model?.contextWindow;
      if (!window) return undefined;
      if (!usage || usage.percent === null) {
        return { id, text: icon(glyphs.context, "?", compact), palette: paletteFor(theme, "muted", "text") };
      }
      const pct = Math.round(usage.percent);
      // Color escalates as the window fills: muted -> warning -> error.
      const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "success";
      const text = compact ? `${pct}%` : `${pct}% of ${Math.round(window / 1000)}k`;
      return { id, text: icon(glyphs.context, text, compact), palette: paletteFor(theme, color, "text") };
    }

    case "cost": {
      const cost = input.totals.cost;
      if (!cost) return undefined;
      const text = `${cost.toFixed(compact ? 2 : 3)}`;
      return { id, text: icon(glyphs.cost, text, compact), palette: paletteFor(theme, "success", "text") };
    }

    case "tokens": {
      const { input: tin, output: tout } = input.totals;
      if (!tin && !tout) return undefined;
      const text = compact
        ? `${formatNumber(tin + tout)}`
        : `↑${formatNumber(tin)} ↓${formatNumber(tout)}`;
      return { id, text: icon(glyphs.tokens, text, compact), palette: paletteFor(theme, "muted", "text") };
    }

    case "window": {
      // The model's total context window, e.g. `200k`. Static per model, so it
      // reads as a capacity label rather than a live counter.
      const window = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
      if (!window) return undefined;
      const text = `${Math.round(window / 1000)}k`;
      return { id, text: icon(glyphs.context, text, compact), palette: paletteFor(theme, "muted", "text") };
    }

    case "session": {
      const name = ctx.sessionManager.getSessionName?.();
      if (!name) return undefined;
      return { id, text: name, palette: paletteFor(theme, "borderAccent", "text") };
    }

    case "time": {
      const now = new Date();
      const text = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      return { id, text: icon(glyphs.time, text, compact), palette: paletteFor(theme, "dim", "text") };
    }

    case "status": {
      const statuses = input.footer?.getExtensionStatuses();
      if (!statuses || statuses.size === 0) return undefined;
      const text = [...statuses.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => v)
        .join(" ");
      if (!text.trim()) return undefined;
      return { id, text: text.trim(), palette: paletteFor(theme, "muted", "text") };
    }

    default:
      return undefined;
  }
}
