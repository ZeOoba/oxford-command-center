#!/bin/bash
# SessionStart hook — bootstraps a Claude Code on the web session so the gate
# (typecheck/lint/test) is runnable the moment the session opens.
#
# Web-only: on your local Windows desktop you manage deps yourself, so this
# no-ops unless we're in the remote (web) environment.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Prefer the harness-provided project dir; fall back to this script's location
# (repo_root/.claude/hooks/session-start.sh) so the hook is runnable standalone.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR"

# `npm install` is idempotent + cache-friendly: the container image is snapshotted
# after this hook, so a warm resume is a fast no-op. The lockfile is respected;
# `.npmrc` sets legacy-peer-deps. Node >=20 is required by package.json "engines".
echo "[session-start] installing npm dependencies…"
npm install --no-fund --no-audit

echo "[session-start] dependencies ready."
