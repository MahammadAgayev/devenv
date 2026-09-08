/**
 * Context-usage gauge.
 *
 * Ports Oh My Pi's `statusLine.contextLine`: the connector between the left and
 * right segment groups is not dead space but a live gauge of how full the
 * context window is. Four modes, matching OMP:
 *
 *   off        — solid rule, no feedback
 *   percentage — used portion in accent color, remainder dimmed
 *   annotated  — adds ticks at the compaction boundaries
 *   embedded   — annotated, plus the percentage rendered inside the gauge
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Glyphs, RESET } from "./theme.ts";

export type ContextLineMode = "off" | "percentage" | "annotated" | "embedded";

export interface GaugeInput {
  width: number;
  /** 0-100, or null when unknown (e.g. immediately after compaction). */
  percent: number | null;
  contextWindow: number;
  theme: Theme;
  glyphs: Glyphs;
  mode: ContextLineMode;
  /** Percentage at which auto-compaction fires. */
  compactionThreshold: number;
}

/**
 * Render the gauge fill that bridges the two segment groups.
 *
 * Always returns exactly `width` visible cells so the bar's total width stays
 * stable — the caller has already reserved this space.
 */
export function renderGauge(input: GaugeInput): string {
  const { width, percent, theme, glyphs, mode } = input;
  if (width <= 0) return "";

  const rule = glyphs.horizontal;

  // No data or gauge disabled: plain rule in the border color.
  if (mode === "off" || percent === null) {
    return theme.fg("borderMuted", rule.repeat(width));
  }

  const clamped = Math.max(0, Math.min(100, percent));

  // `embedded` reserves trailing cells for the label, so the bar itself is
  // narrower than the gap. Compute the label first.
  let label = "";
  if (mode === "embedded" && width >= 10) {
    label = ` ${Math.round(clamped)}% `;
  }
  const barWidth = Math.max(0, width - label.length);
  if (barWidth === 0) {
    return theme.fg("borderMuted", rule.repeat(width));
  }

  const usedCount = Math.min(barWidth, Math.max(clamped > 0 ? 1 : 0, Math.round((clamped / 100) * barWidth)));

  // Boundary ticks. Only meaningful once the gauge is wide enough to place them
  // distinctly, matching OMP's `gapWidth >= 8` guard.
  const ticks = new Map<number, { glyph: string; color: "warning" | "dim" }>();
  if ((mode === "annotated" || mode === "embedded") && barWidth >= 8) {
    const cellFor = (pct: number) =>
      Math.min(barWidth - 1, Math.max(0, Math.round((pct / 100) * barWidth)));
    // Speculative compaction runs ahead of the hard threshold.
    const speculation = Math.max(0, input.compactionThreshold - 10);
    ticks.set(cellFor(speculation), { glyph: glyphs.speculation, color: "dim" });
    // The hard threshold wins ties, so it is written last.
    ticks.set(cellFor(input.compactionThreshold), { glyph: glyphs.compaction, color: "warning" });
  }

  // Used portion escalates in color the same way the `context` segment does.
  const usedColor = clamped >= 90 ? "error" : clamped >= 70 ? "warning" : "accent";

  let out = "";
  for (let i = 0; i < barWidth; i++) {
    const tick = ticks.get(i);
    if (tick) {
      out += theme.fg(tick.color, tick.glyph);
      continue;
    }
    out += i < usedCount ? theme.fg(usedColor, rule) : theme.fg("borderMuted", rule);
  }

  if (label) {
    out += theme.fg(usedColor, label);
  }

  return out + RESET;
}
