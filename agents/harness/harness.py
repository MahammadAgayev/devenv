#!/usr/bin/env python3
"""
harness — unattended long-running agent runs.

The loop is: prompt an agent, have an independent reviewer judge the result,
repeat until PASS. It runs as its own process and talks to you through files,
so nothing here needs pi's session, event, or UI machinery.

    harness init <name>    create the run folder and a task.md to fill in
    harness start <name>   run it until PASS, STOP, or the iteration ceiling
    harness stop <name>    ask a running harness to halt after this iteration

A run is a folder under the working directory it operates on:

    <cwd>/.harness/<name>/
      task.md          the contract. Hand-edited, re-read every iteration.
      state.json       iteration, verdict, findings, history — the only state
      log.md           the agent's own lab notes, for its future self
      reviews/NNN.md   what the reviewer said, kept to read, never parsed back
      sessions/        pi's own session files
      STEER.md         you write here; consumed at the top of the next iteration
      STOP             `stop` writes this; the loop halts and deletes it

Living beside the work rather than in `~` means two checkouts can hold runs of
the same name and the run travels with the tree. It is untracked clutter in
someone's repo — add `.harness/` to `.gitignore`, or commit it deliberately as a
record of how the work was done.

`state.json` is the single source of truth. An earlier version derived
`iteration` and `lastVerdict` by counting and re-parsing `reviews/*.md`, which
existed only because two places disagreed about the count; with one writer they
cannot. The review files are still written — they are the readable record — but
nothing reads them back.

One pi session per run, and pi's own compaction handles context growth. There is
no reset machinery: it was worth its complexity on models that wrapped up work
early as their context filled, and is not on models that don't.

There is no Python SDK for pi, so this drives the `pi` CLI as a subprocess. Both
subprocesses run `--mode json` and their event streams are rendered to stdout as
they arrive, which is the only reason a run is watchable: `pi -p` in text mode
prints nothing at all until the process exits, so a 40-minute iteration is
indistinguishable from a hang.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVALUATOR = HERE / "evaluator.md"

MAX_ITERATIONS = 40
# Consecutive reviewer dispatch failures before the run gives up. A reviewer
# that crashed is not a reviewer that said no: nothing was measured, so
# iterating on it produces no signal.
MAX_REVIEW_ERRORS = 3
# The evaluator is told to build the project and run its tests, so its budget has
# to cover a cold build of whatever it is pointed at. Ten minutes did not: one run
# had a 2741s worker and a reviewer killed mid-build with nothing measured.
REVIEW_TIMEOUT_S = 60 * 60

# Fixed lists: nothing that blocks on a human, since nobody is watching.
WORKER_TOOLS = "read,bash,edit,write,grep,find,ls"
REVIEW_TOOLS = "read,grep,find,ls,bash"

# The placeholder `init` leaves in task.md, and the string `start` refuses to
# run on.
UNFILLED_GOAL = "(one paragraph — what should be true when this is done)"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_dir(name: str) -> Path:
    return Path.cwd() / ".harness" / name


def slurp(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def read_state(name: str) -> dict:
    try:
        return json.loads(slurp(run_dir(name) / "state.json"))
    except ValueError:
        return {}


def write_state(name: str, **patch) -> None:
    state = {**read_state(name), **patch, "updatedAt": now()}
    (run_dir(name) / "state.json").write_text(json.dumps(state, indent=2) + "\n")


def log(name: str, text: str) -> None:
    with (run_dir(name) / "log.md").open("a", encoding="utf-8") as f:
        f.write(f"\n- {now()} — {text}\n")


def show(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def take_steer(name: str) -> str:
    """Read STEER.md and delete it, so a steer applies exactly once."""
    p = run_dir(name) / "STEER.md"
    if not p.exists():
        return ""
    text = slurp(p).strip()
    p.unlink()
    return text


# --- talking to pi ---------------------------------------------------------


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def render(event: dict) -> str | None:
    """
    One event turned into one line worth watching, or None for the noise.

    Pure, and separate from the printing, so it can be asserted on: the failure
    this guards against is a display that floods the terminal or shows nothing,
    and both are silent in a live run.

    `message_update` is the bulk of the stream — one event per token — and is
    dropped. `turn_end` repeats the assistant message that `message_end` already
    carried, so matching it too would print every reply twice.
    """
    if event.get("type") == "tool_execution_start":
        args = event.get("args") or {}
        # The first string argument is nearly always the interesting one — a
        # path, a command, a pattern — and which key holds it varies by tool.
        detail = next((v for v in args.values() if isinstance(v, str)), "")
        one_line = " ".join(detail.split())
        return f"  · {event.get('toolName')}" + (f" {truncate(one_line, 100)}" if one_line else "")

    if event.get("type") == "message_end":
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            return None
        text = " ".join(
            p.get("text", "") for p in (message.get("content") or []) if p.get("type") == "text"
        )
        text = " ".join(text.split())
        return f"  {truncate(text, 200)}" if text else None

    return None


class Result:
    """What one pi subprocess did: its answer, and what it cost to get there."""

    def __init__(self) -> None:
        self.code = 0
        self.stderr = ""
        self.text = ""
        self.tools = 0
        self.tokens = 0
        self.seconds = 0

    def absorb(self, event: dict) -> None:
        """
        Accumulate one event.

        Rendering and accounting read the same stream in one pass. They used to
        be two functions over two copies of it, which meant the reviewer's
        verdict was parsed from a string kept in memory purely to be re-split.
        """
        if event.get("type") == "tool_execution_start":
            self.tools += 1
        if event.get("type") != "message_end":
            return
        message = event.get("message") or {}
        total = (message.get("usage") or {}).get("totalTokens")
        if isinstance(total, int) and total > self.tokens:
            self.tokens = total
        if message.get("role") != "assistant":
            return
        parts = [p.get("text", "") for p in (message.get("content") or []) if p.get("type") == "text"]
        # Only overwrite when there is prose. A trailing tool-call message would
        # otherwise blank a real verdict into a failed dispatch.
        if any(p.strip() for p in parts):
            self.text = " ".join(parts).strip()


def run_pi(args: list[str], cwd: str, timeout: float | None = None) -> Result:
    """
    Run `pi`, streaming its progress to stdout and accumulating the result.

    `stdin=DEVNULL` is load-bearing. With an inherited pipe on stdin that nobody
    ever closes, `pi -p` waits on it forever: an earlier version sat at
    "iteration 1" for three minutes having burned 0.27s of CPU.

    The timeout is a watchdog thread, not a check inside the read loop. Checking
    on each event means the deadline only fires when the subprocess says
    something, and a reviewer blocked in one long `bash` call says nothing: a 600s
    limit let a build run to 815s before the next event arrived to trip it. A
    timer fires on time whatever the child is doing.
    """
    result = Result()
    started = time.monotonic()
    proc = subprocess.Popen(
        ["pi", *args],
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        # Its own process group, so the timeout can kill the whole tree. Killing
        # just `pi` leaves the build it spawned holding the stdout pipe open, and
        # the read loop below blocks until that grandchild finishes anyway.
        start_new_session=True,
    )
    killed = threading.Event()

    def on_timeout() -> None:
        killed.set()
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()

    watchdog = threading.Timer(timeout, on_timeout) if timeout else None
    if watchdog:
        # Daemon so a wedged timer cannot hold the process open at exit.
        watchdog.daemon = True
        watchdog.start()

    for line in proc.stdout or []:
        try:
            event = json.loads(line)
        except ValueError:
            # A subprocess killed mid-write leaves a truncated last line.
            continue
        if not isinstance(event, dict):
            continue
        result.absorb(event)
        rendered = render(event)
        if rendered:
            show(rendered)

    proc.wait()
    if watchdog:
        watchdog.cancel()
    result.stderr = proc.stderr.read() if proc.stderr else ""
    result.code = 1 if killed.is_set() else (proc.returncode or 0)
    if killed.is_set():
        result.stderr += f"\nKilled after {int(timeout or 0)}s."
    result.seconds = int(time.monotonic() - started)
    return result


def evaluator_parts() -> tuple[str, str | None]:
    """The evaluator's system prompt and pinned model, from its .md frontmatter."""
    raw = slurp(EVALUATOR)
    m = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
    if not m:
        return raw, None
    model = re.search(r"^model:\s*(\S+)", m.group(1), re.M)
    return raw[m.end() :], model.group(1) if model else None


