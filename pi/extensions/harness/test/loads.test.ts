/**
 * Every harness module must load on its own.
 *
 * Two failures this catches, both of which shipped at least once:
 *
 * 1. **A parse error pi rejects.** `node --experimental-strip-types --check`
 *    is not a TypeScript syntax gate — with no `"type": "module"` in
 *    package.json it reparses the file as CommonJS and returns success on
 *    TypeScript that pi's loader refuses. A malformed `consultOracle` in
 *    loop.ts passed `--check` and passed the whole test suite, because no test
 *    imported loop.ts; the only symptom was `/harness` failing to load at
 *    startup. Importing is the check that agrees with pi.
 *
 * 2. **A top-level import of a package.** This repo has no node_modules, so a
 *    runtime `import` of `@earendil-works/*` or typebox anywhere in the module
 *    graph makes the file unloadable here. `import type` erases and is fine;
 *    `runAgentHeadless` must stay behind a deferred `await import()` inside a
 *    function. Getting this wrong makes the whole suite unrunnable, which is
 *    exactly the kind of breakage that is hard to attribute after the fact.
 *
 * Every other test in this directory tests a function. This one tests that the
 * files are loadable at all — the precondition for the rest meaning anything.
 *
 * Run: node --experimental-strip-types --test pi/extensions/harness/test/loads.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every module in harness/, discovered rather than listed so a new file is covered by default. */
const modules = readdirSync(harnessDir)
  .filter((f) => f.endsWith(".ts"))
  .sort();

describe("harness modules load without a node_modules", () => {
  it("finds the modules to check", () => {
    // A bad glob silently testing nothing is the classic way for a guard like
    // this to rot, so assert the discovery itself.
    assert.ok(modules.length >= 8, `expected the harness modules, found ${modules.join(", ")}`);
    for (const expected of ["index.ts", "loop.ts", "oracle.ts", "state.ts", "recap.ts"]) {
      assert.ok(modules.includes(expected), `${expected} should be present`);
    }
  });

  for (const file of modules) {
    it(`${file} imports cleanly`, async () => {
      // Any throw here is a real failure: a syntax error pi would reject, or a
      // top-level package import that cannot resolve without node_modules.
      await import(join(harnessDir, file));
    });
  }
});

describe("shared lib modules load without a node_modules", () => {
  // lib/ exists precisely so extension code can be imported without pi; if one
  // of these grows a package import it stops being shared code.
  for (const file of ["transcript.ts"]) {
    it(`lib/${file} imports cleanly`, async () => {
      await import(join(harnessDir, "..", "lib", file));
    });
  }
});
