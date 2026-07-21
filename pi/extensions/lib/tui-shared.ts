import { createRequire } from "node:module";
import type { Key as KeyNS, SelectItem, SelectList as SelectListClass } from "@earendil-works/pi-tui";
import type { BorderedOverlay as BorderedOverlayClass } from "./bordered-overlay.ts";
import type { Theme } from "./pi-types.ts";

// pi-tui and bordered-overlay (which itself imports pi-tui) are only available
// in the live pi runtime, not as local devDependencies. Importing them at module
// load breaks standalone `bun test` of the pure helpers re-exported here, so
// resolve the runtime-only constructors lazily — every call site runs in-runtime.
let _tuiMod: { Key: typeof KeyNS; SelectList: typeof SelectListClass } | null = null;
function tuiMod(): { Key: typeof KeyNS; SelectList: typeof SelectListClass } {
  if (!_tuiMod) _tuiMod = createRequire(import.meta.url)("@earendil-works/pi-tui") as typeof _tuiMod;
  return _tuiMod!;
}
let _BorderedOverlay: typeof BorderedOverlayClass | null = null;
function borderedOverlay(): typeof BorderedOverlayClass {
  if (!_BorderedOverlay) {
    _BorderedOverlay = (createRequire(import.meta.url)("./bordered-overlay.ts") as { BorderedOverlay: typeof BorderedOverlayClass }).BorderedOverlay;
  }
  return _BorderedOverlay;
}

/** Lazily-resolved pi-tui `Key` namespace, for shortcut registration in test-safe modules. */
export function key(): typeof KeyNS {
  return tuiMod().Key;
}

export type ThemeLike = Theme;
export type ExtensionContextLike = {
  ui: {
    theme?: ThemeLike;
    setWidget(key: string, lines?: string[], opts?: { placement?: string }): void;
    setStatus?(key: string, value?: string): void;
    custom<T = unknown>(
      render: (tui: any, theme: ThemeLike, keybindings: any, done: (result?: T) => void) => any,
      options?: { overlay?: boolean; overlayOptions?: any; onHandle?: (h: any) => void },
    ): Promise<T>;
  };
};

export type ThemeColor = "accent" | "muted" | "dim" | "warning" | "error" | "success" | "text";

export const DEFAULT_OVERLAY_OPTIONS = { width: "92%", maxHeight: "88%", anchor: "center" } as const;

export function truncate(text: string | undefined, max: number): string {
  const s = (text ?? "").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function truncateStatusLabel(text: string | undefined, max = 20): string {
  return truncate(text, max) || "";
}

export function countSubtitle(count: number, singular: string, plural = `${singular}s`, empty?: string): string {
  if (count === 0) return empty ?? `No ${plural}`;
  return `${count} ${count === 1 ? singular : plural}`;
}

export function themedSelectListOptions(theme: ThemeLike) {
  return {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  };
}

export function buildSelectList(theme: ThemeLike, items: SelectItem[], maxVisible = 10): SelectListClass {
  return new (tuiMod().SelectList)(items, Math.min(items.length, maxVisible), themedSelectListOptions(theme));
}

export async function showSelectOverlay(args: {
  ctx: ExtensionContextLike;
  title: string;
  subtitle?: string;
  help: string;
  items: SelectItem[];
  maxVisible?: number;
}): Promise<string | null> {
  const { ctx, title, subtitle, help, items, maxVisible } = args;
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const pane = new (borderedOverlay())(theme, { title, subtitle, help });
    const list = buildSelectList(theme, items, maxVisible ?? 10);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    pane.addChild(list);
    return {
      render: (w: number) => pane.render(w),
      invalidate: () => pane.invalidate(),
      handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
    };
  }, { overlay: true, overlayOptions: DEFAULT_OVERLAY_OPTIONS });
}

export function setAboveEditorWidget(ctx: ExtensionContextLike, key: string, lines: string[] | undefined): void {
  if (!lines || lines.length === 0) {
    ctx.ui.setWidget(key, undefined);
    return;
  }
  ctx.ui.setWidget(key, lines, { placement: "aboveEditor" });
}

/** Set a widget rendered below the editor (between editor and input box). */
export function setBelowEditorWidget(ctx: ExtensionContextLike, key: string, lines: string[] | undefined): void {
  if (!lines || lines.length === 0) {
    ctx.ui.setWidget(key, undefined);
    return;
  }
  ctx.ui.setWidget(key, lines, { placement: "belowEditor" });
}

export function clearStatus(ctx: ExtensionContextLike, key: string): void {
  ctx.ui.setStatus?.(key, undefined);
}

export function setColoredStatus(ctx: ExtensionContextLike, key: string, color: ThemeColor, text: string | undefined): void {
  if (!text) {
    clearStatus(ctx, key);
    return;
  }
  const theme = ctx.ui.theme;
  ctx.ui.setStatus?.(key, theme ? theme.fg(color, text) : text);
}

export function badge(theme: ThemeLike, color: ThemeColor, label: string): string {
  return theme.fg("dim", "[") + theme.fg(color, label) + theme.fg("dim", "]");
}

export function widgetHeader(theme: ThemeLike, title: string, color: ThemeColor, segments: Array<string | undefined>): string {
  return [theme.fg(color, title), ...segments.filter((s): s is string => Boolean(s))].join("  ");
}

export function keyHelpClose(back = false): string {
  return back ? "↑↓ navigate  •  enter select  •  esc back" : "↑↓ navigate  •  type to filter  •  enter select  •  esc cancel";
}
