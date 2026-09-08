/**
 * Palette + glyph layer.
 *
 * Stock pi's `Theme` has no `statusLineBg`, no `theme.sep.*` and no symbol
 * presets — those are Oh My Pi fork additions. This module rebuilds just
 * enough of that surface on top of the stock theme:
 *
 *   - Powerline / box-drawing glyph sets, in `nerd` and `ascii` flavours.
 *   - A small set of background colors for the segment chain, derived from the
 *     stock theme's foreground colors so it tracks whatever theme is active.
 *
 * Everything here is pure string/ANSI work with no pi-fork dependencies.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/** Glyphs that need a Nerd Font. Ghostty embeds Symbols Nerd Font 3.4.0. */
export interface Glyphs {
  powerlineLeft: string;
  powerlineRight: string;
  powerlineThinLeft: string;
  powerlineThinRight: string;
  /** Rounded opening cap for the flush-left band (nf `\ue0b6`). */
  capLeft: string;
  block: string;
  asciiLeft: string;
  asciiRight: string;
  slash: string;
  pipe: string;
  dot: string;
  horizontal: string;
  // Segment icons
  model: string;
  branch: string;
  pr: string;
  folder: string;
  context: string;
  cost: string;
  tokens: string;
  subscription: string;
  time: string;
  agents: string;
  // Context-gauge boundary ticks
  compaction: string;
  speculation: string;
}

/** Nerd Font glyph set — matches Oh My Pi's `nerd` symbol preset codepoints. */
export const NERD_GLYPHS: Glyphs = {
  powerlineLeft: "\ue0b0",
  powerlineRight: "\ue0b2",
  powerlineThinLeft: "\ue0b1",
  powerlineThinRight: "\ue0b3",
  capLeft: "\ue0b6",
  block: "█",
  asciiLeft: ">",
  asciiRight: "<",
  slash: "\ue0bb",
  pipe: "\ue0b3",
  dot: " · ",
  horizontal: "─",
  model: "\uec19",
  branch: "\uf126",
  pr: "\uea64",
  folder: "\uf115",
  context: "\ue70f",
  cost: "\uf155",
  tokens: "\ue26b",
  subscription: "\u{f067a}",
  time: "\uf017",
  agents: "\uf0c0",
  compaction: "\uf0c7",
  speculation: "\uf141",
};

/** Pure-ASCII fallback for terminals with no Nerd Font. */
export const ASCII_GLYPHS: Glyphs = {
  powerlineLeft: ">",
  powerlineRight: "<",
  powerlineThinLeft: ">",
  powerlineThinRight: "<",
  capLeft: "",
  block: "#",
  asciiLeft: ">",
  asciiRight: "<",
  slash: "/",
  pipe: "|",
  dot: " · ",
  horizontal: "-",
  model: "",
  branch: "",
  pr: "PR",
  folder: "",
  context: "",
  cost: "$",
  tokens: "",
  subscription: "S",
  time: "",
  agents: "",
  compaction: "|",
  speculation: ".",
};

/**
 * Convert a foreground SGR sequence into the matching background sequence.
 *
 * Stock pi exposes `getFgAnsi()` but has no background equivalent for arbitrary
 * theme colors, so we rewrite the parameter prefix: `38;` (fg) -> `48;` (bg).
 * Covers both truecolor (`38;2;r;g;b`) and 256-color (`38;5;n`) modes.
 */
export function fgToBg(ansi: string): string {
  return ansi.replace(/\x1b\[38;/g, "\x1b[48;");
}

/**
 * Convert a background SGR sequence back into a foreground one.
 *
 * This is the powerline `useBgAsFg` trick: to draw the transition arrow between
 * two segments, the glyph is painted in the *previous* segment's background
 * color on top of the *next* segment's background.
 */
export function bgToFg(ansi: string): string {
  return ansi.replace(/\x1b\[48;/g, "\x1b[38;");
}

export const RESET = "\x1b[0m";

/** Resolved colors for one status-line segment. */
export interface SegmentPalette {
  /** Background SGR for the segment body (filled mode only). */
  bg: string;
  /** Foreground SGR for the segment text when it sits on `bg`. */
  fg: string;
  /**
   * The segment's own color as a foreground SGR.
   *
   * Transparent mode paints text in this instead of filling a background, so
   * each segment keeps its identity while staying readable on the terminal's
   * own background.
   */
  accent: string;
}

/**
 * Build a segment palette from a stock-theme color name.
 *
 * The segment background is the theme color itself; the text sits on top in a
 * contrasting tone. Because stock themes only guarantee foreground colors, the
 * background is synthesised via {@link fgToBg}.
 */
export function paletteFor(theme: Theme, color: ThemeColor, textColor: ThemeColor = "text"): SegmentPalette {
  return {
    bg: fgToBg(theme.getFgAnsi(color)),
    fg: theme.getFgAnsi(textColor),
    accent: theme.getFgAnsi(color),
  };
}
