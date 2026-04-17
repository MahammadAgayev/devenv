# Mahammad's workflow/guidelines

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Limit changes**: If we are doing change to any existing we should plan in a way that, each PR is limited to 70 lines as much as possible
- The favorite engineer - John Carmack
- Love the simple abstraction of "everything is file in linux", "everything is buffer in neovim"

## Tool Hints
- Permissions are matched by command prefix (e.g. `Bash(find *)`). Chaining commands with `&&`, `||`, `;`, or `|` breaks prefix matching and triggers unnecessary permission prompts.
- Always use single commands with absolute paths so they match the allowed permission patterns.
- Instead of `cd /path && git log`, use `git -C /path log`.
- Instead of `cd /path && ls`, use `ls /path`.
- Instead of `cd /path && find ...`, use `find /path ...`.
- Instead of `cd /path && grep ...`, use `grep ... /path`.
- Instead of `cd /path && bazel build ...`, use `bazel build` with the full target path.
- Approved commands: `basename`, `cat`, `cut`, `date`, `diff`, `dirname`, `du`, `echo`, `env`, `file`, `find`, `git diff`, `git log`, `git status`, `git -C <path> diff/log/status`, `grep`, `head`, `jq`, `ls`, `printenv`, `pwd`, `realpath`, `sort`, `stat`, `tail`, `test`, `tree`, `uniq`, `wc`, `which`, `bazel build`, `bazel test`, `WebFetch`.
