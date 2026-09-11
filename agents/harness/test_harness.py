#!/usr/bin/env python3
"""
Tests for the harness's pure functions.

Run: python3 agents/harness/test_harness.py

Only the places where a bug is silent are covered:

- `render` — a crash would be obvious; what would not be is flooding the
  terminal with one line per token, or filtering so hard that a long iteration
  shows nothing.
- `Result.absorb` — the verdict and the timings come out of here. Reading the
  wrong assistant message ends a run early, or never.
- `verdict_of` — a misread verdict is the most expensive bug here: a false PASS
  ships unfinished work.
- the `init`/`start` contract — `start` refuses the template `init` writes, and
  the two must agree on the exact string.

Nothing here spawns `pi`. `run_pi` is the only function that does, and the tests
that touch `do_start` reach the guard and exit before it.

The JSON event shapes are copied from a real `pi -p --mode json` run rather than
invented, so a change to pi's wire format fails this suite instead of silently
emptying the display.
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402


def assistant(*parts, **extra):
    return {"type": "message_end", "message": {"role": "assistant", "content": list(parts), **extra}}


def text(s):
    return {"type": "text", "text": s}


class TestRender(unittest.TestCase):
    def test_tool_call_with_string_arg(self):
        self.assertEqual(
            harness.render({"type": "tool_execution_start", "toolName": "ls", "args": {"path": "/tmp/p"}}),
            "  · ls /tmp/p",
        )

    def test_tool_call_without_string_arg(self):
        self.assertEqual(harness.render({"type": "tool_execution_start", "toolName": "ls", "args": {}}), "  · ls")
        self.assertEqual(harness.render({"type": "tool_execution_start", "toolName": "ls"}), "  · ls")

    def test_collapses_newlines_in_args(self):
        # A bash heredoc must not turn one tool call into thirty terminal lines.
        out = harness.render(
            {"type": "tool_execution_start", "toolName": "bash", "args": {"command": "cd /tmp\nls -la\necho hi"}}
        )
        self.assertEqual(out, "  · bash cd /tmp ls -la echo hi")

    def test_assistant_prose(self):
        self.assertEqual(harness.render(assistant(text("Reading the config."))), "  Reading the config.")

    def test_ignores_the_bulk_of_the_stream(self):
        # message_update is one event per token — the flood. Note its real
        # shape: no `.message` at all, the delta rides on assistantMessageEvent.
        for event in [
            {"type": "message_update", "usage": {}, "assistantMessageEvent": {"type": "text_delta"}},
            {"type": "session", "version": 3},
            {"type": "agent_start"},
            {"type": "turn_start"},
            {"type": "tool_execution_end", "toolName": "ls"},
            {"type": "agent_end", "messages": []},
            {"type": "message_start", "message": {"role": "assistant", "content": []}},
        ]:
            self.assertIsNone(harness.render(event), event["type"])

    def test_ignores_turn_end(self):
        # turn_end repeats the finished assistant message that message_end
        # already carried. Matching it too would print every reply twice.
        self.assertIsNone(
            harness.render({"type": "turn_end", "message": {"role": "assistant", "content": [text("hi")]}})
        )

    def test_ignores_non_assistant_messages(self):
        # The user message is the iteration prompt: hundreds of lines the user
        # already knows, echoed back at them.
        for role in ["user", "toolResult"]:
            self.assertIsNone(
                harness.render({"type": "message_end", "message": {"role": role, "content": [text("x")]}}), role
            )

    def test_ignores_toolcall_only_message(self):
        # tool_execution_start already reported it; a blank line alongside would
        # double every call.
        self.assertIsNone(harness.render(assistant({"type": "toolCall"})))

    def test_keeps_prose_from_a_message_that_also_calls_a_tool(self):
        self.assertEqual(harness.render(assistant(text("Let me look."), {"type": "toolCall"})), "  Let me look.")

    def test_truncates(self):
        out = harness.render(assistant(text("x" * 500)))
        self.assertLess(len(out), 210)
        self.assertTrue(out.endswith("…"))


class TestResult(unittest.TestCase):
    def absorb_all(self, *events) -> harness.Result:
        r = harness.Result()
        for e in events:
            r.absorb(e)
        return r

    def test_takes_the_last_assistant_text(self):
        r = self.absorb_all(
            assistant(text("thinking")),
            {"type": "message_end", "message": {"role": "user", "content": [text("ignored")]}},
            assistant(text("PASS")),
        )
        self.assertEqual(r.text, "PASS")

    def test_ignores_a_trailing_toolcall_only_message(self):
        # The verdict lives in the last message with prose. A trailing tool-call
        # message with no text must not blank it out — that would turn a real
        # verdict into a failed dispatch.
        r = self.absorb_all(assistant(text("PASS")), assistant({"type": "toolCall"}))
        self.assertEqual(r.text, "PASS")

    def test_counts_tools_and_takes_peak_tokens(self):
        r = self.absorb_all(
            {"type": "tool_execution_start", "toolName": "ls"},
            {"type": "tool_execution_start", "toolName": "bash"},
            assistant(usage={"totalTokens": 900}),
            assistant(usage={"totalTokens": 300}),
        )
        self.assertEqual(r.tools, 2)
        self.assertEqual(r.tokens, 900)

    def test_starts_empty(self):
        # Which the caller treats as a failed dispatch, not as a verdict.
        self.assertEqual(harness.Result().text, "")


class TestVerdictOf(unittest.TestCase):
    def test_reads_a_bare_verdict(self):
        self.assertEqual(harness.verdict_of("PASS"), "PASS")
        self.assertEqual(harness.verdict_of("NEEDS_WORK"), "NEEDS_WORK")

    def test_reads_the_last_line(self):
        self.assertEqual(harness.verdict_of("Checked the diff, ran the tests.\n\nPASS\n"), "PASS")

    def test_scans_from_the_end(self):
        # Models routinely discuss both words before committing to one.
        self.assertEqual(harness.verdict_of("This is not NEEDS_WORK because it builds.\n\nPASS"), "PASS")
        self.assertEqual(harness.verdict_of("I considered PASS but the test is empty.\n\nNEEDS_WORK"), "NEEDS_WORK")

    def test_unreadable_never_passes(self):
        # The failure mode must be "keeps working", never "stops early".
        self.assertEqual(harness.verdict_of("I have no idea what to make of this."), "NEEDS_WORK")
        self.assertEqual(harness.verdict_of(""), "NEEDS_WORK")


class RunFolderTest(unittest.TestCase):
    """
    Tests that need a run folder on disk.

    The run root is resolved from the process cwd, so these chdir into a temp
    directory rather than monkeypatching a global — that way they exercise the
    same path resolution the CLI uses.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._prev = os.getcwd()
        # macOS hands out /var/... symlinked to /private/var/...; resolve so
        # assertions on derived paths compare like with like.
        self.work = Path(self.tmp.name).resolve()
        os.chdir(self.work)
        self.name = "t"
        self.run = self.work / ".harness" / self.name
        # init and start print where they put things: useful at a terminal,
        # noise in a test run.
        redirect = contextlib.redirect_stdout(io.StringIO())
        redirect.__enter__()
        self.addCleanup(lambda: redirect.__exit__(None, None, None))

    def tearDown(self):
        os.chdir(self._prev)
        self.tmp.cleanup()


