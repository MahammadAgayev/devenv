/**
 * markdown-preview.ts — `/preview` command for viewing markdown files.
 *
 * Renders any markdown file in a scrollable TUI overlay using the pi-tui
 * Markdown component, with the option to open in VS Code (remote).
 *
 * Usage:
 *   /preview <path>        — render a markdown file
 *   /preview               — pick from recently written story-bundle docs
 *
 * After writing design docs / specs / plans into story bundles, skills offer
 * `/preview <path>` as the inbuilt markdown viewer. The user can then press `v`
 * to open the same file in VS Code (remote) if available.
 *
 * Scrolling (j/k, ↑↓, PgUp/PgDn, g/G) and mouse wheel are handled by the
 * shared ScrollableOverlay component.
 */

import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Markdown as MarkdownClass, MarkdownTheme } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { ScrollableOverlay } from "./lib/scrollable-overlay.ts";
import { showSelectOverlay } from "./lib/tui-shared.ts";
import { PATHS } from "../lib/paths.ts";

// Lazy-load pi-tui Markdown constructor (runtime-only, not a devDependency).
let _tui: typeof import("@earendil-works/pi-tui") | null = null;
function tui(): typeof import("@earendil-works/pi-tui") {
  if (!_tui) _tui = createRequire(import.meta.url)("@earendil-works/pi-tui");
  return _tui;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 512 * 1024; // 512 KB — refuse absurdly large files

/** Resolve a path that may be relative to cwd, ~, or absolute. */
export function resolvePath(p: string): string {
  const home = process.env.HOME || homedir();
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(process.cwd(), p);
}

/** Read a markdown file, with size and existence guards. */
export function readMarkdownFile(filePath: string): { content: string; error?: string } {
  if (!existsSync(filePath)) {
    return { content: "", error: `File not found: ${filePath}` };
  }
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return { content: "", error: `File too large (${Math.round(stat.size / 1024)}KB > 512KB limit): ${filePath}` };
  }
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") {
    return { content: "", error: `Not a markdown file (.md/.markdown): ${filePath}` };
  }
  return { content: readFileSync(filePath, "utf-8") };
}

/**
 * Find recently modified markdown files in the active story bundle's docs/
 * subdirectory, plus top-level specs/ and design/ legacy dir. Used when
 * /preview is called without arguments.
 */
export function findRecentStoryDocs(): string[] {
  const storiesDir = PATHS.storiesDir;
  if (!existsSync(storiesDir)) return [];
  const results: { path: string; mtime: number }[] = [];
  const { readdirSync } = require("node:fs");
  try {
    for (const storyId of readdirSync(storiesDir, { withFileTypes: true })) {
      if (!storyId.isDirectory()) continue;
      const storyPath = join(storiesDir, storyId.name);
      // Check docs/ (canonical), top-level specs/ (stories skill), and design/ (legacy)
      for (const subdir of ["docs/design", "docs/plans", "docs/specs", "specs", "design"]) {
        const dir = join(storyPath, subdir);
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".md")) continue;
          const fullPath = join(dir, entry.name);
          try {
            results.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs });
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* ignore */ }
  return results.sort((a, b) => b.mtime - a.mtime).slice(0, 15).map((r) => r.path);
}