# --- prompts ---------------------------------------------------------------


def worker_prompt(name: str, state: dict, task: str, steer: str) -> str:
    """
    The per-iteration instruction.

    Re-states the task and the paths every time: even in one long session the
    task scrolls out of the useful window, and compaction may drop it.
    """
    d = run_dir(name)
    iteration = state["iteration"] + 1
    p = [f'[HARNESS · iteration {iteration} of run "{name}"]', ""]

    if steer:
        # First and unmistakable: a steer is the user interrupting, and it
        # outranks whatever the agent had planned.
        p += ["## ⚠ Course correction from the user", "", steer, ""]

    p += ["## Task", "", task.strip(), ""]
    p += ["## Where things stand", ""]
    p += [f"- Run folder: {d} — your notes and artifacts live here"]
    p += [f"- Completed iterations: {iteration - 1}", ""]

    if state["verdict"] == "NEEDS_WORK":
        p += [
            "## Reviewer findings",
            "",
            "An independent reviewer that did not watch you write this judged the work",
            "incomplete. It is the only check on this run:",
            "",
            state["findings"],
            "",
            "Address this. Do not argue with it by making the check weaker.",
            "",
        ]
    elif state["verdict"] == "ERROR":
        p += [
            "## The reviewer could not be run",
            "",
            "Nothing was judged last iteration, so this is not a verdict on your work.",
            "Carry on; the run gives up by itself if it keeps happening.",
            "",
        ]

    p += [
        "## What to do now",
        "",
        "Advance the task by one meaningful increment:",
        "",
        "1. Establish where things stand — build and test the project the way the task",
        "   says to, or the way the project itself implies.",
        "2. Pick the single most valuable thing you can finish this iteration.",
        "3. Do it, and verify it the same way.",
        f"4. Append what happened to {d}/log.md — what you tried, what the result was,",
        "   and anything a future you would need. Dead ends are worth more than",
        "   successes: they stop the next iteration repeating them.",
        "",
        "Finish your turn with one or two sentences on what you did. That summary is",
        "what the user sees — they are not reading your tool calls or log.md.",
        "",
        "Work only within the task. Do not refactor code it did not ask about. Stop when",
        "the increment is done — the reviewer decides when the run is finished, not you.",
    ]
    return "\n".join(p)


