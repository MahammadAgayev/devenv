# pi config (devenv)

A pi package. Loaded via the `"~/devenv"` entry in `packages` (see
`settings.*.json`) — not symlinked. `ansible/configure.yml` still symlinks the
top-level config files (settings/models/keybindings/AGENTS.md).

## Layout

| Folder | Loaded as | What |
|--------|-----------|------|
| `extensions/` | package extensions | TypeScript extensions (tools, commands, UI) |
| `registry/` | resolved by extensions | Capability library — one file, exposed as prompt and/or agent |
| `skills/` | package skills | Skills (auto-discovered by intent) |
| `themes/` | package themes | Color themes |

The repo root `package.json` declares the `pi` manifest
(`extensions`/`skills`/`themes` under `pi/`). `registry/` isn't a native pi
resource type — `registry.ts`/`agent/` find it via `lib/paths.ts`, which
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
register their `/…` commands; the `agent` tool family comes from `agent/`. Paths
resolve relative to the installed package (see `lib/paths.ts`), so it works from
the clone without any symlinks. Run `pi update --all` to pull updates.

**Settings/models are NOT part of the package** — `settings.uber.json` /
`models.uber.json` carry Uber-specific bits (`apiKeyHelper`, gateway env, bazel
perms, `code-mcp`). Copy the parts you want into your own
`~/.pi/agent/settings.json`. Minimum useful keys: `theme` (e.g. `rose-pine-moon`
or `tokyonight-night`) and `defaultThinkingLevel`. Use `pi config` to
enable/disable individual resources from the installed package.

## The capability / agent extensions

Standalone top-level extensions (each auto-loaded on its own, matching the rest
of `extensions/`):

```
extensions/
├── registry.ts       # /<prompt> capabilities (/simplify, /review, /explore, /tdd)
├── agent/            # the `agent` tool family + /agent command + live widget
├── readonly-bash.ts  # global read-only shell tool
└── lib/capabilities.ts  # the shared registry reader
```

## Capability registry

Each `registry/*.md` is one capability with a neutral instruction body. Frontmatter
marks how it's exposed — the body is the single source of truth for both flavors:

```yaml
---
name: explore
prompt: explore              # → /explore   expands the body in-context
agent:  explorer             # → callable via the `agent` tool (name: explorer)
description: <one-liner>     # required to be callable as an agent
tools:  read,grep,find,ls,readonly_bash   # agent tool allowlist
model:  <optional override>   # passed through as --model to the subprocess
---
<instructions>
```

Add a capability = drop one file. Give it a `prompt:` for the in-context command,
an `agent:` + `description:` to make it callable as an agent, or both.
Current: `simplify`/`simplifier`, `review`/`reviewer`, `explore`/`explorer`
(explore is prompt+read-only recon), `scout`, `plan`/`planner`, `work`/`worker`
(agent-only), and `tdd` (prompt-only — the red→green loop reference).

`registry.ts` registers only the **prompt** commands (`/simplify`, `/review`, …).
The agent flavor is served by the `agent` tool family (see below).

## Agents (the `agent` tool family)

Background-native delegation, adapted from pi's official subagent example but
sourcing agents from the capability registry instead of `~/.pi/agent/agents/`.
One engine (`agent/runtime.ts`): each run is a blank-context `pi` subprocess
whose state is persisted to disk (`<stateRoot>/pi-bg-runs/<runId>/`) and
reconciled by pid-liveness after a soft `/reload`.

The default is **non-blocking**: `agent` returns a `runId` immediately so the
model is never parked. Six tools:

- `agent` — `{ agent, task, label?, wait?, timeoutMs? }` → launches, returns a
  `runId`. Pass `wait:true` to block and render the result inline (tool calls +
  Markdown + usage), for when you actually want the answer now.
- `agent_status` — `{ runId }` → status / turn count / elapsed.
- `agent_result` — `{ runId }` → final output (errors if still running).
- `agent_wait` — `{ runId, timeoutMs? }` → blocks until done, streaming inline.
- `agent_list` — all runs, newest first.
- `agent_kill` — `{ runId }` → cancel a running run.

**No dedicated parallel/chain mode** — the primitives compose:

- **Parallel**: call `agent` several times in one turn to fan out, then
  `agent_wait` (or `agent_result`) on each `runId`.
- **Chain**: `agent … wait:true` (or `agent` → `agent_wait`) to get step A's
  output, then call `agent` again with that output pasted into step B's task;
  repeat for N steps, stopping early if a step's status isn't `done`.

A registry file is callable when it has both `agent:` and `description:`
frontmatter; the callable name is the `agent:` value, and an optional `model:`
is passed through as `--model`. See `agent/agents.ts` for discovery.

Human surface: **`/agent`** — `list` (default), `result <runId>`, `kill <runId>`.
A live **below-editor widget** (`agent/widget.ts`) shows running agents
(`⏳ scout 0:42`) and lingers finished ones ~10s, so you can fire agents and keep
working without blocking.

A lean port of playground's bg-agent stack: kept the fire-and-forget core,
dropped the pieces that only fed the `/agents` panel and deep nesting
(observability, model aliases, the subscription bus, the parent-linked run
forest, MCP injection, detach-mid-flight). See `agent/runtime.ts`.

## readonly_bash

A global tool (main session + all agents) that runs only non-destructive shell
commands, gated by the same `isSafeCommand` allowlist as plan mode. Agents list
`readonly_bash` instead of `bash`. (TODO: route plan-mode's bash gate through it.)
