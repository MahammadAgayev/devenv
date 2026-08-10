# pi config (devenv)

A pi package. Loaded via the `"~/devenv"` entry in `packages` (see
`settings.*.json`) — not symlinked. `ansible/configure.yml` still symlinks the
top-level config files (settings/models/keybindings/AGENTS.md).

## Layout

| Folder | Loaded as | What |
|--------|-----------|------|
| `extensions/` | package extensions | TypeScript extensions (tools, commands, UI) |
| `prompts/` | package prompts | Prompt templates — each `.md` becomes a `/command` |
| `skills/` | package skills | Skills (auto-discovered by intent) |
| `themes/` | package themes | Color themes |

The repo root `package.json` declares the `pi` manifest with
`extensions`/`prompts`/`skills`/`themes` entries under `pi/`.

`settings.uber.json` / `models.uber.json` symlink to `settings.json` / `models.json`
on the `uber` profile (`settings.json` / `models.json` on `personal`). Both list
`"~/devenv"` in `packages`, which is what loads everything above.

Run `/reload` in pi after editing to apply without restarting.

## Prompt templates

Each `prompts/*.md` is a prompt template. The filename becomes the command name
(e.g. `review.md` → `/review`). Standard pi prompt template format — frontmatter
with `description:`, body is the prompt text. Arguments are supported via `$1`,
`$@`, etc.

Current prompts: `/review`, `/simplify`, `/recon`, `/plan`, `/tdd`.

## Using this config elsewhere

The `pi/` directory is a pi package (manifest in the repo-root `package.json`),
so installing it is one command:

```bash
pi install git:github.com/MahammadAgayev/devenv
```

This clones the repo under `~/.pi/agent/git/…` and loads `pi/extensions`,
`pi/prompts`, `pi/skills`, and `pi/themes`. Run `pi update --all` to pull
updates.

**Settings/models are NOT part of the package** — `settings.uber.json` /
`models.uber.json` carry Uber-specific bits (`apiKeyHelper`, gateway env, bazel
perms, `code-mcp`). Copy the parts you want into your own
`~/.pi/agent/settings.json`. Minimum useful keys: `theme` (e.g. `rose-pine-moon`
or `tokyonight-night`) and `defaultThinkingLevel`. Use `pi config` to
enable/disable individual resources from the installed package.

## readonly_bash

A global tool that runs only non-destructive shell commands, gated by the same
`isSafeCommand` allowlist as plan mode.
