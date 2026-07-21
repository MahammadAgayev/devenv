# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Personal development environment manager using Ansible. Manages dotfiles, Neovim config, Claude Code settings, and shell tooling across two profiles (`uber` and `personal`) and two workspaces (`local` and `go-devpod`).

## Key Commands

```bash
# Setup symlinks (configure.yml)
python3 sync.py sync

# Install packages (install.yml)
python3 sync.py install

# Both
python3 sync.py all

# View or change profile/workspace
python3 sync.py config
python3 sync.py config --profile uber --workspace local

# Direct Ansible (runs from ansible/ dir)
ansible-playbook ansible/configure.yml
ansible-playbook ansible/configure.yml -e profile=personal -e workspace=go-devpod
ansible-playbook ansible/install.yml
ansible-playbook ansible/cleanup.yml

# Remote machine management
python3 remote.py list
python3 remote.py sync [name]        # git pull + sync on remote
python3 remote.py sync --all         # clone + full install on remote
python3 remote.py add <name> <host>
```

Profile and workspace are stored in `~/.devenv.json`. Ansible variables `profile` and `workspace` control which tasks run.

## Architecture

### Profiles & Workspaces

- **Profile** (`uber` | `personal`): Controls which Claude settings file is symlinked, whether Uber-specific tools (bazel, MCP, go-code envrc) are configured.
- **Workspace** (`local` | `go-devpod`): Controls whether go-devpod-specific configs (`.envrc.local`, `ulsp.sh`) are deployed.

### How Symlinks Work

`ansible/configure.yml` is the source of truth for what gets symlinked where. Each dotfile lives in the repo and gets symlinked to `~/$HOME/`. Neovim config (`nvim/`) → `~/.config/nvim`. Claude settings (`claude/uber.json` or `claude/personal.json`) → `~/.claude/settings.json`.

The RTK hook (`claude/hooks/rtk-rewrite.sh`) is always symlinked to `~/.claude/hooks/rtk-rewrite.sh` regardless of profile.

### Claude Code Settings

Two settings files, never edit `~/.claude/settings.json` directly — it's a symlink:

- `claude/uber.json` — Uber profile: has `apiKeyHelper`, `otelHeadersHelper`, bazel permissions, `code-mcp` MCP server, `uber-dev` and `uber-reviewer` agents
- `claude/personal.json` — Personal: minimal, no MCP, no bazel, basic LSP only

`agents/AGENTS.md` (symlinked to both `~/.claude/CLAUDE.md` and `~/.pi/agent/AGENTS.md`) contains workflow guidelines — edit it here, not in `~/.claude/` or `~/.pi/`.

### RTK Hook

`claude/hooks/rtk-rewrite.sh` is a PreToolUse hook that rewrites bash commands to RTK equivalents for token savings. All rewrite logic lives in `rtk rewrite` (Rust binary) — the shell script just delegates. Requires `rtk >= 0.23.0` and `jq`.

### Remote Sync

`remote.py` SSHes into registered remotes (stored in `~/.devenv.json` under `remotes`), runs git pull, and optionally runs `sync.py`. It also merges zsh history across machines (dedup by timestamp).

### Post-Merge Hook

`git-hooks/devenv-post-merge` runs `python3 sync.py sync` automatically after `git pull`. Installed by `configure.yml`.
