#!/bin/sh
set -x
#go
monorepo="/home/user/go-code"  # Replace with your monorepo path
#java
#monorepo="/home/user/fievel"

cd "$monorepo" || exit 1
while true; do
  # on devpod, use ULSP_ENVIRONMENT=devpod
  UBER_CONFIG_DIR="$monorepo/tools/ide/ulsp/config" ULSP_ENVIRONMENT=local uexec "$monorepo/tools/ide/ulsp/ulsp-daemon" || true
  sleep 5
done
