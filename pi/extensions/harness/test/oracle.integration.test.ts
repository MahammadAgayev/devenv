/**
 * Integration tests for the oracle against real processes.
 *
 * `runValidation` spawns a shell, so the unit tests cannot reach its most
 * important behaviours: that a failing command reads as FAIL rather than ERROR,
 * that a command which cannot run at all reads as ERROR rather than FAIL (the
 * distinction the loop's three-strikes rule depends on), and that a hanging
 * command is killed rather than wedging the run forever.
 *
 * Run: node --experimental-strip-types --test pi/extensions/harness/test/oracle.integration.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { runValidation } from "../oracle.ts";

const workdir = mkdtempSync(join(tmpdir(), "harness-oracle-"));
after(() => rmSync(workdir, { recursive: true, force: true }));

describe("runValidation", () => {
  it("PASS on exit 0", async () => {
    const r = await runValidation("exit 0", workdir);
    assert.equal(r.verdict, "PASS");
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  it("FAIL on a non-zero exit", async () => {
    const r = await runValidation("exit 1", workdir);
    assert.equal(r.verdict, "FAIL");
    assert.equal(r.exitCode, 1);
  });

  it("FAIL — not ERROR — when the command runs and reports failure", async () => {
    // The distinction the loop depends on: a failing test suite must keep the
    // run going, while a broken oracle must stop it after three strikes.
    const r = await runValidation("echo 'AssertionError: 2 != 3' >&2; exit 1", workdir);
    assert.equal(r.verdict, "FAIL");
    assert.ok(r.output.includes("AssertionError"), `stderr should be captured, got: ${r.output}`);
  });

  it("ERROR — not FAIL — when the command does not exist", async () => {
    // sh exits 127 for not-found. Classifying that as FAIL would make a typo'd
    // validation command indistinguishable from a test suite that never
    // passes, and the run would spend all 50 iterations on it.
    const r = await runValidation("definitely-not-a-real-binary-xyz", workdir);
    assert.equal(r.exitCode, 127);
    assert.equal(r.verdict, "ERROR");
    assert.ok(
      r.output.includes("definitely-not-a-real-binary-xyz"),
      `should name the missing binary, got: ${r.output}`,
    );
  });

  it("ERROR when the command is found but not executable", async () => {
    const { writeFileSync } = await import("node:fs");
    const script = join(workdir, "not-executable.sh");
    writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o644 });
    const r = await runValidation(script, workdir);
    assert.equal(r.exitCode, 126);
    assert.equal(r.verdict, "ERROR");
  });

  it("captures interleaved stdout and stderr", async () => {
    const r = await runValidation("echo out; echo err >&2; exit 3", workdir);
    assert.equal(r.exitCode, 3);
    assert.ok(r.output.includes("out"), "stdout missing");
    assert.ok(r.output.includes("err"), "stderr missing");
  });

  it("runs in the given cwd", async () => {
    const r = await runValidation("pwd", workdir);
    assert.equal(r.verdict, "PASS");
    // macOS resolves /tmp to /private/tmp; compare the resolved tail.
    assert.ok(r.output.trim().endsWith(workdir.replace(/^\/private/, "")) || r.output.includes(workdir));
  });

  it("supports pipes and redirection, as a hand-typed command would", async () => {
    const r = await runValidation("printf 'a\\nb\\nc\\n' | wc -l | tr -d ' '", workdir);
    assert.equal(r.verdict, "PASS");
    assert.equal(r.output.trim(), "3");
  });

  it("keeps the tail of very large output without exhausting memory", async () => {
    // 200k lines: well past the 2x clip cap.
    const r = await runValidation("seq 1 200000", workdir);
    assert.equal(r.verdict, "PASS");
    assert.ok(r.output.length < 20000, `output should be clipped, got ${r.output.length} chars`);
    assert.ok(r.output.trimEnd().endsWith("200000"), "the tail — the useful part — should survive");
  });

  it("is killed by the abort signal", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = runValidation("sleep 30", workdir, ac.signal);
    setTimeout(() => ac.abort(), 150);
    const r = await p;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `should abort promptly, took ${elapsed}ms`);
    // Killed by signal: no exit code, and it must not read as a passing run.
    assert.notEqual(r.verdict, "PASS");
  });
});
