# harness

Unattended long-running agent runs. pi works toward a criterion across many
context windows: fresh context per reset, an external oracle deciding done-ness,
and durable state on disk so no session carries the project in its head.

```
/harness init [name]     create a run — asks for the goal and the validation command
/harness start [name]    run it; does not return until it ends
/harness status [name]   iteration, verdict, resets — no model call, instant
/harness recap [name]    two sentences on what is actually happening
/harness stop [name]     halt it
/harness list            every run and where it got to
```

## The idea

Three things make a run survive its own length:

1. **An oracle that is not the model.** A shell command you name at init. Exit 0
   means done. An agent asked "are you finished?" says yes; `pytest -x -q` does
   not.
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

It asks three things: a name, a one-line goal, and **the command that proves it
is done**. That last one is not optional and has no default — only you know
whether this project is `pytest -x -q`, `bun test`, or `make check`. A default
here would be a harness whose oracle measures the wrong thing, which finishes
confidently having done nothing.

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

When the validation command passes, a second agent reviews the diff from a
context that never watched the code get written. It looks for the ways a green
check lies: an assertion loosened, a function special-cased for its test, a stub
reported as an implementation.

It can send the run back with `NEEDS_WORK`, and its findings go into the next
iteration's prompt verbatim. It defaults to `NEEDS_WORK` when unsure — a false
PASS ends the run and ships incomplete work; a false NEEDS_WORK costs one
iteration. Not symmetric.

Turn it off with `useEvaluator: false` in `config.ts` if the validation command
is strict enough to stand alone.

## Why it ends

| Reason | Status |
|---|---|
| Validation passed and the evaluator agreed | `done` |
| `AGENT_STOP` appeared | `stopped` |
| Hit `maxIterations` (50) | `failed` |
| Hit `maxResets` (25) | `failed` |
| Validation command unrunnable 3× in a row | `failed` |

That last one matters: exit 126/127 means the oracle is broken, not that a test
failed. Without the distinction a typo in the validation command looks exactly
like a suite that never passes, and the run spends all 50 iterations on it.

## Configuration

`config.ts`, a typed constant — no config file, so a bad value is a compile
error rather than a silent fallback at 2am in iteration 40.

| Setting | Default | |
|---|---|---|
| `resetThresholdPercent` | 70 | context % that triggers a fresh session |
| `maxIterations` | 50 | |
| `maxResets` | 25 | also bounds recursion depth |
| `validationTimeoutMs` | 600000 | per validation run |
| `useEvaluator` | true | second-opinion review on PASS |
| `commitEachIteration` | true | monitoring backstop |

The validation command is *not* here — it is per-project, and lives in the run's
`state.json`.

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

37 tests. The unit suite covers verdict parsing, sentence truncation, output
clipping, name sanitization, and the state round-trip; the integration suite
runs the oracle against real processes.

Both suites were mutation-tested — deliberately breaking the bottom-up verdict
scan and the sentence-boundary lookahead each produced exactly one failure.

## Files

| | |
|---|---|
| `index.ts` | commands, autocompletion, `init` |
| `config.ts` | the typed `CONFIG` constant |
| `state.ts` | `~/.pi/harness/<name>/` — the only cross-session memory |
| `loop.ts` | iteration, reset, recursion, commit backstop |
| `oracle.ts` | validation command + evaluator dispatch |
| `control.ts` | `AGENT_STOP` tool-call gate |
| `recap.ts` | transcript dump + two-sentence cap |
| `prompts.ts` | iteration prompt, reset seed, closing note |

Agents live in `pi/agents/`: `recap.md`, `evaluator.md`.
