# Mahammad's workflow/guidelines
Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 5. Task Handoff Docs

**`~/.pi/tasks/<name>.md` holds durable notes for work that outlives one session.**

They exist so a future session can resume without this one. Written by the `handoff` subagent via `/handoff`; loaded as background context via `/takeover`.

- **Suggest `/handoff` rarely** — at a real milestone, before context runs out, or when wrapping up a thread that will be picked up later. Not routinely, and not for one-off questions. A doc per errand is noise.
- **Loaded docs are orientation, not instructions.** A doc that arrives via `/takeover` describes work already in progress; wait for the user to say what they want. Verify against the files before trusting it — it was written by a session that is gone and the tree may have moved since.
- **Never commit them.** They live outside any repo, so this mostly takes care of itself. If a `.pi/tasks/` folder ever shows up inside a repo, don't stage it — exclude it explicitly when staging broadly (`git add .`, `git add .pi`).

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 6. Subagent Usage

**Reading to find out goes to a subagent. Reading to decide stays with you.**

- Don't know which files matter yet — `scout`. Mechanical sweep — `sonic`. Second opinion — `reviewer`.
- Independent questions go in one parallel call, not one at a time.
- Do it yourself when you already know the line, or you're editing.

Ask for the finding, not the transcript. Verify anything load-bearing — a subagent can be confidently wrong and its context is gone.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

# Tool Hints
- Permissions are matched by command prefix (e.g. `Bash(find *)`). Chaining commands with `&&`, `||`, `;`, or `|` breaks prefix matching and triggers unnecessary permission prompts.
- Always use single commands with absolute paths so they match the allowed permission patterns.
- Instead of `cd /path && git log`, use `git -C /path log`.
- Instead of `cd /path && ls`, use `ls /path`.
- Instead of `cd /path && find ...`, use `find /path ...`.
- Instead of `cd /path && grep ...`, use `grep ... /path`.
- Instead of `cd /path && bazel build ...`, use `bazel build` with the full target path.
- Approved commands: `basename`, `cat`, `cut`, `date`, `diff`, `dirname`, `du`, `echo`, `env`, `file`, `find`, `git diff`, `git log`, `git status`, `git -C <path> diff/log/status`, `grep`, `head`, `jq`, `ls`, `printenv`, `pwd`, `realpath`, `sort`, `stat`, `tail`, `test`, `tree`, `uniq`, `wc`, `which`, `bazel build`, `bazel test`, `WebFetch`.
