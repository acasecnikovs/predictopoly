#!/usr/bin/env bash
# Push web/ to Cloudflare Pages (predictopoly project, direct upload).
# Wrangler wants a TTY for OAuth-authed pages commands; `script -q /dev/null`
# allocates one inside non-interactive shells. Wrapping in `bash -c` rather
# than exec'ing wrangler directly survives more parent-shell environments.
set -euo pipefail
cd "$(dirname "$0")/.."
exec script -q /dev/null bash -c "wrangler pages deploy web --project-name=predictopoly --branch=main --commit-dirty=true"
