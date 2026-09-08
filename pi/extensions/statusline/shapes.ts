/**
 * Composer shapes.
 *
 * Ports Oh My Pi's composer chrome contract to stock pi. Each shape owns the
 * frame around the input editor and declares where the status bar attaches:
 *
 *   band       — flush-left powerline band above a `╰─ ` prompt (OMP default)
 *   box        — rounded frame with the status line embedded in the top border
 *   field      — one-line filled field with accent end caps
 *   rail       — filled surface anchored by a single left accent rail
 *   borderless — bare `❯ ` prompt, status bar below
 *
 * Stock pi's `Editor.render()` always emits a top rule, the content rows, and a
 * bottom rule. These shapes rewrite those rows in place, so they compose with
 * the stock editor rather than reimplementing text layout.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Glyphs } from "./theme.ts";

export type ShapeId = "band" | "box" | "field" | "rail" | "borderless";

/** Rounded box-drawing glyphs. These are plain Unicode, not Nerd Font. */
export const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

export interface ShapeDef {
  readonly id: ShapeId;
  /** Where the status bar goes. */
  readonly statusAttachment: "top-border" | "top-band" | "none";
  /** Prompt glyph placed before the first input row. */
  readonly promptGutter: string | undefined;
  /** Horizontal padding inside the frame. */
  readonly paddingX: number;
  /** Whether content rows carry left/right border glyphs. */
  readonly sideBorders: boolean;
}

export const SHAPES: Record<ShapeId, ShapeDef> = {
  band: {
    id: "band",
    statusAttachment: "top-band",
    promptGutter: "╰─ ",
    paddingX: 0,
    sideBorders: false,
  },
  box: {
    id: "box",
    statusAttachment: "top-border",
    promptGutter: undefined,
    paddingX: 1,
    sideBorders: true,
  },
  field: {
    id: "field",
    statusAttachment: "none",
    promptGutter: "❯ ",
    paddingX: 1,
    sideBorders: true,
  },
  rail: {
    id: "rail",
    statusAttachment: "none",
    promptGutter: "❯ ",
    paddingX: 1,
    sideBorders: true,
  },
  borderless: {
    id: "borderless",
    statusAttachment: "none",
    // Thick left bar, Neovim-style, rather than a chevron.
    promptGutter: "▌ ",
    paddingX: 0,
    sideBorders: false,
  },
};

const LEFT_CAP = "▐";
const RIGHT_CAP = "▌";
const ACCENT_RAIL = "▎";

/** Cells the shape's side glyphs occupy on a content row. */
function sideChromeWidth(shape: ShapeDef): number {
  switch (shape.id) {
    case "box":
    case "field":
      return 2;
    case "rail":
      return 1;
    default:
      return 0;
  }
}

/**
 * Total cells the shape steals from a content row.
 *
 * Stock pi's editor pads every row out to the width it is handed, so the
 * caller must shrink that width by this much before rendering; otherwise the
 * gutter and side glyphs push the row past the terminal edge.
 */
export function chromeOverhead(shape: ShapeDef): number {
  return sideChromeWidth(shape) + visibleWidth(shape.promptGutter ?? "");
}

export interface ChromeContext {
  width: number;
  /** Pre-rendered status bar content for the top chrome, if any. */
  status?: { content: string; width: number };
  borderColor: (s: string) => string;
  accentColor: (s: string) => string;
  glyphs: Glyphs;
}

/**
 * Render the top chrome row for a shape.
 *
 * Returns `undefined` when the shape has no top chrome, in which case the
 * caller drops the stock editor's top rule entirely.
 */
export function renderTop(shape: ShapeDef, ctx: ChromeContext): string | undefined {
  const { width, status, borderColor, glyphs } = ctx;

  switch (shape.id) {
    case "band": {
      // The band is the status line itself, flush against the left edge.
      if (!status?.content) return "";
      return status.content;
    }

    case "box": {
      // Status embedded just after the top-left corner, rule filling the rest.
      const left = borderColor(BOX.topLeft + BOX.horizontal.repeat(shape.paddingX));
      const right = borderColor(BOX.horizontal.repeat(shape.paddingX) + BOX.topRight);
      const inner = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
      if (!status?.content) {
        return left + borderColor(BOX.horizontal.repeat(inner)) + right;
      }
      const fill = Math.max(0, inner - status.width);
      return left + status.content + borderColor(BOX.horizontal.repeat(fill)) + right;
    }

    default:
      return undefined;
  }
}

/** Render the bottom chrome row, or `undefined` when the shape has none. */
export function renderBottom(shape: ShapeDef, ctx: ChromeContext): string | undefined {
  if (shape.id === "box") {
    return ctx.borderColor(
      BOX.bottomLeft + BOX.horizontal.repeat(Math.max(0, ctx.width - 2)) + BOX.bottomRight,
    );
  }
  return undefined;
}

/**
 * Wrap one already-rendered content row in the shape's side chrome.
 *
 * `row` is the row as stock pi's editor produced it, already padded to
 * `width - chromeOverhead(shape)` cells and carrying the shape's gutter, so
 * the glyphs added here bring it back to exactly `width`.
 */
export function renderRow(shape: ShapeDef, row: string, ctx: ChromeContext): string {
  const { borderColor, accentColor } = ctx;

  switch (shape.id) {
    case "box":
      return borderColor(BOX.vertical) + row + borderColor(BOX.vertical);

    case "field":
      return accentColor(LEFT_CAP) + row + accentColor(RIGHT_CAP);

    case "rail":
      return accentColor(ACCENT_RAIL) + row;

    default:
      return row;
  }
}