def review_prompt(name: str, cwd: str, iteration: int, task: str) -> str:
    """What the reviewer is told, on top of the evaluator agent's system prompt."""
    return "\n".join(
        [
            "Judge whether the work in this repository genuinely satisfies its task.",
            "",
            # Absolute paths, always. Without them a reviewer goes looking: one
            # real run burned 257 seconds on `find / -iname log.md`.
            f"- Repository under review: {cwd}",
            f"- The agent's own notes: {run_dir(name) / 'log.md'}",
            "",
            "Those paths are exact. Do not search the filesystem for them.",
            "",
            "## The task",
            "",
            task,
            "",
            f"This is iteration {iteration} of an unattended run. Your verdict alone",
            "decides whether it ends, and a PASS ships the work as finished.",
        ]
    )


def verdict_of(text: str) -> str:
    """
    PASS or NEEDS_WORK, read off the reviewer's reply.

    Scanned from the end: the contract asks for the verdict on the last line,
    and models routinely discuss both words before committing to one.

    Anything unreadable is NEEDS_WORK. The failure mode has to be "keeps
    working", never "stops early and claims success".
    """
    for line in reversed(text.strip().split("\n")):
        if "NEEDS_WORK" in line.upper():
            return "NEEDS_WORK"
        if "PASS" in line.upper():
            return "PASS"
    return "NEEDS_WORK"


