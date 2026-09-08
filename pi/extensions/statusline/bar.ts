/**
 * Status bar assembly.
 *
 * Builds the two segment groups, measures them, applies Oh My Pi's overflow
 * priority, and joins them with the context gauge.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderGauge, type ContextLineMode } from "./gauge.ts";
import { chainWidth, getSeparator, renderChain, type Segment, type SeparatorStyle } from "./powerline.ts";
import { buildSegment, computeTotals, type SegmentId, type SegmentInput } from "./segments.ts";
import type { Glyphs } from "./theme.ts";

export interface BarConfig {
  left: SegmentId[];
  right: SegmentId[];
  separator: SeparatorStyle;
  contextLine: ContextLineMode;
  /** Maximum width of the context meter, in cells. */
  gaugeWidth: number;
  compact: boolean;
  compactionThreshold: number;
}

export interface BarInput {
  width: number;
  ctx: ExtensionContext;
  theme: Theme;
  glyphs: Glyphs;
  footer: ReadonlyFooterDataProvider | undefined;
  thinking: string;
  config: BarConfig;
  /** Filled (powerline) or plain text. Plain is used for detached bottom bars. */
  filled: boolean;
}

/**
 * Overflow priority, ported from OMP.
 *
 * When the bar exceeds the available width, segments are surrendered in this
 * order — least informative first. `path` and `model` are kept longest because
 * they answer "where am I / what am I talking to".
 */
const DROP_ORDER: SegmentId[] = [
  "time",
  "tokens",
  "window",
  "session",
  "status",
  "cost",
  "thinking",
  "context",
  "git",
  "path",
  "model",
];

/** Drop the lowest-priority segment still present. Returns false when empty. */
function dropOne(left: Segment[], right: Segment[]): boolean {
  for (const id of DROP_ORDER) {
    const ri = right.findIndex((s) => s.id === id);
    if (ri !== -1) {
      right.splice(ri, 1);
      return true;
    }
    const li = left.findIndex((s) => s.id === id);
    if (li !== -1) {
      left.splice(li, 1);
      return true;
    }
  }
  return false;
}

export interface RenderedBar {
  content: string;
  width: number;
}

/** Build and render the complete status bar at the given width. */
export function renderBar(input: BarInput): RenderedBar {
  const { width, ctx, theme, glyphs, footer, thinking, config, filled } = input;
  if (width <= 0) return { content: "", width: 0 };

  const segInput: SegmentInput = {
    ctx,
    theme,
    glyphs,
    footer,
    totals: computeTotals(ctx),
    thinking,
    compact: config.compact,
  };

  const left = config.left
    .map((id) => buildSegment(id, segInput))
    .filter((s): s is Segment => s !== undefined);
  const right = config.right
    .map((id) => buildSegment(id, segInput))
    .filter((s): s is Segment => s !== undefined);

  const sep = getSeparator(config.separator, glyphs);

  // The gauge needs at least a few cells to be meaningful; below that we let
  // the groups use the space and fall back to a plain join.
  const MIN_GAP = 3;

  // Bind the shared arguments once so the overflow loop below stays readable.
  const dimSep = theme.getFgAnsi("dim");
  const chain = (segs: Segment[], side: "left" | "right") =>
    renderChain(segs, sep, side, glyphs, filled, dimSep);

  let leftText = chain(left, "left");
  let rightText = chain(right, "right");

  while (chainWidth(leftText) + chainWidth(rightText) + MIN_GAP > width) {
    // Stop before dropping the last segment: an empty bar is less useful than
    // a truncated one. The survivor is shortened to fit instead.
    if (left.length + right.length <= 1) break;
    if (!dropOne(left, right)) break;
    leftText = chain(left, "left");
    rightText = chain(right, "right");
  }

  // Truncate the lone survivor when even it overflows.
  const survivor = left[0] ?? right[0];
  if (survivor && chainWidth(leftText) + chainWidth(rightText) + MIN_GAP > width) {
    // Measure the chain's own decoration by rendering a one-cell probe:
    // whatever it costs beyond that single cell is padding plus caps.
    const probe = chainWidth(chain([{ ...survivor, text: "x" }], "left"));
    const overhead = Math.max(0, probe - 1);
    const room = Math.max(0, width - MIN_GAP - overhead);
    survivor.text = truncateToWidth(survivor.text, room, "…");
    leftText = chain(left, "left");
    rightText = chain(right, "right");
  }

  const leftWidth = chainWidth(leftText);
  const rightWidth = chainWidth(rightText);
  const gap = Math.max(0, width - leftWidth - rightWidth);

  const usage = ctx.getContextUsage();

  // The gauge is a short fixed-width meter pinned to the right group, not a
  // rule spanning the whole bar. Blank space between the two groups reads more
  // calmly than a long line, and a compact meter is easier to judge at a
  // glance than one whose length changes with terminal width.
  const meter = Math.min(config.gaugeWidth, Math.max(0, gap - 2));
  const gaugeText =
    meter > 0
      ? renderGauge({
          width: meter,
          percent: usage?.percent ?? null,
          contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
          theme,
          glyphs,
          mode: config.contextLine,
          compactionThreshold: config.compactionThreshold,
        })
      : "";

  // Everything left over becomes blank filler, so the meter sits immediately
  // before the right group.
  const fill = Math.max(0, gap - visibleWidth(gaugeText) - (gaugeText ? 1 : 0));
  const content = leftText + " ".repeat(fill) + gaugeText + (gaugeText ? " " : "") + rightText;
  return { content, width: visibleWidth(content) };
}