class TestPaths(RunFolderTest):
    def test_run_lives_under_the_cwd(self):
        self.assertEqual(harness.run_dir(self.name), self.run)

    def test_two_directories_hold_independent_runs(self):
        # The same run name in two checkouts must not collide, which is most of
        # the point of living beside the work rather than in ~.
        other = self.work / "other"
        other.mkdir()
        os.chdir(other)
        self.assertNotEqual(harness.run_dir(self.name), self.run)


class TestInit(RunFolderTest):
    def test_creates_the_folder_and_a_task(self):
        harness.do_init(self.name)
        for p in ["task.md", "log.md", "state.json"]:
            self.assertTrue((self.run / p).exists(), p)
        for p in ["reviews", "sessions"]:
            self.assertTrue((self.run / p).is_dir(), p)

    def test_starts_idle_at_iteration_zero(self):
        harness.do_init(self.name)
        state = harness.read_state(self.name)
        self.assertEqual(state["status"], "idle")
        self.assertEqual(state["iteration"], 0)
        self.assertEqual(state["verdict"], "UNKNOWN")
        self.assertEqual(state["history"], [])

    def test_refuses_to_clobber_an_existing_task(self):
        harness.do_init(self.name)
        (self.run / "task.md").write_text("# my careful task\n")
        with self.assertRaises(SystemExit):
            harness.do_init(self.name)
        self.assertEqual((self.run / "task.md").read_text(), "# my careful task\n")

    def test_the_template_it_writes_is_one_start_refuses(self):
        # These are a pair. If the placeholder and the guard drift apart, `start`
        # spends a real iteration working on the template. Asserted against the
        # predicate rather than through `do_start`, whose pi-on-PATH check exits
        # first and would pass this for the wrong reason.
        harness.do_init(self.name)
        self.assertTrue(harness.is_unrunnable((self.run / "task.md").read_text()))


