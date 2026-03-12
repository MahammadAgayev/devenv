# Claude Code Guidelines

## Bash Commands
- Never chain commands with `&&`, `||`, or `;` — use single commands only.
- Instead of `cd /path && git log`, use `git -C /path log`.
- Instead of `cd /path && ls`, use `ls /path`.
- Instead of `cd /path && find ...`, use `find /path ...`.
- Instead of `cd /path && grep ...`, use `grep ... /path`.
- Instead of `cd /path && bazel build ...`, use `bazel build` with the full target path.
- Use absolute paths rather than changing directories.
