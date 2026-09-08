/**
 * Tests for the harness's pure functions.
 *
 * Run: node --experimental-strip-types --test pi/extensions/harness/test/harness.test.ts
 *
 * Covers the parts where a bug is silent: verdict parsing (a misread verdict
 * ends a run early), sentence truncation (the recap cap is only real if this
 * works), output clipping, and the state round-trip.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clip, parseEvaluatorVerdict } from "../oracle.ts";
import { truncateToSentences } from "../recap.ts";
import { sanitize } from "../state.ts";

describe("parseEvaluatorVerdict", () => {
  it("reads a bare verdict", () => {
    assert.equal(parseEvaluatorVerdict("PASS"), "PASS");
    assert.equal(parseEvaluatorVerdict("NEEDS_WORK"), "NEEDS_WORK");
  });

  it("reads the verdict off the last line", () => {
    assert.equal(parseEvaluatorVerdict("Checked the diff, looks right.\n\nPASS"), "PASS");
    assert.equal(parseEvaluatorVerdict("The test was weakened.\n\nNEEDS_WORK"), "NEEDS_WORK");
  });

  it("takes the LAST mention, not the first", () => {
    // The failure this guards: a model that deliberates before deciding.
    // Reading top-down would return NEEDS_WORK here and loop a finished run.
    const text = "I considered whether this is NEEDS_WORK, but the tests are honest.\n\nPASS";
    assert.equal(parseEvaluatorVerdict(text), "PASS");
  });

  it("prefers NEEDS_WORK when both are on the final line", () => {
    assert.equal(parseEvaluatorVerdict("verdict: not PASS — NEEDS_WORK"), "NEEDS_WORK");
  });

  it("is case-insensitive", () => {
    assert.equal(parseEvaluatorVerdict("looks good\npass"), "PASS");
  });

  it("defaults to NEEDS_WORK when no verdict is present", () => {
    // The important direction: an unparseable reply must never end a run.
    assert.equal(parseEvaluatorVerdict("I could not determine anything."), "NEEDS_WORK");
    assert.equal(parseEvaluatorVerdict(""), "NEEDS_WORK");
  });

  it("ignores trailing blank lines", () => {
    assert.equal(parseEvaluatorVerdict("PASS\n\n\n   \n"), "PASS");
  });
});

describe("truncateToSentences", () => {
  it("leaves one or two sentences alone", () => {
    assert.equal(truncateToSentences("One thing.", 2), "One thing.");
    assert.equal(truncateToSentences("One thing. Two things.", 2), "One thing. Two things.");
  });

  it("cuts the third sentence", () => {
    const out = truncateToSentences("First. Second. Third. Fourth.", 2);
    assert.equal(out, "First. Second.");
  });

  it("handles ! and ? as terminators", () => {
    assert.equal(truncateToSentences("Broken! Why? Unclear.", 2), "Broken! Why?");
  });

  it("collapses newlines so multi-line replies still count correctly", () => {
    const out = truncateToSentences("Working on retries.\n\nBlocked on a flaky test.\n\nAlso refactoring.", 2);
    assert.equal(out, "Working on retries. Blocked on a flaky test.");
  });

  it("drops an unterminated trailing fragment", () => {
    // Half a sentence reads worse than none.
    assert.equal(truncateToSentences("First. Second. And then I was", 2), "First. Second.");
  });

  it("keeps a single unpunctuated blurt and terminates it", () => {
    assert.equal(truncateToSentences("no punctuation here", 2), "no punctuation here.");
  });

  it("does not split on decimals or abbreviations mid-sentence", () => {
    // `3.5` has no whitespace after the dot, so the lookahead skips it.
    const out = truncateToSentences("Coverage rose to 3.5 percent. Done.", 2);
    assert.equal(out, "Coverage rose to 3.5 percent. Done.");
  });

  it("treats ellipsis as one terminator", () => {
    assert.equal(truncateToSentences("Hmm... Still stuck. Third one.", 2), "Hmm... Still stuck.");
  });

  it("returns empty for empty input", () => {
    assert.equal(truncateToSentences("", 2), "");
    assert.equal(truncateToSentences("   \n  ", 2), "");
  });
});

describe("clip", () => {
  it("leaves short text alone", () => {
    assert.equal(clip("short", 100), "short");
  });

  it("keeps the TAIL, where test failures live", () => {
    const out = clip("A".repeat(50) + "FAILURE_SUMMARY", 20);
    assert.ok(out.endsWith("FAILURE_SUMMARY"), `expected tail to survive, got: ${out}`);
    assert.ok(out.includes("omitted"), "expected an elision marker");
  });

  it("clips to approximately the requested size", () => {
    const out = clip("x".repeat(1000), 100);
    // The marker adds a little; the payload itself must be exactly the cap.
    assert.ok(out.length < 200, `expected ~100 chars plus marker, got ${out.length}`);
  });
});

describe("sanitize", () => {
  it("keeps ordinary names", () => {
    assert.equal(sanitize("auth-token-refresh"), "auth-token-refresh");
    assert.equal(sanitize("run_2"), "run_2");
  });

  it("replaces path separators and spaces", () => {
    assert.equal(sanitize("my run"), "my-run");
    assert.equal(sanitize("a/b"), "a-b");
  });

  it("refuses to produce a traversal", () => {
    // The one that matters: a name becomes a directory under ~/.pi/harness.
    for (const evil of ["../etc", "../../root", "./x", "..", "."]) {
      const out = sanitize(evil);
      assert.ok(!out.includes("/"), `"${evil}" -> "${out}" still has a separator`);
      assert.ok(!out.startsWith(".."), `"${evil}" -> "${out}" still starts with ..`);
      assert.ok(!out.startsWith("."), `"${evil}" -> "${out}" still starts with .`);
    }
  });

  it("strips leading and trailing dashes", () => {
    assert.equal(sanitize("--weird--"), "weird");
  });
});

/**
 * State round-trip against a real temp HOME.
 *
 * `state.ts` resolves paths from `homedir()` at call time, and Node's
 * `os.homedir()` reads $HOME on POSIX, so pointing $HOME at a temp dir keeps
 * the whole test off the real `~/.pi`.
 */