/** Try to open a file in VS Code (remote). Returns true if launched. */
function openInVsCode(filePath: string): boolean {
  try {
    spawn("code", [filePath], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

// ── markdown theme (mirrors pi terminal theme) ───────────────────────────────

function buildMarkdownTheme(theme: { fg(color: string, text: string): string; bold?(s: string): string }): MarkdownTheme {
  return {
    heading: (s: string) => theme.fg("accent", theme.bold ? theme.bold(s) : s),
    link: (s: string) => theme.fg("accent", s),
    linkUrl: (s: string) => theme.fg("dim", s),
    code: (s: string) => theme.fg("warning", s),
    codeBlock: (s: string) => theme.fg("muted", s),
    codeBlockBorder: (s: string) => theme.fg("dim", s),
    quote: (s: string) => theme.fg("dim", s),
    quoteBorder: (s: string) => theme.fg("dim", s),
    hr: (s: string) => theme.fg("dim", s),
    listBullet: (s: string) => theme.fg("muted", s),
    bold: (s: string) => theme.bold ? theme.bold(s) : s,
    italic: (s: string) => s,
    strikethrough: (s: string) => s,
    underline: (s: string) => s,
  };
}

// ── preview ──────────────────────────────────────────────────────────────────

/**
 * Show a markdown file in a scrollable overlay using the shared
 * ScrollableOverlay component (handles j/k, PgUp/PgDn, g/G, mouse wheel, q/esc).
 * Press `v` to open in VS Code.
 */
async function showMarkdownPreview(ctx: ExtensionCommandContext, filePath: string, content: string): Promise<void> {
  const home = process.env.HOME || homedir();
  const shortPath = filePath.replace(home, "~");
  const Md = tui().Markdown as typeof MarkdownClass;

  const overlay = new ScrollableOverlay(ctx, {
    title: basename(filePath),
    subtitle: shortPath,
    renderContent: (width: number) => {
      // The Markdown constructor needs a theme; we build it from the overlay's
      // theme which is available after open() sets it. For the initial render
      // we use a minimal fallback theme and rebuild on invalidate.
      const mdTheme = buildMarkdownTheme(ctx.ui.theme ?? { fg: (_c: string, s: string) => s });
      const md = new Md(content, 2, 1, mdTheme);
      return md.render(width);
    },
    help: "↑↓/j/k scroll • PgUp/PgDn page • g/G top/bottom • mouse wheel • v VS Code • q/esc close",
    onKey: (data, { done }) => {
      if (data === "v" || data === "V") {
        const ok = openInVsCode(filePath);
        if (ok) {
          ctx.ui.notify("Opened in VS Code", "info");
        } else {
          ctx.ui.notify("VS Code (`code`) not available on PATH", "warning");
        }
        return true; // consumed
      }
      return false; // let default scroll keys handle it
    },
  });

  await overlay.open();
}

// ── file picker ──────────────────────────────────────────────────────────────

/** Show a file-picker overlay for recent story docs. */
async function pickRecentDoc(ctx: ExtensionCommandContext, docs: string[]): Promise<string | null> {
  const home = process.env.HOME || homedir();
  const items = docs.map((p) => {
    const shortPath = p.replace(join(PATHS.storiesDir, "/"), "");
    return { value: p, label: basename(p), description: shortPath };
  });

  return showSelectOverlay({
    ctx: ctx as any,
    title: "Recent story documents",
    subtitle: "Select a markdown file to preview",
    help: "↑↓ navigate • enter select • esc cancel",
    items,
    maxVisible: 10,
  });
}

// ── entry point ────────────────────────────────────────────────────────────────

export default function markdownPreviewExtension(pi: ExtensionAPI): void {
  pi.registerCommand("preview", {
    description: "Preview a markdown file in a scrollable viewer. Usage: /preview <path>  (or no args to pick from recent story docs)",
    handler: async (args, ctx) => {
      const argPath = (args ?? "").trim();

      // Direct path mode
      if (argPath) {
        const filePath = resolvePath(argPath);
        const { content, error } = readMarkdownFile(filePath);
        if (error) {
          ctx.ui.notify(error, "error");
          return;
        }
        await showMarkdownPreview(ctx, filePath, content);
        return;
      }

      // No-arg mode: pick from recent story docs
      const docs = findRecentStoryDocs();
      if (docs.length === 0) {
        ctx.ui.notify("No recent story documents found. Usage: /preview <path-to-file.md>", "info");
        return;
      }
      const selected = await pickRecentDoc(ctx, docs);
      if (!selected) return;
      const { content, error } = readMarkdownFile(selected);
      if (error) {
        ctx.ui.notify(error, "error");
        return;
      }
      await showMarkdownPreview(ctx, selected, content);
    },
  });
}
