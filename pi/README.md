# pi config (devenv)

A pi package. Loaded via the `"~/devenv"` entry in `packages` (see
`settings.*.json`) — not symlinked. `ansible/configure.yml` still symlinks the
top-level config files (settings/models/keybindings/AGENTS.md).

## Layout

| Folder | Loaded as | What |
|--------|-----------|------|
| `extensions/` | package extensions | TypeScript extensions (tools, commands, UI) |
| `registry/` | resolved by extensions | Capability library — one file, exposed as prompt and/or subagent |
| `skills/` | package skills | Skills (auto-discovered by intent) |
| `themes/` | package themes | Color themes |

The repo root `package.json` declares the `pi` manifest
(`extensions`/`skills`/`themes` under `pi/`). `registry/` isn't a native pi
resource type — `registry.ts`/`subagent/` find it via `lib/paths.ts`, which
resolves module-relative so it works both as a package and symlinked.

`settings.uber.json` / `models.uber.json` symlink to `settings.json` / `models.json`
on the `uber` profile (`settings.json` / `models.json` on `personal`). Both list
`"~/devenv"` in `packages`, which is what loads everything above.

Run `/reload` in pi after editing to apply without restarting.

## Using this config elsewhere

The `pi/` directory is a pi package (manifest in the repo-root `package.json`),
so installing it is one command — no cloning-for-ansible, no symlinks:

```bash
pi install git:github.com/MahammadAgayev/devenv
```

This clones the repo under `~/.pi/agent/git/…` and loads `pi/extensions`,
`pi/skills`, and `pi/themes`. Extensions auto-load; registry capabilities
register their `/…` commands; the `subagent` tool comes from `subagent/`. Paths
resolve relative to the installed package (see `lib/paths.ts`), so it works from
the clone without any symlinks. Run `pi update --all` to pull updates.

**Settings/models are NOT part of the package** — `settings.uber.json` /
`models.uber.json` carry Uber-specific bits (`apiKeyHelper`, gateway env, bazel
perms, `code-mcp`). Copy the parts you want into your own
`~/.pi/agent/settings.json`. Minimum useful keys: `theme` (e.g. `rose-pine-moon`
or `tokyonight-night`) and `defaultThinkingLevel`. Use `pi config` to
enable/disable individual resources from the installed package.

## The capability / subagent extensions

Standalone top-level extensions (each auto-loaded on its own, matching the rest
of `extensions/`):

```
extensions/
├── registry.ts       # /<prompt> capabilities (/simplify, /review, /explore, /tdd)
├── subagent/         # the `subagent` tool (single / parallel / chain), registry-backed
├── readonly-bash.ts  # global read-only shell tool
└── lib/agents/       # capabilities.ts — the shared registry reader
```

## Capability registry

Each `registry/*.md` is one capability with a neutral instruction body. Frontmatter
marks how it's exposed — the body is the single source of truth for both flavors:

```yaml
---
name: explore
prompt: explore              # → /explore   expands the body in-context
agent:  explorer             # → callable via the subagent tool (name: explorer)
description: <one-liner>     # required to be callable as a subagent
tools:  read,grep,find,ls,readonly_bash   # subagent tool allowlist
model:  <optional override>
---
<instructions>
```

Add a capability = drop one file. Give it a `prompt:` for the in-context command,
an `agent:` + `description:` to make it callable as a subagent, or both.
Current: `simplify`/`simplifier`, `review`/`reviewer`, `explore`/`explorer`
(explore is prompt+read-only recon), `scout`, `plan`/`planner`, `work`/`worker`
(subagent-only), and `tdd` (prompt-only — the red→green loop reference).

`registry.ts` registers only the **prompt** commands (`/simplify`, `/review`, …).
The subagent flavor is served by the `subagent` tool (see below).

## Subagents (the `subagent` tool)

Ported from pi's official subagent example, adapted to source agents from the
capability registry instead of `~/.pi/agent/agents/`. The model calls the
`subagent` tool to delegate work to a blank-context `pi` subprocess:

- **single** — `{ agent, task }`: one agent, one task.
- **parallel** — `{ tasks: [{agent, task}, …] }`: up to 8 tasks, 4 concurrent,
  streamed side by side.
- **chain** — `{ chain: [{agent, task}, …] }`: sequential, with a `{previous}`
  placeholder that injects the prior step's output.

Each run streams tool calls + text live, tracks usage (turns/tokens/cost),
propagates Ctrl+C to kill the subprocess, and renders the final output as
Markdown in the expanded (Ctrl+O) view. A registry file is callable as a
subagent when it has both `agent:` and `description:` frontmatter; the callable
name is the `agent:` value. See `subagent/agents.ts` for discovery.

## readonly_bash

A global tool (main session + all agents) that runs only non-destructive shell
commands, gated by the same `isSafeCommand` allowlist as plan mode. Agents list
`readonly_bash` instead of `bash`. (TODO: route plan-mode's bash gate through it.)
