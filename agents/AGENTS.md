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

## 5. Git Staging

**Handoff docs live in `~/.pi/tasks/` (outside any repo) — never commit task docs.**

- `~/.pi/tasks/<name>.md` holds local handoff docs written by `/handoff`. They are global and repo-independent, so they normally can't be staged by accident.
- If a `.pi/tasks/` folder ever appears inside a repo, do not stage or commit anything under it. When staging with a broad path (e.g. `git add .` or `git add .pi`), exclude it explicitly.

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
