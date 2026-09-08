/**
 * Tests for `sendPrompt`'s context dispatch.
 *
 * Regression origin: `runLoop` called `ctx.sendUserMessage(prompt)` on the
 * `ExtensionCommandContext` handed to a command handler. That interface has no
 * such method — it exposes only `getSystemPromptOptions`, `waitForIdle`,
 * `newSession`, `fork`, `navigateTree`, `switchSession`, and `reload`. Sending
 * lives on `ExtensionAPI` and on `ReplacedSessionContext`.
 *
 * So `/harness start` threw a TypeError on its first send, the surrounding
 * catch swallowed it, and the run silently did nothing.
 *
 * These tests pin the dispatch rule and, more importantly, pin it against the
 * *real* type definitions rather than a fake that might agree with the bug.
 *
 * Run: node --experimental-strip-types --test pi/extensions/harness/test/send-prompt.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Mirror of `sendPrompt` from loop.ts.
 *
 * Inlined because loop.ts imports `../agents/index.ts` transitively and cannot
 * load without a node_modules. The logic is four lines; the value here is
 * locking in the branch, and the interface test below is what guards the
 * assumption the branch rests on.
 */
async function sendPrompt(
  pi: { sendUserMessage: (c: string) => unknown },
  ctx: { sendUserMessage?: (c: string) => unknown },
  content: string,
): Promise<void> {
  const bound = ctx.sendUserMessage;
  if (typeof bound === "function") {
    await bound.call(ctx, content);
    return;
  }
  await pi.sendUserMessage(content);
}

describe("sendPrompt dispatch", () => {
  it("uses pi when the context has no sender (the command-context case)", async () => {
    const sent: string[] = [];
    const pi = { sendUserMessage: (c: string) => void sent.push(`pi:${c}`) };
    // A faithful ExtensionCommandContext: waitForIdle and newSession, no send.
    const ctx = { waitForIdle: async () => {}, newSession: async () => ({ cancelled: false }) };

    await sendPrompt(pi, ctx, "iteration 1");
    assert.deepEqual(sent, ["pi:iteration 1"]);
  });

  it("prefers the context's own sender after a reset", async () => {
    // ReplacedSessionContext is bound to the NEW session; `pi` may still point
    // at the old one, so the bound sender must win.
    const sent: string[] = [];
    const pi = { sendUserMessage: (c: string) => void sent.push(`pi:${c}`) };
    const ctx = { sendUserMessage: (c: string) => void sent.push(`fresh:${c}`) };

    await sendPrompt(pi, ctx, "seed");
    assert.deepEqual(sent, ["fresh:seed"], "must not fall back to pi when the context can send");
  });

  it("calls the bound sender with the context as `this`", async () => {
    // `bound.call(ctx, ...)` rather than `bound(...)`: pi's implementation may
    // rely on its receiver, and an unbound call would throw or misroute.
    let receiver: unknown;
    const pi = { sendUserMessage: () => {} };
    const ctx = {
      marker: "the-context",
      sendUserMessage(this: unknown) {
        receiver = this;
      },
    };

    await sendPrompt(pi, ctx, "x");
    assert.equal((receiver as { marker?: string })?.marker, "the-context");
  });

  it("propagates a send failure instead of reporting success", async () => {
    const pi = {
      sendUserMessage: () => {
        throw new TypeError("ctx.sendUserMessage is not a function");
      },
    };
    await assert.rejects(() => sendPrompt(pi, {}, "x"), /not a function/);
  });
});

/**
 * The test that would actually have caught the bug.
 *
 * Everything above runs against hand-written fakes, and a fake can happily
 * agree with a wrong assumption. This reads pi's shipped type definitions and
 * asserts the shape the dispatch depends on.
 */
describe("pi's real interfaces", () => {
  const types = readFileSync(
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts",
    "utf-8",
  );

  const block = (name: string): string => {
    const start = types.indexOf(`export interface ${name}`);
    assert.notEqual(start, -1, `${name} not found in types.d.ts`);
    const end = types.indexOf("\n}", start);
    return types.slice(start, end);
  };

  it("ExtensionCommandContext does NOT declare sendUserMessage", () => {
    // The whole bug in one assertion. If a future pi adds it, this fails and
    // the dispatch in loop.ts can be simplified.
    assert.ok(
      !block("ExtensionCommandContext").includes("sendUserMessage"),
      "pi added sendUserMessage to ExtensionCommandContext — sendPrompt's fallback is now redundant",
    );
  });

  it("ReplacedSessionContext DOES declare sendUserMessage", () => {
    assert.ok(block("ReplacedSessionContext").includes("sendUserMessage"));
  });

  it("ExtensionAPI declares sendUserMessage", () => {
    assert.ok(block("ExtensionAPI").includes("sendUserMessage"));
  });

  it("ExtensionCommandContext still has the methods the loop relies on", () => {
    const b = block("ExtensionCommandContext");
    for (const m of ["waitForIdle", "newSession"]) {
      assert.ok(b.includes(m), `ExtensionCommandContext lost ${m}`);
    }
  });
});
