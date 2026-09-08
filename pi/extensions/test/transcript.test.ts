/**
 * Tests for `lib/transcript.ts`.
 *
 * This code shipped for months as two verbatim copies — one in
 * `task-handoff.ts`, one in `harness/recap.ts` — and neither was tested,
 * because both were reachable only through a module that imports
 * `@earendil-works/pi-coding-agent` and this repo has no node_modules.
 * Extracting it to `lib/` is what makes these assertions possible at all, so
 * they are the point of the extraction rather than an afterthought.
 *
 * What matters here is fidelity: the dump is the only thing a headless subagent
 * sees, so a dropped role or a bad clip silently degrades every handoff and
 * every recap with no error anywhere.
 *
 * Run: node --experimental-strip-types --test pi/extensions/test/transcript.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TEXT_CLIP,
  TOOL_RESULT_CLIP,
  clip,
  partsToText,
  renderTranscript,
} from "../lib/transcript.ts";

/** Wrap raw messages in the `{ message }` envelope `buildContextEntries` returns. */
const source = (...messages: unknown[]) => ({
  buildContextEntries: () => messages.map((message) => ({ message })),
});

describe("clip", () => {
  it("leaves text at or under the limit untouched", () => {
    assert.equal(clip("hello", 5), "hello");
    assert.equal(clip("hi", 5), "hi");
  });

  it("marks how much was dropped, so the reader knows it is partial", () => {
    const out = clip("a".repeat(20), 5);
    assert.ok(out.startsWith("aaaaa\n"), out);
    assert.match(out, /\[15 more chars\]/);
  });
});

describe("partsToText", () => {
  it("passes a bare string through", () => {
    assert.equal(partsToText("plain"), "plain");
  });

  it("joins text parts and names images without inlining them", () => {
    const out = partsToText([
      { type: "text", text: "before" },
      { type: "image", data: "…base64…" },
      { type: "text", text: "after" },
    ]);
    assert.equal(out, "before\n[image]\nafter");
  });

  it("drops parts it does not understand rather than rendering undefined", () => {
    assert.equal(partsToText([{ type: "thinking", text: "hmm" }, { type: "text", text: "said" }]), "said");
  });

  it("returns empty for content that is neither string nor array", () => {
    assert.equal(partsToText(undefined), "");
    assert.equal(partsToText(null), "");
    assert.equal(partsToText({ type: "text" }), "");
  });
});

describe("renderTranscript — roles", () => {
  it("renders every role the session can produce", () => {
    const out = renderTranscript(
      source(
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "on it" }] },
        { role: "toolResult", toolName: "read", content: "file contents" },
        { role: "bashExecution", command: "ls", exitCode: 0, output: "a.txt" },
        { role: "compactionSummary", summary: "earlier stuff" },
        { role: "branchSummary", summary: "abandoned stuff" },
      ),
    );

    assert.match(out, /## User\n\ndo the thing/);
    assert.match(out, /## Assistant\n\non it/);
    assert.match(out, /## Tool result \(read\)\n\nfile contents/);
    assert.match(out, /## Shell\n\n`ls` → exit 0\n\na\.txt/);
    assert.match(out, /## \[earlier context, compacted\]\n\nearlier stuff/);
    assert.match(out, /## \[abandoned branch, summarized\]\n\nabandoned stuff/);
  });

  it("flags an errored tool result, since a failure reads like a success without it", () => {
    const out = renderTranscript(source({ role: "toolResult", toolName: "read", isError: true, content: "ENOENT" }));
    assert.match(out, /## Tool result \(read, ERROR\)/);
  });

  it("separates sections with a horizontal rule", () => {
    const out = renderTranscript(source({ role: "user", content: "one" }, { role: "user", content: "two" }));
    assert.equal(out, "## User\n\none\n\n---\n\n## User\n\ntwo");
  });

  it("skips roles it does not render instead of emitting a blank section", () => {
    const out = renderTranscript(
      source({ role: "user", content: "one" }, { role: "someFutureRole" }, { role: "user", content: "two" }),
    );
    assert.equal(out.split("---").length, 2, "an unknown role should not add a separator");
  });

  it("skips entries with no message at all", () => {
    const out = renderTranscript({ buildContextEntries: () => [null, {}, { message: null }] });
    assert.equal(out, "");
  });

  it("returns empty string for an empty session", () => {
    assert.equal(renderTranscript(source()), "");
  });
});

describe("renderTranscript — assistant turns", () => {
  it("lists tool calls with their arguments", () => {
    const out = renderTranscript(
      source({
        role: "assistant",
        content: [
          { type: "text", text: "reading it" },
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        ],
      }),
    );
    assert.match(out, /reading it/);
    assert.match(out, /Tool calls:\n- `read` \{"path":"a\.ts"\}/);
  });

  it("handles a call with no arguments without printing undefined", () => {
    const out = renderTranscript(
      source({ role: "assistant", content: [{ type: "toolCall", name: "pwd" }] }),
    );
    assert.match(out, /- `pwd` \{\}/);
    assert.doesNotMatch(out, /undefined/);
  });

  it("omits a turn that produced neither prose nor calls", () => {
    // Pure-thinking turns are common and carry nothing for the reader; an empty
    // `## Assistant` heading would be pure noise in the dump.
    const out = renderTranscript(
      source({ role: "assistant", content: [{ type: "thinking", text: "hmm" }] }, { role: "user", content: "hi" }),
    );
    assert.doesNotMatch(out, /## Assistant/);
    assert.equal(out, "## User\n\nhi");
  });
});

describe("renderTranscript — clipping", () => {
  it("clips tool results much harder than assistant prose", () => {
    // The whole point of two limits: bulk output is cheap to lose, reasoning is not.
    assert.ok(TOOL_RESULT_CLIP < TEXT_CLIP);

    const long = "x".repeat(TEXT_CLIP + 100);
    const toolOut = renderTranscript(source({ role: "toolResult", toolName: "bash", content: long }));
    const proseOut = renderTranscript(source({ role: "assistant", content: [{ type: "text", text: long }] }));

    assert.ok(toolOut.length < proseOut.length);
    assert.match(toolOut, /\[.* more chars\]/);
    assert.match(proseOut, /\[100 more chars\]/);
  });

  it("clips shell output but keeps the command and exit code intact", () => {
    const out = renderTranscript(
      source({ role: "bashExecution", command: "yes", exitCode: 1, output: "y\n".repeat(TOOL_RESULT_CLIP) }),
    );
    assert.match(out, /`yes` → exit 1/);
    assert.match(out, /\[.* more chars\]/);
  });

  it("renders shell output that is missing rather than throwing", () => {
    const out = renderTranscript(source({ role: "bashExecution", command: "true", exitCode: 0 }));
    assert.match(out, /`true` → exit 0/);
    assert.doesNotMatch(out, /undefined/);
  });
});
