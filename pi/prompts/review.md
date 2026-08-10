---
description: Code review for quality, security, and maintainability
---
Review code changes for quality. Default scope is the working diff
(`git diff` + `git diff --cached`); if empty, review `git show HEAD`.

Find bugs, security issues, missing error handling, and edge cases. For each,
give: file:line, severity (blocker/major/minor/nit), and the fix. End with a
one-line verdict. Skip praise and unchanged code.
