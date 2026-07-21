# Task: pi-refactor

## Goal
Bring the pi coding-agent environment fully under the devenv repo so it is
version-controlled and deployed via Ansible like the rest of the dotfiles:
vendor chosen skills into the repo, wire them up through `configure.yml`
symlinks, and fix bugs in the custom pi extensions (task-handoff, plan-mode,
skill-discovery).

## Summary
Current state of the pi setup in devenv:

- **tdd skill vendored**: moved from the floating global dir `~/.agents/skills/tdd`
  into `pi/skills/tdd/` (SKILL.md, agents/openai.yaml, mocking.md, tests.md).
  `~/.agents/` was deleted entirely, which also removed the other 21
  mattpocock/vercel skills that were installed there. Only `tdd` survives.
- **Ansible symlink added**: `ansible/configure.yml` now symlinks
  `~/.pi/agent/skills` → `{{ devenv }}/pi/skills` (alongside the existing
  extensions/lib symlinks). `sync.py sync` was run and the symlink is live;
  pi resolves `tdd` from the repo.
- **task-handoff.ts bug fixed**: `/handoff` and `/takeover` were calling
  `ctx.sendUserMessage(...)`, which only exists on the ReplacedSessionContext
  inside `withSession()`. Changed both to `pi.sendUserMessage(...)`. Extension
  now loads and runs cleanly.
- **tmux csi-u**: added `set -g extended-keys-format csi-u` to
  `dotfiles/.tmux.conf` (symlinked to ~/.tmux.conf) to clear pi's
  extended-keys warning. Reloaded into the running tmux server.

Staged: `ansible/configure.yml`, `pi/skills/tdd/*`, plus the initial import of
all `pi/extensions/*`, `pi/lib/paths.ts`, `pi/models*.json`,
`pi/settings.uber.json` (this whole pi setup is a fresh, never-committed import).

Unstaged (not yet committed): `pi/extensions/task-handoff.ts` (the sendUserMessage
fix), `dotfiles/.tmux.conf`, and pre-existing local edits to `claude/uber.json`
and `dotfiles/.gitconfig` that predate this session.

In flight / open items:
- `skill-discovery` extension references `~/.pi/agents/lib/find-skill.js`
  (note the wrong `agents` path — should likely be under the playground repo);
  it throws MODULE_NOT_FOUND but does not crash pi. Not yet investigated.
- Nothing has been committed yet — user has been staging incrementally.

## Log
- 2026-07-21 11:18 — Vendored tdd skill into pi/skills/, added the
  ~/.pi/agent/skills Ansible symlink and ran sync; deleted ~/.agents entirely;
  fixed ctx→pi sendUserMessage in task-handoff.ts; added tmux csi-u
  extended-keys-format and reloaded tmux; staged tdd skill + configure.yml.
