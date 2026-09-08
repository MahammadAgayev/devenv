/**
 * Powerline segment chain renderer.
 *
 * Ports Oh My Pi's status-line group rendering: a run of colored segments
 * joined so that each boundary glyph is drawn in the *previous* segment's
 * background color on top of the *next* segment's background, producing the
 * classic powerline "arrow" bridge. The ends of the run get caps that bridge
 * the group's background into the surrounding terminal.
 *
 * Pure rendering — no session or fork APIs.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { bgToFg, type Glyphs, RESET, type SegmentPalette } from "./theme.ts";

/** One rendered piece of the chain. */
export interface Segment {
  /** Stable id, used for overflow priority. */
  id: string;
  /** Already-formatted text, WITHOUT padding or color. */
  text: string;
  palette: SegmentPalette;
}

export type SeparatorStyle = "powerline" | "powerline-thin" | "slash" | "pipe" | "block" | "none" | "ascii";

export interface SeparatorDef {
  /** Glyph pointing left (used on right-aligned groups). */
  left: string;
  /** Glyph pointing right (used on left-aligned groups). */
  right: string;
  /**
   * When set, the boundary glyph is painted using the adjacent segment's
   * background as its foreground. Only true powerline arrows do this; text
   * separators like `/` just sit inside the segment background.
   */
  useBgAsFg: boolean;
}

export function getSeparator(style: SeparatorStyle, glyphs: Glyphs): SeparatorDef {
  switch (style) {
    case "powerline":
      return { left: glyphs.powerlineRight, right: glyphs.powerlineLeft, useBgAsFg: true };
    case "powerline-thin":
      return { left: glyphs.powerlineThinRight, right: glyphs.powerlineThinLeft, useBgAsFg: true };
    case "slash":
      return { left: glyphs.slash, right: glyphs.slash, useBgAsFg: false };
    case "pipe":
      return { left: glyphs.pipe, right: glyphs.pipe, useBgAsFg: false };
    case "block":
      return { left: glyphs.block, right: glyphs.block, useBgAsFg: true };
    case "ascii":
      return { left: glyphs.asciiLeft, right: glyphs.asciiRight, useBgAsFg: false };
    default:
      return { left: " ", right: " ", useBgAsFg: false };
  }
}

/**
 * Render a run of segments as a filled powerline chain.
 *
 * `side` controls which way the arrows point and where the closing cap goes:
 * a `left` group flows rightward and caps on its right edge; a `right` group
 * caps on its left edge.
 *
 * When `filled` is false the chain degrades to plain dot-separated text with no
 * backgrounds, which is what the non-powerline layouts use.
 */
export function renderChain(
  segments: readonly Segment[],
  sep: SeparatorDef,
  side: "left" | "right",
  glyphs: Glyphs,
  filled: boolean,
  /** SGR for the separator between segments in transparent mode. */
  dimSeparator = "",
): string {
  const visible = segments.filter((s) => s.text.length > 0);
  if (visible.length === 0) return "";

  if (!filled) {
    // Transparent mode: no backgrounds at all. Each segment is painted in its
    // own color directly on the terminal background, which keeps the color
    // coding while guaranteeing readable contrast on any theme.
    const sepText = glyphs.dot;
    return visible
      .map((s) => s.palette.accent + s.text + RESET)
      .join(dimSeparator + sepText + RESET);
  }

  let out = "";

  // Opening cap: bridges terminal background into the first segment.
  const first = visible[0]!;
  if (side === "right" && sep.useBgAsFg && glyphs.powerlineRight) {
    out += bgToFg(first.palette.bg) + glyphs.powerlineRight + RESET;
  }

  for (let i = 0; i < visible.length; i++) {
    const seg = visible[i]!;
    const next = visible[i + 1];

    out += seg.palette.bg + seg.palette.fg + ` ${seg.text} ` + RESET;

    if (!next) continue;

    if (sep.useBgAsFg) {
      // Arrow drawn in THIS segment's bg color, sitting on the NEXT segment's bg.
      const glyph = side === "left" ? sep.right : sep.left;
      out += next.palette.bg + bgToFg(seg.palette.bg) + glyph + RESET;
    } else {
      // Text separator lives inside the shared background.
      const glyph = side === "left" ? sep.right : sep.left;
      out += seg.palette.bg + seg.palette.fg + glyph + RESET;
    }
  }

  // Closing cap.
  const last = visible[visible.length - 1]!;
  if (side === "left" && sep.useBgAsFg && glyphs.powerlineLeft) {
    out += bgToFg(last.palette.bg) + glyphs.powerlineLeft + RESET;
  }

  return out;
}

/** Visible width of a rendered chain, ignoring SGR sequences. */
export function chainWidth(rendered: string): number {
  return visibleWidth(rendered);
}