# --- the commands ----------------------------------------------------------

TASK_TEMPLATE = """\
# Task: {name}

## Goal

{goal}

## Done when

An independent reviewer, reading the diff and running this project's own build
and tests, agrees the work is genuinely complete rather than merely plausible.

If there is a specific command that proves it — a test suite, a build, a lint —
name it here and the reviewer will use it.

## Constraints

- Stay within the goal above. Do not refactor code it did not ask about.
- Leave the working tree in a state that builds.

## Notes

(Add detail before starting — the more precise this file is, the less the run
drifts. It is re-read at the top of every iteration.)
"""


def do_init(name: str) -> int:
    d = run_dir(name)
    if (d / "task.md").exists():
        sys.exit(f"run already exists at {d}")
    (d / "reviews").mkdir(parents=True, exist_ok=True)
    (d / "sessions").mkdir(parents=True, exist_ok=True)
    (d / "log.md").write_text(f"# Log: {name}\n")
    (d / "task.md").write_text(TASK_TEMPLATE.format(name=name, goal=UNFILLED_GOAL))
    write_state(
        name,
        status="idle",
        pid=None,
        iteration=0,
        verdict="UNKNOWN",
        findings="",
        history=[],
        createdAt=now(),
    )
    print(f"created {d}\n  edit {d / 'task.md'}, then: harness start {name}")
    return 0


def do_stop(name: str) -> int:
    d = run_dir(name)
    if not d.exists():
        sys.exit(f"no run at {d}")
    (d / "STOP").touch()
    print(f"stop requested — {name} will halt after the current iteration")
    return 0


def stop_requested(name: str) -> bool:
    p = run_dir(name) / "STOP"
    if not p.exists():
        return False
    p.unlink()
    return True


def is_unrunnable(task: str) -> bool:
    """
    Whether this task.md is too empty to spend a turn on.

    Its own function so it can be tested without going near `do_start`, which
    spawns agents. The placeholder check is the load-bearing half: an untouched
    template is not blank, so a `start` on a run whose task was never written
    would otherwise send the agent off to implement the template.
    """
    return not task.strip() or UNFILLED_GOAL in task


