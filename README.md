# devenv

Personal development environment managed with Ansible.

## Usage

### Uber (default)

```bash
ansible-playbook configure.yml
```

### Personal

```bash
ansible-playbook configure.yml -e profile=personal
```

## Profiles

| Feature | `uber` (default) | `personal` |
|---|---|---|
| Shell (zsh, p10k, tmux) | yes | yes |
| Neovim config | yes | yes |
| Claude Code settings | `claude/settings.json` (apiKeyHelper, otelHeadersHelper, bazel, MCP tools) | `claude/personal.json` (plugins, bash read commands) |
| go-code .envrc.local | yes | no |

## Using just the pi config

The `pi/` directory is also a standalone [pi](https://pi.dev) package (see
`package.json`), so anyone can install the pi setup — capability registry,
background agents, read-only bash tool, themes — without cloning for ansible:

```bash
pi install git:github.com/MahammadAgayev/devenv
```

This clones the repo under `~/.pi/agent/git/…` and loads resources from
`pi/extensions`, `pi/skills`, and `pi/themes`. Run `pi update --all` to pull
updates. See [`pi/README.md`](pi/README.md) for what's included and how it works.
