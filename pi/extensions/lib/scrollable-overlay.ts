/**
 * scrollable-overlay.ts — Reusable scrollable overlay with mouse wheel support.
 *
 * A single overlay component that provides:
 *   - Bordered frame (title / subtitle / help) via BorderedOverlay
 *   - Scrollable content windowing (j/k, ↑↓, PgUp/PgDn, g/G)
 *   - Mouse wheel scrolling via SGR mouse mode (DEC 1000 + 1006)
 *   - Custom key handler hook (for `v` open-in-vscode, `r` refresh, actions, etc.)
 *   - Automatic mouse-mode enable on open and disable on dispose
 *
 * Usage:
 *   const overlay = new ScrollableOverlay(ctx, {
 *     title: "Spec: Write Routing",
 *     renderContent: (width) => md.render(width),
 *     onKey: (data, { done }) => {
 *       if (data === "v") { openInVsCode(path); return true; }
 *       return false; // let default scroll keys handle it
 *     },
 *   });
 *   await overlay.open();
 *
 * All pi extensions that show a scrollable overlay (markdown-preview, context-viz,
 * run-overlay detail pane) should use this so mouse + scroll improvements
 * land in one place.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "./tui-shared.ts";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { BorderedOverlay } from "./bordered-overlay.ts";
import { DEFAULT_OVERLAY_OPTIONS } from "./tui-shared.ts";

// ── SGR mouse mode ───────────────────────────────────────────────────────────

/** Enable SGR mouse mode (button + wheel events). */
function enableMouseMode(): void {
  process.stdout.write("\x1b[?1000h\x1b[?1006h");
}

/** Disable SGR mouse mode. */
function disableMouseMode(): void {
  process.stdout.write("\x1b[?1006l\x1b[?1000l");
}

/** SGR wheel button codes. */
const MOUSE_WHEEL_UP = 64;
const MOUSE_WHEEL_DOWN = 65;

/**
 * Parse an SGR mouse sequence.
 * Format: `\x1b[<BUTTON;COL;ROW[Mm]` (M=press/motion, m=release)
 * Returns null if the data is not a mouse sequence.
 *
 * Exported for testing.
 */
export function parseSGRMouse(data: string): { button: number } | null {
  const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
  if (!match) return null;
  return { button: parseInt(match[1], 10) };
}

// ── types ────────────────────────────────────────────────────────────────────

export interface ScrollableOverlayOptions {
  /** Title shown in the bordered frame header. */
  title: string;
  /** Optional subtitle below the title. */
  subtitle?: string;
  /**
   * Render the full (un-windowed) content into lines for the given width.
   * The overlay handles windowing — this should return ALL lines, not just
   * the visible window.
   */
  renderContent: (width: number) => string[];
  /**
   * Help text shown at the bottom of the frame.
   * Default: "↑↓/j/k scroll • PgUp/PgDn page • g/G top/bottom • mouse wheel • q/esc close"
   */
  help?: string;
  /**
   * Optional custom key handler. Called BEFORE the default scroll/close keys.
   * Return `true` to consume the key (default handling is skipped).
   * Return `false` to let the default scroll/close keys process it.
   *
   * The context provides the current scroll state and a `done()` callback to
   * close the overlay.
   */
  onKey?: (
    data: string,
    ctx: {
      scroll: number;
      maxScroll: number;
      viewport: number;
      total: number;
      done: () => void;
      requestRender: () => void;
    },
  ) => boolean;
  /** Overlay height as a fraction of terminal rows. Default 0.88 (88%). */
  heightFraction?: number;
  /** Extra keybindings to show in the help bar (appended after the defaults). */
  extraHelpKeys?: string;
}

// ── component ────────────────────────────────────────────────────────────────

export class ScrollableOverlay {
  private scroll = 0;
  private cachedLines: string[] | null = null;
  private cachedWidth = 0;
  private done: (() => void) | null = null;
  private tui: any;
  private theme: any;

  constructor(
    private ctx: ExtensionContext,
    private opts: ScrollableOverlayOptions,
  ) {}

  private get helpText(): string {
    if (this.opts.help) return this.opts.help;
    const base = "↑↓/j/k scroll • PgUp/PgDn page • g/G top/bottom • mouse wheel • q/esc close";
    return this.opts.extraHelpKeys ? `${base} • ${this.opts.extraHelpKeys}` : base;
  }

  private get viewportRows(): number {
    const rows =
      typeof process.stdout?.rows === "number" && process.stdout.rows > 0
        ? process.stdout.rows
        : 40;
    const frac = this.opts.heightFraction ?? 0.88;
    // 88% overlay height minus border/title/help chrome (~6 lines)
    return Math.max(1, Math.floor(rows * frac) - 6);
  }

