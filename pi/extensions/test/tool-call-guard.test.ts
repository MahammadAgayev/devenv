/**
 * Tests for the multi-modal `agent` guard.
 *
 * Regression origin: `REQUIRED_ARGS` listed `agent: ["agent", "task"]`, which
 * blocked every parallel and chain dispatch. The model's natural recovery —
 * adding `agent`+`task` next to `tasks` — was then rejected by the tool itself
 * for specifying two modes, so it oscillated between the two errors and fell
 * back to issuing single calls one at a time.
 *
 * Run: node --experimental-strip-types --test pi/extensions/test/tool-call-guard.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkAgentArgs, checkEmptyRequiredArgs } from "../lib/tool-call-guard-rules.ts";

const scoutTask = (n: number) => ({
  agent: "scout",
  task: `In the Uber fievel Java monorepo, investigate thing ${n}`,
});

describe("checkAgentArgs — parallel mode", () => {
  it("allows the exact call from the bug report", () => {
    // Three scout tasks, no top-level agent/task. This was blocked before.
    const args = { tasks: [scoutTask(1), scoutTask(2), scoutTask(3)] };
    assert.equal(checkAgentArgs(args), null);
  });

  it("allows a single-entry tasks array", () => {
    assert.equal(checkAgentArgs({ tasks: [scoutTask(1)] }), null);
  });

  it("allows per-task cwd", () => {
    const args = { tasks: [{ ...scoutTask(1), cwd: "/home/user/fievel" }] };
    assert.equal(checkAgentArgs(args), null);
  });

  it("rejects a task entry missing its agent", () => {
    const args = { tasks: [scoutTask(1), { task: "no agent named" }] };
    const r = checkAgentArgs(args);
    assert.ok(r?.includes("tasks[1]"), `should name the bad index, got: ${r}`);
    assert.ok(r?.includes("agent"));
  });

  it("rejects a blank task string", () => {
    const args = { tasks: [{ agent: "scout", task: "   " }] };
    const r = checkAgentArgs(args);
    assert.ok(r?.includes("tasks[0]"), `got: ${r}`);
  });

  it("rejects a non-object task entry", () => {
    const r = checkAgentArgs({ tasks: ["just a string"] });
    assert.ok(r?.includes("not an object"), `got: ${r}`);
  });
});

describe("checkAgentArgs — chain mode", () => {
  it("allows a chain", () => {
    const args = { chain: [scoutTask(1), { agent: "task", task: "use {previous}" }] };
    assert.equal(checkAgentArgs(args), null);
  });

  it("reports the chain label, not tasks", () => {
    const args = { chain: [{ agent: "scout" }] };
    const r = checkAgentArgs(args);
    assert.ok(r?.includes("chain[0]"), `got: ${r}`);
  });
});

describe("checkAgentArgs — single mode", () => {
  it("allows a well-formed single call", () => {
    assert.equal(checkAgentArgs({ agent: "scout", task: "look at X" }), null);
  });

  it("blocks a whitespace-only task", () => {
    const r = checkAgentArgs({ agent: "scout", task: "  " });
    assert.ok(r?.includes('"task" is empty'), `got: ${r}`);
  });
});

describe("checkAgentArgs — deferring to the tool", () => {
  // The core of the fix. The guard must not produce an error the tool would
  // not, or the two disagree and the model cannot satisfy both at once.

  it("stays silent when two modes are given at once", () => {
    // The model's recovery attempt. Previously the guard demanded this shape,
    // and the tool rejected it — the deadlock.
    const args = { agent: "scout", task: "x", tasks: [scoutTask(1)] };
    assert.equal(checkAgentArgs(args), null, "the tool reports mode conflicts, not the guard");
  });

  it("stays silent when no mode is given", () => {
    assert.equal(checkAgentArgs({}), null);
    assert.equal(checkAgentArgs({ agentScope: "user" }), null);
  });

  it("stays silent on an empty tasks array", () => {
    // Zero modes by the tool's counting rule, so the tool explains it.
    assert.equal(checkAgentArgs({ tasks: [] }), null);
  });

  it("stays silent when only half of single mode is present", () => {
    assert.equal(checkAgentArgs({ agent: "scout" }), null);
    assert.equal(checkAgentArgs({ task: "do a thing" }), null);
  });

  it("blocks only the genuinely empty call", () => {
    assert.ok(checkAgentArgs(undefined)?.includes("no arguments"));
  });
});

describe("checkEmptyRequiredArgs no longer touches `agent`", () => {
  it("does not block a parallel dispatch", () => {
    // The actual regression: this returned a "missing required argument" block.
    const args = { tasks: [scoutTask(1), scoutTask(2), scoutTask(3)] };
    assert.equal(checkEmptyRequiredArgs("agent", args), null);
  });

  it("still guards other tools", () => {
    // Confirms the table itself is intact and the fix was surgical.
    assert.ok(checkEmptyRequiredArgs("bash", {})?.includes("command"));
    assert.ok(checkEmptyRequiredArgs("read", { path: "" })?.includes("empty"));
    assert.ok(checkEmptyRequiredArgs("Agent", { prompt: "x" })?.includes("subagent_type"));
    assert.equal(checkEmptyRequiredArgs("bash", { command: "ls" }), null);
  });
});
