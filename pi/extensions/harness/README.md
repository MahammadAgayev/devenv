# harness

Unattended long-running agent runs. pi works toward a criterion across many
context windows: fresh context per reset, an external oracle deciding done-ness,
and durable state on disk so no session carries the project in its head.

```
/harness init [name]     create a run — asks for a name and a goal
/harness start [name]    run it; does not return until it ends
/harness status [name]   iteration, verdict, resets — no model call, instant
/harness recap [name]    two sentences on what is actually happening
/harness stop [name]     halt it
/harness list            every run and where it got to
```

## The idea

Three things make a run survive its own length:

1. **An oracle that is not the agent.** A reviewer subagent in a context that
   never watched the code get written, which must build and test the project
   itself before it may answer. An agent asked "are you finished?" says yes; one
   that has to run the suite first has something to be wrong about.
2. **Fresh context, not compaction.** At 70% context the run starts a genuinely
   new session seeded from its own notes. Compaction keeps the summary of a
   confused session; a reset does not.
3. **State on disk, never in memory.** Everything the loop needs is in
   `state.json`. A crash, a `/reload`, or a restart loses nothing.

## A run is a folder

```
~/.pi/harness/<name>/
  task.md       the contract — goal, done-when, constraints
  state.json    iteration count, session chain, verdict history
  log.md        lab notes, appended by the agent every iteration
  AGENT_STOP    presence halts the run
  STEER.md      injected once, then deleted
  …             whatever else the agent leaves behind
```

Runs live under `~/.pi/`, not in the project. A run outlives any one checkout,
two projects can have runs going at once, and — the practical reason — the
commit backstop would otherwise keep committing the harness's own logs into the
repo it is working on.

`task.md` is worth editing before you start. It is re-read at the top of every
iteration, and it is the only thing standing between a long run and drift.

## Getting started

```
/harness init auth-refresh
```

It asks two things: a name and a one-line goal.

It used to ask for a third — a validation command, exit 0 means done — and
require it. The idea was sound (a shell exit code is not a model judgement) and
the mechanism was not: it demanded a single command before the work existed,
which many tasks do not have. Answered with prose rather than a command, a run
spent every iteration on exit 127 and measured nothing.

So if there is a command that proves this task is done, put it in `task.md`. The
reviewer reads the task and is told to prefer a command named there over
anything it infers. If there isn't one, say how the project is normally built
and tested, and it will work that out for itself.

Then sharpen `task.md`, and:

```
/harness start
```

The session drives the run until it finishes. Leave it alone.

## Stopping and steering

```bash
touch ~/.pi/harness/<name>/AGENT_STOP        # halt at the next tool call
$EDITOR ~/.pi/harness/<name>/STEER.md        # redirect without restarting
```

`/harness stop` does the first for you. The stop is checked in two places: the
loop checks between iterations for a clean exit, and a `tool_call` handler
blocks mid-iteration so a stop lands in seconds rather than after a long turn.

`STEER.md` is consumed on read — it lands at the top of the next iteration's
prompt exactly once, then the file is deleted. Left in place it would be
re-injected forever and the agent would keep obeying a correction long after
making it.

## status vs recap

Two different questions, deliberately two mechanisms.

`status` reads `state.json` and prints it. No LLM call, instant, free, correct
by construction:

```
harness "auth-refresh" · running · iteration 14 · last verdict FAIL · 3 resets
```

`recap` answers what `status` cannot — *what is it actually doing* — which needs
the transcript. Reading a transcript into the live session is the one thing a
long-running harness must not do, so it dumps the transcript to a temp file and
hands it to a headless subagent. The main context grows by one line.

The two-sentence cap is enforced three times, because models do not respect soft
length requests: in the agent's system prompt, in the dispatch prompt, and by
`truncateToSentences` in `recap.ts`, which is the one that actually guarantees it.

## The evaluator

Every iteration, an agent reviews the work from a context that never watched the
code get written. It is the entire oracle, so its prompt spends most of its
length on one instruction: establish the facts before judging. Find how the
project builds and tests, run that, report what it printed. A tree that does not
build is `NEEDS_WORK` however well the code reads.

