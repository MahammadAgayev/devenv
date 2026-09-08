/**
 * statusline — Oh My Pi's status bar and composer shapes for stock pi.
 *
 * Ports two pieces of Oh My Pi's TUI onto stock pi's public extension API:
 *
 *   1. A segmented powerline status bar (model, git, context %, tokens, cost)
 *      with a live context-usage gauge bridging the left and right groups.
 *   2. Composer shapes that restyle the input box, including OMP's default
 *      flush-left `band` and a `compact` layout variant.
 *
 * Everything renders through a `CustomEditor` subclass: stock pi's editor
 * already emits a top rule, content rows, and a bottom rule, so the shape layer
 * rewrites those rows rather than reimplementing text layout.
 *
 * Settings are the `CONFIG` constant below — no config file.
 */


import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { renderBar, type BarConfig } from "./bar.ts";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import {
  chromeOverhead,
  renderBottom,
  renderRow,
  renderTop,
  SHAPES,
  type ChromeContext,
  type ShapeId,
} from "./shapes.ts";
import { ASCII_GLYPHS, NERD_GLYPHS, type Glyphs } from "./theme.ts";

interface Config extends BarConfig {
  shape: ShapeId;
  /** Nerd Font glyphs. Ghostty embeds Symbols Nerd Font, so this defaults on. */
  nerdFont: boolean;
  /**
   * Draw the bar with no filled backgrounds.
   *
   * Stock pi themes only define foreground colors, so a filled powerline bar
   * has to invent segment backgrounds — and the theme's `text` color is then
   * usually near-invisible on them. Transparent mode paints each segment in
   * its own color on the terminal's background instead, which reads correctly
   * on every theme. On by default for that reason.
   */
  transparent: boolean;
  /**
   * Where the detached status bar sits, for shapes that do not attach it to
   * their own chrome (`borderless`, `field`, `rail`).
   */
  statusPosition: "above" | "below";
  /**
   * Blank lines rendered below the editor, lifting it off the bottom edge.
   *
   * In pi's default `regular` TUI the editor block is the last thing written
   * to the terminal, so it always ends up flush against the bottom. pi mounts
   * the footer below the editor, so padding it there is what buys the gap.
   */
  bottomGap: number | `${number}%`;
}

/**
 * Settings. Edit these directly — there is no config file.
 *
 * Segment ids: model · thinking · path · git · context · cost · tokens ·
 * session · time · status
 */
const CONFIG: Config = {
  /** borderless · band · box · field · rail */
  shape: "borderless",
  /** Nerd Font glyphs. `false` gives pure ASCII. */
  nerdFont: true,
  /** No filled backgrounds — required for readable contrast on stock themes. */
  transparent: true,
  /** above · below — where the detached bar sits. */
  statusPosition: "above",
  /**
   * Space below the editor, lifting it off the bottom edge. A percentage of
   * terminal height, or a plain number of rows. Capped at a third of the
   * screen.
   */
  bottomGap: "8%",
  /** powerline · powerline-thin · slash · pipe · block · none · ascii */
  separator: "powerline-thin",
  /** off · percentage · annotated · embedded */
  contextLine: "embedded",
  /** Denser preset: fewer segments, shorter numbers. */
  compact: false,
  /** Width of the context meter, in cells. */
  gaugeWidth: 24,
  /** Percent at which auto-compaction fires; drives the gauge ticks. */
  compactionThreshold: 80,
  left: ["model", "thinking", "path", "git"],
  // No `context` segment: the gauge between the groups already shows the
  // percentage, so a `59% of 400k` chip would just repeat it.
  right: ["status", "window", "cost"],
};

/**
 * Compact mode overrides.
 *
 * OMP's `compact` preset trades detail for width: fewer segments, no icons'
 * long labels, shortened numbers, and a plain gauge.
 */
const COMPACT_OVERRIDES: Partial<Config> = {
  left: ["model", "git"],
  // Compact keeps `context`: its gauge mode is `percentage`, which draws the
  // bar without a number, so this is the only place the figure appears.
  right: ["cost", "context"],
  contextLine: "percentage",
};

/**
 * Resolve the effective config.
 *
 * Edit {@link CONFIG} above to change anything; compact mode then layers its
 * preset underneath, so explicit values in `CONFIG` still win.
 */
function resolveConfig(): Config {
  return CONFIG.compact ? { ...COMPACT_OVERRIDES, ...CONFIG } : CONFIG;
}

