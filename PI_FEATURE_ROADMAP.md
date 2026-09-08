# Pi Feature Roadmap

Things borrowed from a look at Oh My Pi that are worth having in plain `pi` — sorted by how much work is actually left. Oh My Pi itself was tried and reverted twice (2026-09-07); nothing here re-installs it.

**Status:** 3 package found · 1 needs custom code · 1 not started · 4 done

## Ready to install — real, maintained pi-native packages

Items 03 (Statusline) and 04 (Subagents) used to live here as npm packages. Both are now hand-ported local extensions and the packages were removed — see **Done**.


### 05. Memory / autolearn
Persistent cross-session memory with auto-consolidation and secret scanning.

```
pi install npm:pi-hermes-memory
```
Verified on npm — SQLite FTS5 search, 70+ releases. **Installed and then removed** (2026-09-08): the task-handoff docs in `~/.pi/tasks/` cover cross-session continuity, deliberately and manually, which is the wanted behaviour here. Reconsider only if that proves too coarse.

### 06. Hashline edit
Hash-anchored file edits instead of string-replace — ~61% fewer edit tokens on fast models. Full replace of the built-in edit tool is fine.

```
pi install npm:pi-hashline-edit-pro
```
Requires Node ≥22.19 — this machine runs Node 26. Satisfied.

## Needs custom code — no package does this

### 07. File compression (`omp compress`)
Checked pi-condense, pi-mega-compact, pi-caveman — all three compact **live session context**, not a file on disk. The real thing needs a hand-built pi extension: a throwaway subagent given exactly two tools.

1. Spawn an isolated session, source wrapped in a nonce-tagged block, tools limited to `rewrite` and `approve`
2. Model calls `rewrite(text, losses[])` against a dense-prompt-register system prompt; harness shows it back with token counts for review
3. Loop up to 3 rounds until `approve` — only then is the file written

## Not started

### 08. Tool output rendering
Oh My Pi's tool-call output looked cleaner. No pi package identified yet — worth another awesome-pi.site / npm sweep next time this comes up.

## Done

### 01. Nerd Font
Ghostty embeds Symbols Nerd Font 3.4.0, so Nerd Font glyphs render already — no font swap needed. `statusline` uses them by default (`"nerdFont": true`, set `false` for pure ASCII).

### 02. Input box styling + 03. Statusline
Both ported by hand from the Oh My Pi source into one local extension: `pi/extensions/statusline/`.

Powerbar (`npm:@juanibiapina/pi-powerbar`) was **removed** in favour of it — the port carries OMP's own segment chaining, overflow priority, composer shapes (`band` / `box` / `field` / `rail` / `borderless`), a compact-mode layout variant, and the context-usage gauge that powerbar has no equivalent of. Config in `statusline.json`; see that README.

Verified: typechecks against the real pi d.ts, exact-width at every terminal size, loads in pi 0.84.3.

### 04. Subagents
Harness in `pi/extensions/agents/`; agent definitions in `pi/agents/*.md`, symlinked onto `~/.pi/agent/agents` by `ansible/configure.yml`. OMP's scout / reviewer / security-reviewer / task / sonic prompts on top of pi's own bundled subagent harness (spawns a `pi` process per agent in JSON mode), plus a `handoff` agent that writes task docs.

`npm:@tintinweb/pi-subagents` was **removed** in favour of it. Exposes one tool, `agent`. OMP-only frontmatter (`spawns`, `thinking-level`, `prewalk`, `advisor`, structured `output:` schemas) was dropped; `glob`→`find`, `web_search` dropped. `scout` and `sonic` are pinned to `claude-sonnet-5-thinking` to stay cheap; the rest inherit the session model.

Verified: all 5 agents discovered with correct tools, and a live `sonic` round-trip returned through the `agent` tool in pi 0.84.3.

### 09. Java LSP / mason4agents
`npm:mason4agents` is in `pi/settings.uber.json` and installed via `ansible/install.yml`. Java LSP was already working before any of this.

---

**Oh My Pi:** tried and fully reverted twice as of 2026-09-07 — binary, bun, and the homebrew tap were uninstalled. Don't re-suggest running it; the items above go into plain pi instead.

**Housekeeping:** a stray git submodule (`playground`, someone else's personal repo) got accidentally staged in devenv during research — unstage with `git restore --staged playground` whenever convenient.

*Package names verified against the npm registry · 2026-09-07*