Then it looks for the ways work can look finished without being finished: an
assertion loosened, a function special-cased for its test, a stub reported as an
implementation.

It can send the run back with `NEEDS_WORK`, and its findings go into the next
iteration's prompt verbatim. It defaults to `NEEDS_WORK` when unsure — a false
PASS ends the run and ships incomplete work; a false NEEDS_WORK costs one
iteration. Not symmetric.

A reviewer that *cannot be dispatched* is a third case, `ERROR`, and not a
verdict at all: nothing was measured, so the loop stops after
`maxEvaluatorErrors` of them rather than burning fifty iterations on a broken
subagent.

## Why it ends

| Reason | Status |
|---|---|
| The reviewer said PASS | `done` |
| `AGENT_STOP` appeared | `stopped` |
| Hit `maxIterations` (50) | `failed` |
| Hit `maxResets` (25) | `failed` |
| Reviewer undispatchable 3× in a row | `failed` |

That last one matters: a reviewer that crashed is not a reviewer that said no.
Without the distinction a broken dispatch looks exactly like work that never
converges, and the run spends all 50 iterations on it.

## Configuration

`config.ts`, a typed constant — no config file, so a bad value is a compile
error rather than a silent fallback at 2am in iteration 40.

| Setting | Default | |
|---|---|---|
| `resetThresholdPercent` | 70 | context % that triggers a fresh session |
| `maxIterations` | 50 | |
| `maxResets` | 25 | also bounds recursion depth |
| `findingsClip` | 4000 | reviewer findings kept in state, in chars |
| `maxEvaluatorErrors` | 3 | consecutive undispatchable reviewers before giving up |
| `commitEachIteration` | true | monitoring backstop |

Nothing per-project is here. How the work is built and tested belongs in the
run's `task.md`, where both the agent and the reviewer read it.

## How the loop can reset its own context

`newSession()` is on `ExtensionCommandContext`, not the `ExtensionContext` that
event handlers get (`dist/core/extensions/types.d.ts:254-266` — "session control
methods only safe in user-initiated commands"). A loop driven by `agent_settled`
could only call `compact()`.

So the loop lives inside the `/harness start` command handler and never returns.
On reset it calls `newSession()` and re-enters itself with the fresh context from
`withSession`; recursion depth equals reset count.

This is also why no loop state lives in closure scope. After session replacement
the old `pi` and `ctx` throw if touched, and `withSession` runs *after* the old
extension instance's shutdown. Only plain strings cross the boundary — everything
else is re-read from disk on the other side.

## Tests

```bash
node --experimental-strip-types --test pi/extensions/harness/test/*.ts
```

No install step and no `node_modules` — the repo has none and does not need one.

That is a constraint on the code, not an accident. Every `@earendil-works`
import here is `import type`, which erases at runtime; `CONFIG_DIR_NAME` is
inlined in `state.ts` rather than imported for its value; and `runAgentHeadless`
is loaded via a deferred `await import()` in `oracle.ts` and `recap.ts`, because
a static import would drag in typebox and the pi-tui renderers that the `agent`
*tool* needs but a headless dispatch does not.

The result is that every module except the subagent call path loads standalone,
so the logic worth testing is testable. Keep it that way: a new value import
from a package would silently make this suite unrunnable again.

58 tests, covering verdict parsing, the reviewer prompt's load-bearing
instructions, sentence truncation, output clipping, name sanitization, and the
state round-trip.

Mutation-tested — deliberately breaking the bottom-up verdict scan and the
sentence-boundary lookahead each produced exactly one failure.

## Files

| | |
|---|---|
| `index.ts` | commands, autocompletion, `init` |
| `config.ts` | the typed `CONFIG` constant |
| `state.ts` | `~/.pi/harness/<name>/` — the only cross-session memory |
| `loop.ts` | iteration, reset, recursion, commit backstop |
| `oracle.ts` | reviewer prompt + dispatch + verdict parsing |
| `control.ts` | `AGENT_STOP` tool-call gate |
| `recap.ts` | transcript dump + two-sentence cap |
| `prompts.ts` | iteration prompt, reset seed, closing note |

Agents live in `pi/agents/`: `recap.md`, `evaluator.md`.
