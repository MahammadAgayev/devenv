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

## arh CLI — Stacked Diffs Workflow (GitHub)

`arh` (Arrowhead) is Uber's GitHub-based stacked diffs CLI. It manages feature branch **trees** where each branch is parented on another, enabling dependent PRs to be published, rebased, and merged in order.

### Mental Model

```
main → feature-A → feature-B → feature-C
```

Each node is a branch. Each branch gets its own PR targeting its parent. Merging flows from root to leaf.

### Core Commands

| Command | What it does |
|---|---|
| `arh feature <name>` | Create new branch off current (alias: `ft`) |
| `arh publish` | Create/update PRs from root to current branch |
| `arh publish --full-stack` | Publish entire tree root→leaf |
| `arh rebase --sync` | Pull main + smart-rebase entire stack |
| `arh log -t .` | Show full stack tree from current branch |
| `arh checkout next/prev` | Navigate up/down the stack |
| `arh tidy` | Remove branches whose PRs are already merged |
| `arh discard -f <branch>` | Delete one branch, re-parent its children |
| `arh pubslih --no-interactive --change-planned` | publish PR to showcase the code|

### Commit Message Format (auto-populates PR)

```
<PR Title>

Summary:
<Description>

Test Plan:
<How tested>

Jira Issues: PROJECT-1234
```

### Stacked Diff Ideas & Patterns

**Slice by concern, not by size** — each stack layer should be a coherent unit:
- Layer 1: schema/migration changes
- Layer 2: data layer / repository
- Layer 3: service/business logic
- Layer 4: API/handler
- Layer 5: tests

**Keep layers ≤70 lines** (matches PR size principle) — forces clean slicing.

**Sync before you publish** — always `arh rebase --sync` before `arh publish` to avoid stale base conflicts.

**Use `arh log -t . -s`** to see PR status across the whole stack at a glance (add `-c` for commit counts).

**Tidy frequently** — run `arh tidy` after merges to keep the tree clean; avoids rebasing already-merged branches.

**Auto-merge the leaf** — use `arh publish --auto-merge` on the final layer once all ancestors are approved; they merge in order automatically.

**Restack for mid-stack insertions** — if you need to inject a new layer between A and B: create new branch off A, then `arh restack -p <new-branch> -f B` to re-parent B.

## Tool Hints
- Permissions are matched by command prefix (e.g. `Bash(find *)`). Chaining commands with `&&`, `||`, `;`, or `|` breaks prefix matching and triggers unnecessary permission prompts.
- Always use single commands with absolute paths so they match the allowed permission patterns.
- Instead of `cd /path && git log`, use `git -C /path log`.
- Instead of `cd /path && ls`, use `ls /path`.
- Instead of `cd /path && find ...`, use `find /path ...`.
- Instead of `cd /path && grep ...`, use `grep ... /path`.
- Instead of `cd /path && bazel build ...`, use `bazel build` with the full target path.
- Approved commands: `basename`, `cat`, `cut`, `date`, `diff`, `dirname`, `du`, `echo`, `env`, `file`, `find`, `git diff`, `git log`, `git status`, `git -C <path> diff/log/status`, `grep`, `head`, `jq`, `ls`, `printenv`, `pwd`, `realpath`, `sort`, `stat`, `tail`, `test`, `tree`, `uniq`, `wc`, `which`, `bazel build`, `bazel test`, `WebFetch`.
