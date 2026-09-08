# Pi Harness Plan

A long-running-agent harness as a native pi extension, activated by `/harness`.

**Status:** planned, nothing built. Every API claim below was checked against
pi 0.84.3 on disk (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`)
— file:line cited. Nothing here is assumed from Claude Code's equivalent.

## Goal

Let pi work unattended toward a success criterion across many context windows,
the way Anthropic's published harnesses do: fresh context per iteration, an
external oracle deciding done-ness, and durable state on disk so no session
carries the project in its head.

`/harness start` activates. `touch AGENT_STOP` halts. `STEER.md` redirects
mid-run without a restart. `/harness recap` says where the run is in two
sentences, without spending the main context to find out.

**First target:** a throwaway greenfield project, oracle = `pytest -x -q`,
spec = `feature_list.json` with everything `false`. Deliberately low-stakes —
validate the loop mechanics before pointing it at `~/devenv/pi` or a work repo.

## Background

Three Anthropic write-ups converge on the same five parts. Worth reading before
building, because each part encodes an assumption about model limits that goes
stale:

- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — initializer/coding split, `claude-progress.txt`, default-FAIL feature list
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) — planner/generator/evaluator, sprint contracts, evaluator calibration
- [Long-running Claude for scientific computing](https://www.anthropic.com/research/long-running-Claude) — `CHANGELOG.md` as lab notes, test oracle, git as monitoring, Ralph loop
- [anthropics/cwc-long-running-agents](https://github.com/anthropics/cwc-long-running-agents) — reference hooks; "example ingredients, not a turnkey harness"

The five parts, and where each already exists here:

| Part | Status in this setup |
|---|---|
| Instructions file | `AGENTS.md` / `CLAUDE.md` — exists |
| Persistent memory | `~/.pi/tasks/*.md` via `/handoff` — exists, needs to become automatic |
| Test oracle | **missing** — the load-bearing part |
| Git as monitoring | convention only, needs a commit-on-settle backstop |
| The loop | **missing** — this plan |

Note what the FLT run actually did, since it is the headline example and it is
*not* this shape: dozens of parallel agents coordinated by an external DAG
(Prove2Me), because 30,300 theorems are near-independent and Lean is a perfect
oracle. The first attempt failed exactly because agents held state locally.
Sequential-with-resets is the right shape for coupled work; parallel-with-shared-DAG
for decomposable work. Pick by coupling, not ambition.

## Verified API findings

These four determine the architecture.

**1. `tool_call` can block — this is the PreToolUse equivalent.**
`pi.on("tool_call")` returns `{ block: true, reason }`, and mutating
`event.input` rewrites args before execution. Already proven in
`extensions/tool-call-guard.ts`; the harness gate copies that wiring verbatim.

**2. `newSession()` is NOT on the event context.**
`dist/core/extensions/types.d.ts:209-249` — `ExtensionContext` has
`getContextUsage()`, `compact()`, `isIdle()`, `abort()`, but no `newSession()`.
That lives on `ExtensionCommandContext` (`:254-266`), commented *"session
control methods only safe in user-initiated commands."*

So the obvious design — drive the loop from `agent_settled` — **cannot reset
context**. It can only `compact()`, and Anthropic's finding is that compaction
is insufficient because it "doesn't give the agent a clean slate."

**3. Session replacement invalidates captured context.**
`docs/extensions.md:1242-1290`. After `newSession()`, old `pi` / `ctx` objects
are stale and throw. `withSession` runs *after* the old extension instance's
shutdown cleanup. Only plain data (strings, ids, serialized config) survives.

**4. `withSession` hands back a fresh command-capable context.**
`ReplacedSessionContext extends ExtensionCommandContext`, with bound async
`sendUserMessage()`. This is the escape hatch that makes (2) survivable.

## Architecture: recursive command-context loop

The `/harness` handler receives an `ExtensionCommandContext` and **never
returns** for the duration of the run. Iterations run inside it. When context
pressure crosses the threshold, it calls `newSession()` and re-enters itself
with the fresh ctx from `withSession` — recursion depth equals reset count.

This respects the footguns by construction: each level only ever touches the
ctx it was handed.

```
/harness start
  └─ runLoop(ctx)                      ← ExtensionCommandContext
       repeat:
         pi.sendUserMessage(prompt)
         await ctx.waitForIdle()
         verdict = oracle()            ← shell exit code, not model opinion
         if verdict.done      → stop
         if AGENT_STOP exists → stop
         if usage > threshold → ctx.newSession({
                                   setup:       seed handoff summary,
                                   withSession: c => runLoop(c)   ← recurse
                                 })
                                 return
```

All loop state lives in `.harness/state.json` on disk, never in closure scope —
requirement of finding (3), and it also makes `/harness start` resumable after
a crash or a `/reload`.

### Why not the external `while` wrapper

Considered and rejected for v1: it survives crashes and matches the published
pattern, but it spawns a process per iteration and cannot read
`getContextUsage()`, so resets become guesswork. The in-process design resets
*deliberately at a threshold* — which is the actual prescription, and something
Claude Code's hook model cannot do from inside. Keep the pieces decoupled enough
that an external wrapper stays possible if the recursion proves fragile.

## File layout

```
~/devenv/pi/extensions/harness/
  index.ts        entry; registers command + events; CONFIG constant
  state.ts        .harness/state.json read/write; the only cross-session memory
  loop.ts         runLoop(ctx) — iteration, reset, recursion
  oracle.ts       shell oracle runner + fresh-context evaluator dispatch
  gate.ts         tool_call default-FAIL enforcement
  control.ts      AGENT_STOP kill switch, STEER.md injection
  recap.ts       /harness recap — transcript dump + fresh-context agent
  prompts.ts      iteration prompt + handoff-seed templates
  README.md       matching the statusline/agents extensions
```

Per-project, created by `/harness init`:

```
.harness/
  state.json         iteration count, session chain, last verdict
  feature_list.json  the contract; every entry starts { "passes": false }
  PROGRESS.md        lab notes — status, done, dead ends
AGENT_STOP           presence halts every tool call
STEER.md             injected once, then cleared
```

Config is a typed `CONFIG` constant in `index.ts`, no config file — same
decision as `statusline/`, so a bad value is a compile error not a silent
fallback.

## Recap and status

Two different problems, so two different mechanisms. Merging them would make the
cheap one expensive.

### `/harness status` — deterministic, no model

Reads `.harness/state.json` and `feature_list.json` and prints them. Iteration
count, features passing/total, last verdict, session-chain depth, whether
`AGENT_STOP` is present. No LLM call, instant, free, correct by construction.

```
harness: iteration 14 · 7/12 passing · last verdict NEEDS_WORK · 3 resets
```

### `/harness recap` — forked context, two sentences

The question `status` cannot answer is *what is actually going on* — which needs
the transcript, and reading a transcript into the live session is the one thing a
long-running harness must not do. So copy `/handoff` exactly
(`extensions/task-handoff.ts`), which already solves this:

1. `ctx.sessionManager.buildContextEntries()` → dump the transcript
2. Truncate long tool results — "the bulk of a transcript and the least of its
   meaning" (`task-handoff.ts:82`)
3. Write to a temp file, `mode: 0o600`
4. `runAgentHeadless()` with a `recap` agent that reads the file and returns prose
5. Print the returned text; the main context grows by one short line

Note this is *not* `ctx.fork()`. Forking replaces the live session, which is the
opposite of what is wanted here — the run must continue undisturbed. The isolation
comes from the subagent's own context window. `task-handoff.ts:17` states the
reason plainly: otherwise you pay for the context window twice over.

Same mid-turn guard as `/handoff` (`:208`) — fired during a turn, the transcript
stops at the in-flight tool call, so wait for idle first.

**Two sentences is a hard cap, enforced in three places** — models do not respect
soft length requests:

- `~/devenv/pi/agents/recap.md` frontmatter: `tools: read` only, and a system
  prompt whose entire job is brevity
- The dispatch prompt states the cap as a contract, not a preference
- `recap.ts` truncates at the second sentence boundary if the agent overruns

What the two sentences must carry: what it is working on now, and what is in its
way. Not a list of completed features — `status` already has those, and a recap
that recites them is noise.

Reuses `scout`'s cheap pinned model, not the session model.

## Phases

Each phase ships something verifiable on its own. Verify in a real pty, not by
reading the code — same discipline as the statusline port.

### Phase 1 — state + command skeleton
`/harness init|start|stop|status|recap`. Writes and reads `.harness/state.json`.
No loop yet; `start` sends one prompt and stops.

`status` and `recap` both land here — neither depends on the loop or the oracle,
and having them from the start makes every later phase observable. `recap` needs
`~/devenv/pi/agents/recap.md` plus `runAgentHeadless()` from `extensions/agents/`,
which already exists.

*Verify:* `/harness init` in a scratch dir creates the files; `/harness status`
reports iteration 0; state survives `/reload`. `/harness recap` returns at most
two sentences and adds no more than one line to the live context — check
`ctx.getContextUsage()` before and after. Overrun the agent deliberately (ask it
for five sentences) and confirm `recap.ts` still truncates to two.

### Phase 2 — oracle
`oracle.ts` runs the configured shell command, parses exit code plus
`feature_list.json`, returns `{ done, failing[], output }`. Pure function over
(command, file) so it is unit-testable.

*Verify:* a scratch project with 3 features, 1 passing — oracle reports 2
failing. Flip a test to green; oracle reflects it.

### Phase 3 — the loop
`runLoop(ctx)` with `waitForIdle()` + `sendUserMessage()`, no resets yet.
Stops on done, on `AGENT_STOP`, or at `maxIterations`.

*Verify:* a 3-feature project runs to all-green unattended. `touch AGENT_STOP`
mid-run halts within one tool call.

### Phase 4 — context reset (the risky one)
Add the `newSession()` recursion and the handoff seed. `setup` seeds the new
session with the PROGRESS.md summary; `withSession` re-enters `runLoop`.

*Verify:* force a low threshold (~10%) so resets fire every iteration or two.
Confirm the chain does not throw stale-ctx errors, state survives each hop, and
the session chain is recorded. **This is where it breaks if it breaks** — if
recursion proves fragile, fall back to the external wrapper for resets and keep
the in-process loop for the non-reset path.

### Phase 5 — gate, evaluator, steer
- `gate.ts`: `tool_call` denies writes to `feature_list.json` unless an evidence
  file was read this iteration. Better still, per the cwc README: have the
  *harness* write `passes: true` on evaluator PASS, never the builder. Then
  "all true" means independently confirmed by construction and the gate is a
  backstop rather than the mechanism.
- Evaluator: `runAgentHeadless()` from `extensions/agents/` with a no-write
  `evaluator.md` in `~/devenv/pi/agents/`. Reviews the diff from a context that
  never saw the build.
- `control.ts`: `before_agent_start` injects `STEER.md` then clears it.
- `agent_settled`: commit whatever is uncommitted, as a backstop.

*Verify:* builder cannot flip a feature by hand. Evaluator catches a
deliberately broken feature and its findings appear in the next prompt.
`STEER.md` redirects mid-run and is consumed exactly once.

## Related: the subagent-dispatch bug

Separate from the harness but found while surveying, and worth fixing first
because it is small and the harness will lean on subagents.

`extensions/agents/index.ts:477-483` registers `agent` with a **static**
description listing only agent *names*. `discoverAgents()` runs inside
`execute()` — after dispatch — so the `description:` frontmatter you wrote for
each agent never reaches the calling model. `formatAgentList()` already
produces the right string but is only used in the error path.

Two fixes:

1. **Build the description at registration** from `discoverAgents()`, so real
   per-agent descriptions land in the tool schema. ~20 lines. Strictly correct
   regardless of anything else here.
2. **A delegation policy, not a number.** A `/subagent-use high` knob is
   worthless on its own — nothing reads it and a model cannot act on "high."
   The working version is `before_agent_start` appending a policy paragraph to
   the system prompt ("before any multi-file search, dispatch `scout`"), with a
   `/delegate off|normal|aggressive` command swapping which paragraph is
   injected. That is a real lever on the same intent.

## Open questions

- Does `waitForIdle()` resolve correctly when the agent hits a permission
  prompt? If it hangs there, unattended runs stall silently. Needs a pty test
  before Phase 3 is called done.
- Is `getContextUsage()` populated on the first turn of a fresh session, or only
  after an assistant response with usage? Docs say it estimates trailing
  messages, so probably fine — confirm before trusting the threshold.
- Recursion depth on a long run: 50 resets is 50 nested closures. Probably fine,
  but if it leaks, the external wrapper is the fallback.
- `agent_settled` fires per low-level run and pi may auto-retry. Confirm it is
  not double-firing the commit backstop.

## Log

- 2026-09-08 — Plan drafted. APIs verified against pi 0.84.3; no code written.
- 2026-09-08 — Added `/harness recap|status`. Split deterministic status from
  forked-context recap after checking `/handoff`: it does not use `ctx.fork()`,
  it dumps the transcript to a temp file and hands it to a headless subagent.
  Recap copies that. Two-sentence cap enforced in three places.