class TestIsUnrunnable(unittest.TestCase):
    """
    The predicate that decides whether `start` may spend a turn.

    Tested directly rather than through `do_start`: that function's first act is
    to check for `pi` on PATH, so driving it from a test either exits for the
    wrong reason or — if the check ever moves — spawns a real agent.
    """

    def test_the_untouched_template_is_unrunnable(self):
        self.assertTrue(harness.is_unrunnable(harness.TASK_TEMPLATE.format(name="x", goal=harness.UNFILLED_GOAL)))

    def test_blank_is_unrunnable(self):
        self.assertTrue(harness.is_unrunnable(""))
        self.assertTrue(harness.is_unrunnable("   \n\n  "))

    def test_a_filled_in_task_is_runnable(self):
        self.assertFalse(harness.is_unrunnable(harness.TASK_TEMPLATE.format(name="x", goal="Add a mul() function.")))


class TestStartGuards(RunFolderTest):
    def test_refuses_a_missing_run(self):
        with self.assertRaises(SystemExit):
            harness.do_start("never-created")



class TestState(RunFolderTest):
    def setUp(self):
        super().setUp()
        harness.do_init(self.name)

    def test_patch_merges_into_what_is_there(self):
        harness.write_state(self.name, iteration=3)
        state = harness.read_state(self.name)
        self.assertEqual(state["iteration"], 3)
        self.assertEqual(state["status"], "idle")  # untouched by the patch

    def test_unreadable_state_is_empty_not_a_crash(self):
        (self.run / "state.json").write_text("{ truncated")
        self.assertEqual(harness.read_state(self.name), {})

    def test_missing_state_is_empty_not_a_crash(self):
        self.assertEqual(harness.read_state("no-such-run"), {})


class TestStop(RunFolderTest):
    def setUp(self):
        super().setUp()
        harness.do_init(self.name)

    def test_stop_writes_the_flag_and_the_loop_consumes_it(self):
        harness.do_stop(self.name)
        self.assertTrue((self.run / "STOP").exists())
        self.assertTrue(harness.stop_requested(self.name))
        # Consumed on read, so a stopped run can be started again without
        # halting immediately.
        self.assertFalse((self.run / "STOP").exists())
        self.assertFalse(harness.stop_requested(self.name))

    def test_stop_on_a_missing_run_is_an_error(self):
        with self.assertRaises(SystemExit):
            harness.do_stop("never-created")


class TestWorkerPrompt(RunFolderTest):
    def setUp(self):
        super().setUp()
        harness.do_init(self.name)
        self.state = harness.read_state(self.name)

    def test_the_task_is_quoted_in_full(self):
        # task.md is re-read every iteration and the session is new each time, so
        # this is the agent's only sight of the contract. Editing it mid-run is
        # the way to change course.
        out = harness.worker_prompt(self.name, self.state, "do the thing")
        self.assertIn("do the thing", out)

    def test_findings_are_passed_through_verbatim(self):
        state = {**self.state, "verdict": "NEEDS_WORK", "findings": "The test asserts nothing."}
        out = harness.worker_prompt(self.name, state, "t")
        self.assertIn("The test asserts nothing.", out)
        self.assertIn("Do not argue with it by making the check weaker.", out)

    def test_error_is_not_reported_as_a_verdict(self):
        state = {**self.state, "verdict": "ERROR", "findings": "boom"}
        out = harness.worker_prompt(self.name, state, "t")
        self.assertIn("not a verdict on your work", out)
        self.assertNotIn("Reviewer findings", out)

    def test_first_iteration_shows_no_findings(self):
        out = harness.worker_prompt(self.name, self.state, "t")
        self.assertNotIn("Reviewer findings", out)
        self.assertIn("Completed iterations: 0", out)

    def test_says_there_is_no_memory_of_earlier_iterations(self):
        # A fresh session per iteration, so the prompt has to say so and point at
        # the notes: nothing else carries across.
        out = harness.worker_prompt(self.name, self.state, "t")
        self.assertIn("no memory of earlier iterations", out)
        self.assertIn(str(self.run / "log.md"), out)


class TestPrompts(RunFolderTest):
    def test_review_prompt_states_absolute_paths(self):
        # Without them a reviewer goes looking: one real run burned 257 seconds
        # on `find / -iname log.md`.
        out = harness.review_prompt(self.name, "/repo", 3, "the task")
        self.assertIn("/repo", out)
        self.assertIn(str(self.run / "log.md"), out)
        self.assertIn("Do not search the filesystem", out)

    def test_evaluator_frontmatter_is_stripped_and_the_model_read(self):
        body, model = harness.evaluator_parts()
        self.assertTrue(body.strip(), "evaluator.md should not be empty")
        self.assertFalse(body.lstrip().startswith("---"), "frontmatter should be stripped")
        # Read from the file rather than hardcoded, so the two cannot drift.
        self.assertIsNotNone(model)


if __name__ == "__main__":
    unittest.main(verbosity=2)
