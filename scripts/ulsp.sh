#!/bin/sh
set -x

# Autodetect the monorepo checkout. First match wins; override with ULSP_MONOREPO.
if [ -z "$ULSP_MONOREPO" ]; then
  for candidate in "$HOME/go-code" "$HOME/fievel" "$HOME/java-code"; do
    if [ -d "$candidate/tools/ide/ulsp" ]; then
      ULSP_MONOREPO="$candidate"
      break
    fi
  done
fi

if [ -z "$ULSP_MONOREPO" ]; then
  echo "ulsp.sh: no monorepo with tools/ide/ulsp found; set ULSP_MONOREPO" >&2
  exit 1
fi

# devpod.yaml vs local.yaml overlay, matching tooling/shell/devpod's is_devpod().
if [ -n "$DEVPOD_ENVIRONMENT" ]; then
  ULSP_ENVIRONMENT=devpod
else
  ULSP_ENVIRONMENT=local
fi
export ULSP_ENVIRONMENT

cd "$ULSP_MONOREPO" || exit 1
while true; do
  UBER_CONFIG_DIR="$ULSP_MONOREPO/tools/ide/ulsp/config" uexec "$ULSP_MONOREPO/tools/ide/ulsp/ulsp-daemon" || true
  sleep 5
done
