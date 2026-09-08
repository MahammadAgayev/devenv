# agents

Subagents for pi. Registers one tool, **`agent`**, that spawns a separate `pi`
process per invocation so the work happens in its own context window and only
the conclusion comes back.

Adapted from pi's bundled subagent example harness; the agent prompts are ported
from Oh-My-Pi.

## Where agents live

Definitions are `.md` files in **`~/devenv/pi/agents/`**, which
`ansible/configure.yml` symlinks onto `~/.pi/agent/agents`. That is the single
home for them — the extension ships no agents of its own.

| Agent | Purpose | Tools |
|---|---|---|
| `scout` | Fast read-only codebase recon; compressed findings | read, grep, find, ls |
| `reviewer` | Code review for quality and bugs on a diff | read, grep, find, ls, bash |
| `security-reviewer` | Read-only vulnerability discovery | read, grep, find, ls |
| `task` | General-purpose worker, full tool access | read, write, edit, bash, ls, find, grep |
| `sonic` | Cheap mechanical lookups | read, grep, find, ls |
| `handoff` | Writes `~/.pi/tasks/*.md` from a session transcript (used by `/handoff`) | read, write, ls, find, grep |

`scout` and `sonic` are pinned to a cheap model. The rest inherit the calling
session's model and thinking level.

## Using them

You don't call the tool directly — ask in prose and the model dispatches:

```
use scout to map how auth flows through this repo
have reviewer look at the current diff
run security-reviewer over the payment module
use sonic to count which files import lodash
```

Three modes, picked by the model from how you phrase it:

- **single** — one agent, one task.
- **parallel** — several at once. *"review this diff with reviewer and
  security-reviewer in parallel"*. Max 8 tasks, 4 concurrent.
- **chain** — output of each step feeds the next via a `{previous}` placeholder.
  *"scout the payment module, then have task fix what it finds"*.

Each subagent gets a fresh context window, so a chain of four does not
accumulate in yours.

## Adding or overriding an agent

Drop a `.md` in `~/devenv/pi/agents/`:

```markdown
---
name: my-agent
description: One line. This is what the dispatching model matches against.
tools: read, grep, find, ls
model: claude-sonnet-5-thinking   # optional; omit to inherit the session's
---

System prompt body.
```

`description` is the only thing the calling model sees when choosing, so make it
say when to reach for this agent. Omit `tools` for full access — for a read-only
agent, listing them is the enforcement.

Precedence, lowest first: `~/.pi/agent/agents/` (the symlink) → `<repo>/.pi/agents/`.
A project-local agent overrides a global one of the same name, but only with
`agentScope: "both"` or `"project"` — the default scope is `"user"`.

## Notes on the port

- Dropped OMP frontmatter with no stock-pi equivalent: `spawns`, `thinking-level`,
  `blocking`, `prewalk`, `advisor`, `autoloadSkills`, `read-summarize`.
- Structured `output:` schemas (used by `reviewer` and `security-reviewer`) became
  prose descriptions of the same markdown shape, since pi's harness has no
  structured-output support.
- `glob` → `find`. `web_search`, `lsp`, `ast_grep` dropped.
- OMP model aliases (`@smol`, `@task`, `@slow`) don't resolve here; agents use real
  model IDs or inherit.
- `sonic` is read-only here. In OMP it inherited the full worker toolset, which
  made it a `task` clone.

## Programmatic use

`runAgentHeadless()` runs one agent and returns its final text — no TUI, no
streaming. `/handoff` uses it to spawn the `handoff` agent. See
`../task-handoff.ts`.
