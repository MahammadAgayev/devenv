# Plan Mode

Read-only exploration and design. Toggle with `/plan` or `Ctrl+Alt+P`, or start
a session in it with `--plan`.

While plan mode is on, the agent can read, search, and run read-only commands,
but cannot change anything. It investigates first, asks you about the decisions
it genuinely can't resolve alone, and writes a plan. You then choose whether to
build it.

## The question tool

Plan mode registers `plan_question`, which renders a real options UI:

```
────────────────────────────────────────────────────
 Should the retry live in the client or the caller?

 ❯ 1. Client
      One place to change; every caller inherits it.
   2. Caller
      Explicit per call site, but easy to forget.
   3. Something else…

 ↑↓ navigate • Enter to select • Esc to cancel
────────────────────────────────────────────────────
```

`↑↓` to move, `Enter` to pick, `Esc` to dismiss. "Something else…" opens an
inline editor for a free-form answer; `Esc` there goes back to the list.

The prompt tells the agent to ask **one question at a time** and to look up
facts rather than asking — only real decisions reach you, and each answer shapes
what it asks next.

Adapted from pi's own `examples/extensions/question.ts`.

## Finishing

The agent ends a finished plan with `[PLAN READY]`, which triggers a menu:

- **Build it** — leaves plan mode, restores tools, starts implementing.
- **Keep planning** — stays in plan mode to refine.
- **Exit plan mode, don't build** — leaves plan mode without doing the work.

The marker is why the menu doesn't appear after every exploratory turn: the
model decides when the plan is done, not the turn boundary.

## What's blocked

Disabled tools: `edit`, `write`, `replace`, `undo_last_replace`. Every other
active tool stays available; the snapshot taken on entry is restored on exit.

Bash is filtered through the `isSafeCommand` allowlist in `utils.ts` — the same
one behind the `readonly_bash` tool. Reads, searches, and `git log`/`status`/`diff`
pass; anything that writes, installs, or kills does not.

Enforcement is in two layers: the tools are deactivated, and `tool_call` also
blocks them, so a model working from a stale tool list gets a clear reason
rather than a silent failure.

State persists across `/resume`.
