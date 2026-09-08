# statusline

Oh My Pi's status bar and input-box styling, ported to stock `pi`.

Two pieces of OMP's TUI, rebuilt on stock pi's public extension API:

1. **Status bar** — a segmented powerline bar (model, thinking level, path, git
   branch, tokens, cost, context %) with a live **context-usage gauge** filling
   the space between the left and right groups.
2. **Composer shapes** — restyles the input box, including OMP's default
   flush-left `band` and a `compact` layout variant.

Both render through a `CustomEditor` subclass. Stock pi's editor already emits a
top rule, content rows, and a bottom rule, so the shape layer rewrites those
rows instead of reimplementing text layout.

## Config

No config file. Settings are the `CONFIG` constant at the top of `index.ts` —
edit it directly. Colors always come from pi's active theme.

| Key | Default | Meaning |
|---|---|---|
| `shape` | `borderless` | `borderless` · `band` · `box` · `field` · `rail` |
| `nerdFont` | `true` | Use Nerd Font glyphs. Set `false` for pure ASCII. |
| `transparent` | `true` | No filled backgrounds; segments colored on the terminal background |
| `statusPosition` | `above` | `above` · `below` — where the detached bar sits (shapes with no attached status) |
| `separator` | `powerline-thin` | `powerline` · `powerline-thin` · `slash` · `pipe` · `block` · `none` · `ascii` |
| `contextLine` | `embedded` | Gauge mode: `off` · `percentage` · `annotated` · `embedded` |
| `compact` | `false` | Compact mode — see below |
| `compactionThreshold` | `80` | Percent at which auto-compaction fires; drives the gauge ticks |
| `left` | `model`, `thinking`, `path`, `git` | Segment order, left group |
| `right` | `status`, `tokens`, `cost`, `context` | Segment order, right group |

Segments: `model`, `thinking`, `path`, `git`, `context`, `cost`, `tokens`,
`session`, `time`, `status`.

### Shapes

- **`borderless`** — thick `▌ ` bar as the prompt, no chrome above or below,
  status bar detached above. Neovim-like, and this extension's default.
- **`band`** — status line as a flush-left powerline band above a `╰─ ` prompt.
  OMP's own default.
- **`box`** — rounded frame with the status line embedded in the top border.
- **`field`** — one-line filled field with `▐`/`▌` accent end caps.

The `borderless` prompt glyph is `▌` (U+258C, Block Elements) — plain Unicode,
no Nerd Font required.
- **`rail`** — single `▎` accent rail down the left edge.

### Compact mode

`"compact": true` trades detail for width: fewer segments (`model`+`git` /
`cost`+`context`), shorter numbers, a shortened path, and a plain `percentage`
gauge instead of the embedded one. Any key you set explicitly still wins over
the compact preset.

### Context gauge

The connector between the two segment groups is a live gauge of context usage.

- `off` — plain rule
- `percentage` — used portion colored, remainder dimmed
- `annotated` — adds ticks at the speculative and auto-compaction boundaries
- `embedded` — annotated, plus the percentage rendered inside the gauge

The used portion escalates `accent` → `warning` (70%) → `error` (90%).

## Transparent mode

On by default, and the reason the bar is readable.

Stock pi themes define **foreground colors only** — there is no status-line
palette. A filled powerline bar therefore has to invent segment backgrounds out
of those foreground colors, and the theme's `text` color then lands on top of
them at near-zero contrast. On `rose-pine-moon` that measured **1.24:1** for the
model segment (4.5:1 is the readable threshold); six of eight segments were
effectively invisible.

Transparent mode drops backgrounds entirely and paints each segment in its own
color on the terminal background. Same color coding, but every segment now
measures **4.86:1 or better**. Set `"transparent": false` for the filled
powerline look — expect it to need a theme with a real status-line palette.

## Nerd Font

Defaults to Nerd Font glyphs (powerline arrows `\ue0b0`-`\ue0b3`, the rounded
cap `\ue0b6`, and segment icons). Ghostty embeds Symbols Nerd Font 3.4.0, so
these render as-is. On a terminal without one, set `"nerdFont": false` — the
box-drawing and block characters used by the shapes (`╭ ╰ │ ▐ ▌ ▎`) — including
the `borderless` prompt bar — are plain
Unicode and need no special font.

## Notes

- Replaces pi's built-in footer (`ctx.ui.setFooter`), so it does not double up.
  Statuses other extensions publish via `ctx.ui.setStatus()` appear in the
  `status` segment.
- Colors come from the active pi theme, so it re-themes automatically. Stock
  themes have no dedicated status-line palette, so segment backgrounds are
  derived from the theme's foreground colors.
- When the terminal is too narrow, segments are dropped in a fixed priority
  order (`time` first, `model` last); the final survivor is truncated rather
  than dropped, so the bar is never empty.