/**
 * Index of the editor's bottom rule within its rendered rows.
 *
 * The stock editor emits `[top rule, ...content, bottom rule]`, then appends
 * the autocomplete menu *after* the bottom rule when it is open. The rules are
 * the only rows made entirely of `─` (optionally carrying a scroll indicator),
 * so scanning back for the last such row separates the input body from the
 * menu without depending on the menu's height.
 *
 * Falls back to the last row, which is the closed-menu case.
 */
function lastRuleIndex(rows: readonly string[]): number {
  for (let i = rows.length - 1; i > 0; i--) {
    const plain = stripAnsi(rows[i]!);
    // A rule is non-empty and contains nothing but the horizontal glyph.
    if (plain.length > 0 && /^─+$/.test(plain)) return i;
  }
  return Math.max(1, rows.length - 1);
}

/** Remove SGR sequences so a row can be matched on its visible characters. */
function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Rows the gap must hold in reserve for the autocomplete menu.
 *
 * pi's editor shows at most 5 menu entries by default; the extra row covers
 * the blank the menu sits above. The gap has to be at least this tall or it
 * cannot absorb the menu opening without scrolling the terminal.
 */
const RESERVE_ROWS = 6;

/**
 * Replacement for pi's built-in footer.
 *
 * Two jobs. First, it renders none of pi's own footer content, since this
 * extension already draws all of it in the bar. Second, pi mounts
 * `footerContainer` *below* the editor, so emitting blank lines here is the
 * one way an extension can lift the whole editor block off the bottom edge of
 * the terminal — see `bottomGap`.
 */
class GapFooter implements Component {
  // Plain fields, not constructor parameter properties: the latter are real
  // TypeScript syntax that Node's strip-only type stripping rejects.
  readonly #gap: number | string;
  readonly #tui: TUI;
  /** Reports the editor's current rendered height. */
  readonly #editorHeight: () => number;
  /** Editor height with an empty single-line input and no menu. */
  readonly #baseEditorRows: () => number;

  constructor(tui: TUI, gap: number | string, editorHeight: () => number, baseEditorRows: () => number) {
    this.#tui = tui;
    this.#gap = gap;
    this.#editorHeight = editorHeight;
    this.#baseEditorRows = baseEditorRows;
  }