def do_start(name: str) -> int:
    if not shutil.which("pi"):
        sys.exit("pi is not on PATH")

    d = run_dir(name)
    task = slurp(d / "task.md")
    if is_unrunnable(task):
        sys.exit(f"no runnable task at {d} — write one first:\n  harness init {name}")

    cwd = str(Path.cwd())
    session = f"{name}-1"
    eval_prompt, eval_model = evaluator_parts()
    review_errors = 0
    ending, status = "the loop exited without saying why", "failed"

    log(name, "Run started.")
    write_state(name, status="running", pid=os.getpid())

    while True:
        state = read_state(name)
        iteration = state["iteration"] + 1

        if stop_requested(name):
            ending, status = "stopped on request", "stopped"
            break
        if iteration > MAX_ITERATIONS:
            ending = f"hit the {MAX_ITERATIONS}-iteration ceiling without a PASS"
            break

        task = slurp(d / "task.md")
        steer = take_steer(name)
        if steer:
            log(name, f"Steered: {steer.splitlines()[0]}")

        show(f"\n=== iteration {iteration}")
        worker = run_pi(
            [
                # JSON mode for the worker too, purely so its turn can be
                # watched: `-p` text mode prints nothing until the process
                # exits, which is what made a long iteration look like a hang.
                "-p", "--mode", "json",
                "--session-dir", str(d / "sessions"),
                "--session-id", session,
                "-ne",
                "-t", WORKER_TOOLS,
                "--",
                worker_prompt(name, state, task, steer),
            ],
            cwd=cwd,
        )
        if worker.code != 0:
            log(name, f"The agent process failed: {worker.stderr.strip()[-300:]}")
            ending, status = "the agent process failed", "failed"
            break
        if stop_requested(name):
            ending, status = "stopped on request", "stopped"
            break

        show("--- reviewing")
        review = run_pi(
            [
                "-p", "--mode", "json", "-ne",
                # A fresh session id per iteration: the reviewer still starts cold,
                # which is the independence `--no-session` was buying, but it leaves
                # a transcript. The review that gets killed on the timeout is exactly
                # the one worth reading, and it used to leave nothing behind.
                "--session-dir", str(d / "sessions"),
                "--session-id", f"{name}-review-{iteration:03d}",
                *(["--model", eval_model] if eval_model else []),
                "-t", REVIEW_TOOLS,
                "--system-prompt", eval_prompt,
                "--",
                review_prompt(name, cwd, iteration, task),
            ],
            cwd=cwd,
            timeout=REVIEW_TIMEOUT_S,
        )

        # Empty text counts as a failure even on exit 0: a reviewer that said
        # nothing measured nothing, and must not be parsed into a verdict.
        if review.code != 0 or not review.text:
            verdict = "ERROR"
            findings = f"The reviewer could not be run.\n\n{(review.stderr.strip() or 'no output')[-500:]}"
            review_errors += 1
        else:
            verdict = verdict_of(review.text)
            findings = review.text
            review_errors = 0

        # Zero-padded so `ls` and any future reader sort these the way they were
        # written; unpadded, "10.md" sorts before "2.md".
        (d / "reviews" / f"{iteration:03d}.md").write_text(
            f"# Iteration {iteration} — {now()} — {review.seconds}s — "
            f"{review.tools} tool calls, {review.tokens} tokens\n\n{findings}\n"
        )
        write_state(
            name,
            iteration=iteration,
            verdict=verdict,
            findings=findings,
            history=[
                *state["history"],
                {
                    "iteration": iteration,
                    "verdict": verdict,
                    "timestamp": now(),
                    "workerSeconds": worker.seconds,
                    "workerTokens": worker.tokens,
                    "reviewSeconds": review.seconds,
                    "reviewTools": review.tools,
                },
            ],
        )
        log(name, f"Iteration {iteration}: {verdict} ({review.seconds}s, {review.tools} tool calls)")
        show(f"--- review: {verdict} ({review.seconds}s, {review.tools} tool calls)")

        if verdict == "PASS":
            ending, status = "the reviewer confirmed it is finished", "done"
            break
        if review_errors >= MAX_REVIEW_ERRORS:
            ending = f"the reviewer could not be dispatched {review_errors} times in a row"
            break

    log(name, f"Run ended: {ending}")
    show(f"\n=== run ended: {ending}")
    # `pid: None` is what makes the state trustworthy. A run that gets here has
    # unwound properly; one that was killed leaves its pid behind, which is how
    # a reader tells "stopped on purpose" from "the laptop lid closed".
    write_state(name, status=status, pid=None)
    return 0 if status == "done" else 1


def main() -> int:
    # Named for the symlink on PATH, not the file, so usage and errors read the
    # way it is actually invoked.
    ap = argparse.ArgumentParser(prog="harness", description=__doc__.split("\n")[1])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for cmd, help_text in [
        ("init", "create the run folder and a task.md to fill in"),
        ("start", "run it until PASS, STOP, or the iteration ceiling"),
        ("stop", "halt a running harness after the current iteration"),
    ]:
        sub.add_parser(cmd, help=help_text).add_argument("name")

    args = ap.parse_args()
    return {"init": do_init, "start": do_start, "stop": do_stop}[args.cmd](args.name)


if __name__ == "__main__":
    sys.exit(main())