describe("state round-trip", () => {
  const realHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "harness-test-"));

  after(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("creates, reads back, and mutates a run", async () => {
    process.env.HOME = fakeHome;

    // Imported after $HOME is set so nothing cached a real path.
    const st = await import("../state.ts");

    assert.deepEqual(st.listRuns(), []);

    const created = st.createRun({
      name: "demo",
      cwd: "/tmp/project",
      validationCommand: "pytest -x -q",
      task: "# Task: demo\n",
    });

    assert.equal(created.iteration, 0);
    assert.equal(created.lastVerdict, "UNKNOWN");
    assert.ok(existsSync(st.taskPath("demo")), "task.md should exist");
    assert.ok(existsSync(st.logPath("demo")), "log.md should exist");
    assert.deepEqual(st.listRuns(), ["demo"]);

    const read = st.readState("demo");
    assert.ok(read, "state should read back");
    assert.equal(read.validationCommand, "pytest -x -q");
    assert.equal(read.cwd, "/tmp/project");

    read.iteration = 7;
    read.lastVerdict = "FAIL";
    st.writeState(read);
    assert.equal(st.readState("demo")?.iteration, 7);
    assert.equal(st.readState("demo")?.lastVerdict, "FAIL");
  });

  it("handles the stop flag", async () => {
    process.env.HOME = fakeHome;
    const st = await import("../state.ts");

    assert.equal(st.stopRequested("demo"), false);
    st.requestStop("demo");
    assert.equal(st.stopRequested("demo"), true);
    st.clearStop("demo");
    assert.equal(st.stopRequested("demo"), false);
    // Clearing an absent flag must be a no-op, not a throw.
    st.clearStop("demo");
  });

  it("consumes STEER.md exactly once", async () => {
    process.env.HOME = fakeHome;
    const st = await import("../state.ts");
    const { writeFileSync } = await import("node:fs");

    assert.equal(st.takeSteer("demo"), null);

    writeFileSync(st.steerPath("demo"), "focus on the parser\n");
    assert.equal(st.takeSteer("demo"), "focus on the parser");
    // The whole point: a second read must not re-deliver it.
    assert.equal(st.takeSteer("demo"), null);
  });

  it("returns null for an unknown run rather than throwing", async () => {
    process.env.HOME = fakeHome;
    const st = await import("../state.ts");
    assert.equal(st.readState("nope"), null);
    assert.equal(st.runExists("nope"), false);
  });
});
