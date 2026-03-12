# Mahammad's workflow/guidelines

## Principles
- Being simple and efficient.
- The favorite engineer - Linus Torvalds
- Love the simple abstraction of "everything is file in linux", "everything is buffer in neovim"
- I hate writing more 70 lines of code for doing a change into existing system.


## Bash Commands
- Never chain commands with `&&`, `||`, or `;` — use single commands only.
- Instead of `cd /path && git log`, use `git -C /path log`.
- Instead of `cd /path && ls`, use `ls /path`.
- Instead of `cd /path && find ...`, use `find /path ...`.
- Instead of `cd /path && grep ...`, use `grep ... /path`.
- Instead of `cd /path && bazel build ...`, use `bazel build` with the full target path.
- Use absolute paths rather than changing directories.