  private getLines(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedLines = this.opts.renderContent(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private maxScroll(lines: string[]): number {
    return Math.max(0, lines.length - this.viewportRows);
  }

  private clampScroll(): void {
    const lines = this.cachedLines ?? [];
    const max = this.maxScroll(lines);
    if (this.scroll > max) this.scroll = max;
    if (this.scroll < 0) this.scroll = 0;
  }

  render(width: number): string[] {
    const lines = this.getLines(width);
    this.clampScroll();

    const vp = this.viewportRows;
    const total = lines.length;
    const max = this.maxScroll(lines);
    const window = lines.slice(this.scroll, this.scroll + vp);

    const scrollIndicator = total > vp
      ? this.theme?.fg("dim", `  [${this.scroll + 1}-${Math.min(this.scroll + vp, total)}/${total}]`) ?? ""
      : "";

    const pane = new BorderedOverlay(this.theme, {
      title: this.opts.title,
      subtitle: this.opts.subtitle,
      help: this.helpText,
    });

    // Render the windowed content lines into the pane.
    const bg = (s: string) => `\x1b[48;5;235m${s}\x1b[0m`;
    const dim = (s: string) => this.theme?.fg("dim", s) ?? s;

    // If there's a scroll indicator, add it as a subtitle-like line at the top
    // of the content area (after the title block, before the window).
    if (scrollIndicator) {
      // BorderedOverlay already has title + spacer; we add the indicator
      // as the first content line.
      pane.addChild(new (require("@earendil-works/pi-tui").Text)(
        dim(scrollIndicator), 2, 0, bg,
      ));
    }

    for (const line of window) {
      pane.addChild(new (require("@earendil-works/pi-tui").Text)(
        line, 2, 0, bg,
      ));
    }

    return pane.render(width);
  }

  invalidate(): void {
    this.cachedLines = null;
    this.cachedWidth = 0;
  }

  handleInput(data: string): void {
    const lines = this.cachedLines ?? [];
    const vp = this.viewportRows;
    const max = this.maxScroll(lines);

    // ── Mouse wheel ──────────────────────────────────────────────────────────
    const mouse = parseSGRMouse(data);
    if (mouse) {
      if (mouse.button === MOUSE_WHEEL_UP) {
        this.scroll = Math.max(0, this.scroll - 3);
      } else if (mouse.button === MOUSE_WHEEL_DOWN) {
        this.scroll = Math.min(max, this.scroll + 3);
      }
      this.tui?.requestRender();
      return;
    }

    // ── Custom key handler (called first) ────────────────────────────────────
    if (this.opts.onKey) {
      const consumed = this.opts.onKey(data, {
        scroll: this.scroll,
        maxScroll: max,
        viewport: vp,
        total: lines.length,
        done: () => this.close(),
        requestRender: () => this.tui?.requestRender(),
      });
      if (consumed) {
        this.tui?.requestRender();
        return;
      }
    }

    // ── Default scroll keys ──────────────────────────────────────────────────
    if (matchesKey(data, Key.up) || data === "k") {
      this.scroll = Math.max(0, this.scroll - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.scroll = Math.min(max, this.scroll + 1);
    } else if (matchesKey(data, "pageUp")) {
      this.scroll = Math.max(0, this.scroll - vp);
    } else if (matchesKey(data, "pageDown")) {
      this.scroll = Math.min(max, this.scroll + vp);
    } else if (data === "g" || matchesKey(data, Key.home)) {
      this.scroll = 0;
    } else if (data === "G" || matchesKey(data, Key.end)) {
      this.scroll = max;
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.close();
      return;
    }

    this.tui?.requestRender();
  }

  private close(): void {
    this.done?.();
  }

  async open(): Promise<void> {
    // Enable mouse mode for wheel scrolling.
    enableMouseMode();

    return new Promise((resolve) => {
      this.done = () => {
        disableMouseMode();
        this.tui = undefined;
        resolve();
      };

      this.ctx.ui.custom(
        (tui: any, theme: any, _kb: any, done: (result: unknown) => void) => {
          this.tui = tui;
          this.theme = theme;
          this.done = () => {
            disableMouseMode();
            this.tui = undefined;
            done(undefined);
            resolve();
          };

          return {
            render: (w: number) => this.render(w),
            invalidate: () => this.invalidate(),
            handleInput: (data: string) => this.handleInput(data),
            dispose: () => {
              disableMouseMode();
            },
          } as any;
        },
        {
          overlay: true,
          overlayOptions: DEFAULT_OVERLAY_OPTIONS,
        },
      );
    });
  }
}
