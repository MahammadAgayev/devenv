#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys

CONFIG_PATH = os.path.expanduser("~/.devenv.json")
DEVENV_DIR = os.path.dirname(os.path.abspath(__file__))


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


def save_config(config):
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")


def get_profile():
    config = load_config()
    if "profile" not in config:
        print("No profile configured. Choose one:")
        print("  1) uber")
        print("  2) personal")
        choice = input("Enter 1 or 2: ").strip()
        profile = "uber" if choice == "1" else "personal"
        config["profile"] = profile
        save_config(config)
        print(f"Saved profile: {profile}")
    return config["profile"]


def get_environment():
    config = load_config()
    if "environment" not in config:
        print("No environment configured. Choose one:")
        print("  1) local (default)")
        print("  2) go-devpod")
        choice = input("Enter 1 or 2: ").strip()
        environment = "go-devpod" if choice == "2" else "local"
        config["environment"] = environment
        save_config(config)
        print(f"Saved environment: {environment}")
    return config["environment"]


def run_playbook(playbook, profile, environment):
    cmd = ["ansible-playbook", os.path.join(DEVENV_DIR, "ansible", playbook), "-e", f"profile={profile}", "-e", f"environment={environment}"]
    return subprocess.run(cmd).returncode


def cmd_sync(args):
    profile = get_profile()
    environment = get_environment()
    return run_playbook("configure.yml", profile, environment)


def cmd_install(args):
    profile = get_profile()
    environment = get_environment()
    return run_playbook("install.yml", profile, environment)


def cmd_all(args):
    profile = get_profile()
    environment = get_environment()
    rc = run_playbook("configure.yml", profile, environment)
    if rc != 0:
        return rc
    return run_playbook("install.yml", profile, environment)


def cmd_config(args):
    config = load_config()
    if args.profile:
        config["profile"] = args.profile
        save_config(config)
        print(f"Profile set to: {args.profile}")
    elif args.environment:
        config["environment"] = args.environment
        save_config(config)
        print(f"Environment set to: {args.environment}")
    else:
        print(json.dumps(config, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description="Devenv sync CLI")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("sync", help="Sync symlinks (default)")
    subparsers.add_parser("install", help="Install dependencies")
    subparsers.add_parser("all", help="Sync + install")

    config_parser = subparsers.add_parser("config", help="Show/set config")
    config_parser.add_argument("--profile", choices=["uber", "personal"], help="Set profile")
    config_parser.add_argument("--environment", choices=["local", "go-devpod"], help="Set environment")

    args = parser.parse_args()

    if args.command is None or args.command == "sync":
        return cmd_sync(args)
    elif args.command == "install":
        return cmd_install(args)
    elif args.command == "all":
        return cmd_all(args)
    elif args.command == "config":
        return cmd_config(args)


if __name__ == "__main__":
    sys.exit(main())
