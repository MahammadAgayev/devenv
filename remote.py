#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys

CONFIG_PATH = os.path.expanduser("~/.devenv.json")

GREEN = "\033[32m"
RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"

DEBUG = False


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


def save_config(config):
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")


def get_remotes(config):
    return config.get("remotes", {})


def resolve_targets(config, names):
    remotes = get_remotes(config)
    if not remotes:
        print(f"{RED}error: no remotes configured{RESET}")
        sys.exit(1)
    if not names:
        return remotes
    missing = [n for n in names if n not in remotes]
    if missing:
        print(f"{RED}error: unknown remotes: {', '.join(missing)}{RESET}")
        sys.exit(1)
    return {n: remotes[n] for n in names}


def _merge_zsh_history(lines):
    """Merge zsh history lines, deduplicating by command text."""
    extended = {}  # cmd -> (timestamp, elapsed)
    plain = []

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith(": "):
            try:
                rest = line[2:]
                colon_idx = rest.index(":")
                semi_idx = rest.index(";", colon_idx)
                ts = int(rest[:colon_idx])
                elapsed = rest[colon_idx + 1 : semi_idx]
                cmd = rest[semi_idx + 1 :]
                # Handle backslash-continued multi-line commands
                while cmd.endswith("\\") and i + 1 < len(lines):
                    i += 1
                    cmd += "\n" + lines[i]
                if cmd not in extended or extended[cmd][0] < ts:
                    extended[cmd] = (ts, elapsed)
            except (ValueError, IndexError):
                if line:
                    plain.append(line)
        elif line:
            plain.append(line)
        i += 1

    result = []
    for cmd, (ts, elapsed) in sorted(extended.items(), key=lambda x: x[1][0]):
        result.append(f": {ts}:{elapsed};{cmd}")

    seen = set()
    for line in reversed(plain):
        if line not in seen:
            seen.add(line)
            result.append(line)

    return result


def _sync_history(targets):
    local_path = os.path.expanduser("~/.zsh_history")
    all_lines = []
    if os.path.exists(local_path):
        with open(local_path, "rb") as f:
            all_lines = f.read().decode("utf-8", errors="replace").splitlines()

    for name, info in targets.items():
        host = info["host"]
        result = subprocess.run(["ssh", host, "cat ~/.zsh_history"], capture_output=True)
        if result.returncode == 0:
            all_lines.extend(result.stdout.decode("utf-8", errors="replace").splitlines())

    merged = _merge_zsh_history(all_lines)
    merged_bytes = ("\n".join(merged) + "\n").encode("utf-8")

    with open(local_path, "wb") as f:
        f.write(merged_bytes)

    for name, info in targets.items():
        host = info["host"]
        result = subprocess.run(
            ["ssh", host, "cat > ~/.zsh_history"],
            input=merged_bytes,
            capture_output=True,
        )
        if result.returncode != 0:
            print(f"{RED}history push error{RESET} {name}")

    print(f"history: synced {len(merged)} commands")


def cmd_sync(args):
    config = load_config()
    targets = resolve_targets(config, args.names)

    if args.configure:
        post_pull = " && python3 sync.py sync"
    else:
        post_pull = ""

    clone_url = "https://github.com/MahammadAgayev/devenv"

    failed = []
    for name, info in targets.items():
        host = info["host"]
        path = info.get("path", "~/devenv")
        if args.all:
            cmd = (
                f"if [ -d {path} ]; then cd {path} && git pull; "
                f"else git clone {clone_url} {path}; fi "
                f"&& cd {path} && python3 sync.py all"
            )
        else:
            cmd = f"cd {path} && git pull{post_pull}"
        if DEBUG:
            print(f"{BOLD}[{name}]{RESET} {host} → {cmd}")
        capture = not DEBUG
        rc = subprocess.run(
            ["ssh", host, cmd],
            capture_output=capture,
        ).returncode
        if rc == 0:
            print(f"{GREEN}ok{RESET} {name}")
        else:
            print(f"{RED}error{RESET} {name} (exit {rc})")
            failed.append(name)

    if not args.no_history:
        _sync_history(targets)

    return 1 if failed else 0


def cmd_list(args):
    remotes = get_remotes(load_config())
    if not remotes:
        print("No remotes configured.")
        return 0
    for name, info in remotes.items():
        path = info.get("path", "~/devenv")
        print(f"  {BOLD}{name}{RESET}  {info['host']}  {path}")
    return 0


def cmd_add(args):
    config = load_config()
    remotes = config.setdefault("remotes", {})
    remotes[args.name] = {"host": args.host, "path": args.path}
    save_config(config)
    print(f"{GREEN}ok{RESET}")
    return 0


def cmd_remove(args):
    config = load_config()
    remotes = config.get("remotes", {})
    if args.name not in remotes:
        print(f"{RED}error: unknown remote: {args.name}{RESET}")
        return 1
    del remotes[args.name]
    save_config(config)
    print(f"{GREEN}ok{RESET}")
    return 0


def main():
    global DEBUG

    parser = argparse.ArgumentParser(description="Sync devenv on remote machines")
    parser.add_argument("--debug", action="store_true", help="Show verbose output")
    sub = parser.add_subparsers(dest="command")

    sp = sub.add_parser("sync", help="Sync remotes (default)")
    sp.add_argument("names", nargs="*", help="Remotes to sync (all if omitted)")
    sp.add_argument("--configure", action="store_true", help="Also run sync.py sync")
    sp.add_argument("--all", action="store_true", help="Also run sync.py all")
    sp.add_argument("--no-history", action="store_true", help="Skip zsh history sync")

    sub.add_parser("list", help="List configured remotes")

    ap = sub.add_parser("add", help="Add a remote")
    ap.add_argument("name", help="Name for this remote")
    ap.add_argument("host", help="SSH target (e.g. user@host)")
    ap.add_argument("--path", default="~/devenv", help="Path to devenv on remote")

    rp = sub.add_parser("remove", help="Remove a remote")
    rp.add_argument("name", help="Remote to remove")

    args = parser.parse_args()
    DEBUG = args.debug

    if args.command is None:
        parser.print_help()
        return 0

    commands = {"sync": cmd_sync, "list": cmd_list, "add": cmd_add, "remove": cmd_remove}
    return commands[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
