---
name: simplify
prompt: simplify
agent: simplifier
description: Simplifies code while preserving behavior exactly (dead code, redundant abstractions, duplication)
tools: read,grep,find,ls,readonly_bash
---

Simplify code while preserving behavior exactly. Default scope is the working
diff (`git diff`) unless a scope is given.

Reduce complexity: remove dead code, redundant abstractions, and needless
cleverness; unify duplicated logic. List what you'll change and why, then apply.
Don't touch public APIs or observable behavior without asking. Keep tests green.