  /**
   * Resolve the gap to a row count.
   *
   * A `"20%"` string is taken as a share of terminal height, so the editor
   * keeps the same visual position on any window size. A plain number is used
   * verbatim. Either way the result is clamped so the gap can never eat the
   * screen on a very short terminal.
   */
  #rows(): number {
    const height = this.#tui.terminal.rows;
    const raw =
      typeof this.#gap === "string" && this.#gap.trim().endsWith("%")
        ? (height * (Number.parseFloat(this.#gap) || 0)) / 100
        : Number(this.#gap) || 0;
    // Reserve at least the autocomplete menu's height. The gap can only
    // absorb growth up to its own size, so a gap smaller than the menu still
    // forces a scroll — and the input never comes back down. `RESERVE_ROWS`
    // covers the menu (5 by default) plus its trailing blank.
    const wanted = Math.max(Math.round(raw), RESERVE_ROWS);
    // Never take more than a third of the screen, and never go negative.
    return Math.max(0, Math.min(wanted, Math.floor(height / 3)));
  }

  render(): string[] {
    // Yield the gap back when the editor grows.
    //
    // pi's regular TUI writes into normal terminal scrollback. If the frame
    // already reaches the last row, anything that makes it taller — opening
    // the slash menu — forces the terminal to scroll, and a scroll cannot be
    // undone: the input would stay permanently higher after the menu closed.
    //
    // Shrinking the gap by however much the editor grew keeps the total frame
    // height constant, so the menu opens without scrolling and the layout
    // returns exactly where it started.
    const editorRows = this.#editorHeight();
    const base = this.#baseEditorRows();
    // Before the editor's first render both are 0; emit the full gap then.
    const grown = base > 0 ? Math.max(0, editorRows - base) : 0;
    const rows = Math.max(0, this.#rows() - grown);
    return rows > 0 ? Array<string>(rows).fill("") : [];
  }

  invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  /**
   * Height of the editor's last rendered frame, shared with the footer so it
   * can give back its gap when the editor grows. See `GapFooter.render`.
   */
  let editorRows = 0;
  /** Resting editor height, captured on the first render. */
  let baseEditorRows = 0;

  pi.on("session_shutdown", () => {
    activeTui = undefined;
  });

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const config = resolveConfig();
    const shape = SHAPES[config.shape] ?? SHAPES.band;
    const glyphs: Glyphs = config.nerdFont ? NERD_GLYPHS : ASCII_GLYPHS;

    // The status bar replaces the stock footer entirely. `setFooter` is also
    // the only place pi hands out the FooterDataProvider (git branch and the
    // statuses other extensions publish via `setStatus`), so capture it here.
    let footerData: ReadonlyFooterDataProvider | undefined;
    ctx.ui.setFooter((tui, _theme, data) => {
      footerData = data;
      data.onBranchChange(() => activeTui?.requestRender());
      // `baseEditorRows` is the height of a resting editor: one input line,
      // no menu. The editor records it on its first render, which is always
      // the resting state, so the footer starts from a correct baseline
      // without having to model each shape's chrome.
      return new GapFooter(
        tui,
        config.bottomGap,
        () => editorRows,
        () => baseEditorRows,
      );
    });

    // Repaint on the events that change what the bar displays.
    const repaint = () => activeTui?.requestRender();
    pi.on("agent_start", repaint);
    pi.on("agent_settled", repaint);
    pi.on("model_select", repaint);

    class OmpEditor extends CustomEditor {
      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings, { paddingX: shape.paddingX });
        activeTui = tui;
      }

      render(width: number): string[] {
        // The editor pads its rows out to whatever width it is given, so it
        // must render into the space left over after the shape's chrome.
        const rows = super.render(Math.max(1, width - chromeOverhead(shape)));
        if (rows.length < 2) return rows;

        const theme: Theme = ctx.ui.theme;
        const chrome: ChromeContext = {
          width,
          borderColor: (s) => this.borderColor(s),
          accentColor: (s) => theme.fg("accent", s),
          glyphs,
        };

        // Stock pi's editor emits: top rule, content rows, bottom rule, and
        // then — when the slash-command / file menu is open — the autocomplete
        // list *after* the bottom rule. Split those three groups apart. The
        // menu must pass through untouched: wrapping it in the shape's chrome
        // would draw borders around the popup.
        const bottomRule = lastRuleIndex(rows);
        const content = rows.slice(1, bottomRule);
        const menu = rows.slice(bottomRule + 1);

        const needsStatus = shape.statusAttachment !== "none";
        if (needsStatus) {
          chrome.status = renderBar({
            // The box shape insets the status inside its frame: two corner
            // glyphs plus the padding on each side.
            width:
              shape.statusAttachment === "top-border"
                ? Math.max(0, width - (shape.paddingX + 1) * 2)
                : width,
            ctx,
            theme,
            glyphs,
            footer: footerData,
            thinking: pi.getThinkingLevel(),
            config,
            filled: !config.transparent,
          });
        }

        const out: string[] = [];

        const top = renderTop(shape, chrome);
        if (top !== undefined) out.push(top);

        const gutter = shape.promptGutter ?? "";
        for (let i = 0; i < content.length; i++) {
          const raw = content[i]!;
          // The prompt glyph only leads the first row; continuation rows are
          // indented to match so text stays aligned.
          const lead = i === 0 ? theme.fg("accent", gutter) : " ".repeat(visibleWidth(gutter));
          out.push(renderRow(shape, lead + raw, chrome));
        }

        const bottom = renderBottom(shape, chrome);
        if (bottom !== undefined) out.push(bottom);

        // Shapes with no attached status render it as a detached bar, either
        // above or below the input depending on `statusPosition`.
        if (!needsStatus) {
          const bar = renderBar({
            width,
            ctx,
            theme,
            glyphs,
            footer: footerData,
            thinking: pi.getThinkingLevel(),
            config,
            filled: !config.transparent,
          });
          if (config.statusPosition === "above") out.unshift(bar.content);
          else out.push(bar.content);
        }

        // The autocomplete menu goes last, verbatim. It is a popup, not part
        // of the input, so it gets none of the shape's chrome.
        out.push(...menu);

        // Publish this frame's height for GapFooter. The first render is
        // always the resting state (empty input, no menu), so it doubles as
        // the baseline the footer measures growth against.
        editorRows = out.length;
        if (baseEditorRows === 0) baseEditorRows = out.length;

        return out;
      }
    }

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new OmpEditor(tui, theme, keybindings));
  });
}
