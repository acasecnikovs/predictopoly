#!/usr/bin/env bash
# Push web/ to Cloudflare Pages (predictopoly project, direct upload).
# Wrangler wants a TTY for OAuth-authed pages commands; `script -q /dev/null`
# allocates one inside non-interactive shells.
set -euo pipefail
cd "$(dirname "$0")/.."
exec script -q /dev/null wrangler pages deploy web \
  --project-name=predictopoly \
  --branch=main \
  --commit-dirty=true
