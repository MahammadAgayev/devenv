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
