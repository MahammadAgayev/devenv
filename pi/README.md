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
resource type — `registry.ts`/`agents.ts` find it via `lib/paths.ts`, which
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
register their `/…` commands; `/agent` + `/agents` come from `agents.ts`. Paths
resolve relative to the installed package (see `lib/paths.ts`), so it works from
the clone without any symlinks. Run `pi update --all` to pull updates.

**Settings/models are NOT part of the package** — `settings.uber.json` /
`models.uber.json` carry Uber-specific bits (`apiKeyHelper`, gateway env, bazel
perms, `code-mcp`). Copy the parts you want into your own
`~/.pi/agent/settings.json`. Minimum useful keys: `theme` (e.g. `rose-pine-moon`
or `tokyonight-night`) and `defaultThinkingLevel`. Use `pi config` to
enable/disable individual resources from the installed package.

## The capability / agent extensions

Three standalone top-level extensions (each auto-loaded on its own, matching the
rest of `extensions/`), sharing implementation in `lib/agents/`:

```
extensions/
├── registry.ts       # /<prompt> and /<agent> capabilities (/simplify, /review…)
├── agents.ts         # /agent + /agents background jobs
├── readonly-bash.ts  # global read-only shell tool
└── lib/agents/       # capabilities, job-manager, rpc-agent, spinner
```

## Capability registry

Each `registry/*.md` is one capability with a neutral instruction body. Frontmatter
marks how it's exposed — the body is the single source of truth for both flavors:

```yaml
---
name: explore
prompt: explore              # → /explore   expands the body in-context
agent:  explorer             # → /agent explorer   runs in the background (agents.ts)
tools:  read,grep,find,ls,readonly_bash   # agent tool allowlist
model:  <optional override>
---
<instructions>
```

Add a capability = drop one file. Give it a `prompt:` for the in-context command,
an `agent:` to make it runnable in the background, or both.
Current: `simplify`/`simplifier`, `review`/`reviewer`, `explore`/`explorer`,
`general` (agent-only, full toolset — an autonomous delegate that can edit/run, not
just investigate), and `tdd` (prompt-only — the red→green loop reference).

`registry.ts` registers only the **prompt** commands (`/simplify`, `/review`, …).
Agents are never blocking — they run exclusively in the background (see below).

## Background agents (`/agent`, `/agents`)

Agents run only as background jobs — fire them, keep working, watch and steer them
— via `agents.ts`:

- `/agent <name> <question>` — starts a background job and returns instantly (tab
  completes the agent name). Fire several; pi stays interactive. A live widget
  above the editor shows each job (`⠹ j1 reviewer (0:42) → readonly_bash`).
- `/agents` — inspect jobs: view output, inject a result (or **inject all**) into
  chat, **ask/steer** a running job, or cancel it (cancelled jobs stay listed as
  `⊘` until tidied).
- `/agents cancel-all` — stop everything.
- `/agents tidy` — clear all finished jobs (done/failed/cancelled) from the list.

Results are delivered with `deliverAs: "nextTurn"` — they surface the next time you
send a message, never interrupting mid-thought.

Each job is a persistent `pi --mode rpc` child (see `lib/agents/rpc-agent.ts`), so
jobs are truly concurrent and steerable mid-run.

## readonly_bash

A global tool (main session + all agents) that runs only non-destructive shell
commands, gated by the same `isSafeCommand` allowlist as plan mode. Agents list
`readonly_bash` instead of `bash`. (TODO: route plan-mode's bash gate through it.)
