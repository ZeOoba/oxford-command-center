#!/usr/bin/env node
/**
 * bash-guard.mjs - PreToolUse hook for the Bash tool.
 *
 * Blocks the always-wrong command classes named in CLAUDE.md:
 *   (a) git add -A / --all / bare '.' pathspec        (CLAUDE.md 2 - explicit paths only)
 *   (b) git commit --no-verify / -n                   (CLAUDE.md 9 - never bypass the gate)
 *   (c) git push --force / -f (--force-with-lease ok) (CLAUDE.md 8 - escalate to Gabriel)
 *   (d) git config touching core.hooksPath            (hook-tampering)
 *   (e) sqlite3 write DDL/DML against the live warehouse (CLAUDE.md 9)
 *   (f) rm/unlink of data/warehouse or data/overlay.json (CLAUDE.md 9)
 *
 * There is NO override sentinel for these - they are always wrong per doctrine.
 *
 * FAIL-OPEN by design (EOS doctrine: process gates fail open): any stdin/JSON
 * error exits 0 silently. A deny is emitted as PreToolUse hookSpecificOutput
 * JSON on stdout with exit 0.
 *
 * Zero dependencies. Node >= 20. Runs identically on Windows and Linux.
 */
import { readFileSync } from 'node:fs';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/** Index of `sub` appearing after a `git` token in the token list, or -1. */
function gitSubcommandIndex(tokens, sub) {
  const gi = tokens.indexOf('git');
  if (gi === -1) return -1;
  return tokens.indexOf(sub, gi + 1);
}

/** True when token is a single-dash short-option cluster containing letter `ch`. */
function shortClusterHas(token, ch) {
  return (
    token.startsWith('-') &&
    !token.startsWith('--') &&
    /^-[a-zA-Z]+$/.test(token) &&
    token.includes(ch)
  );
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) process.exit(0);

  // (e) live-warehouse write DDL/DML - checked on the FULL command so pipes
  // (echo "DELETE ..." | sqlite3 data/warehouse/finance.sqlite) cannot split it.
  if (
    /\b(?:sqlite3|better-sqlite3)\b/.test(command) &&
    /data[\\/]warehouse[\\/]finance\.sqlite/i.test(command) &&
    /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT|VACUUM)\b/i.test(command)
  ) {
    deny(
      'Write DDL/DML against the live warehouse (data/warehouse/finance.sqlite) is blocked (CLAUDE.md 9). Schema/data changes go through server/warehouse/migrations/ and npm run warehouse:backfill.',
    );
  }

  // Split compound commands so checks are scoped per invocation.
  const segments = command.split(/(?:\|\||&&|[;|\n])/);

  for (const rawSeg of segments) {
    // Blank out quoted strings so commit-message content etc. cannot false-positive
    // the token checks. Raw segment is kept for path/regex checks.
    const strippedSeg = rawSeg
      .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
      .replace(/'[^']*'/g, " '' ");
    const tokens = strippedSeg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // (a) git add -A / --all / bare '.'
    const ai = gitSubcommandIndex(tokens, 'add');
    if (ai !== -1) {
      const rest = tokens.slice(ai + 1);
      if (rest.some((t) => t === '--all' || t === '.' || shortClusterHas(t, 'A'))) {
        deny(
          'git add -A/--all/. is blocked: commit with explicit paths only (CLAUDE.md 2). Uncommitted files you did not create are another writer in-progress work.',
        );
      }
    }

    // (b) git commit --no-verify / -n (token-scoped to the commit invocation)
    const ci = gitSubcommandIndex(tokens, 'commit');
    if (ci !== -1) {
      const rest = tokens.slice(ci + 1);
      if (rest.some((t) => t === '--no-verify' || shortClusterHas(t, 'n'))) {
        deny(
          'git commit --no-verify/-n is blocked: the gate must run on every commit (CLAUDE.md 9). Fix the failing step instead of bypassing it.',
        );
      }
    }

    // (c) git push --force / -f (--force-with-lease is allowed)
    const pi = gitSubcommandIndex(tokens, 'push');
    if (pi !== -1) {
      const rest = tokens.slice(pi + 1);
      if (rest.some((t) => t === '--force' || shortClusterHas(t, 'f'))) {
        deny(
          'git push --force/-f is blocked (CLAUDE.md 8): never force-push; if a force-push is truly needed, use --force-with-lease on a feature branch or escalate to Gabriel.',
        );
      }
    }

    // (d) git config / git -c touching core.hooksPath
    if (tokens.includes('git') && /core\.hookspath/i.test(rawSeg)) {
      deny(
        'Changing core.hooksPath is blocked: git hook-path tampering disables the repo safety hooks (CLAUDE.md 9).',
      );
    }

    // (f) rm/unlink of the live warehouse or overlay
    const isRm = tokens.some(
      (t) => t === 'rm' || t === 'unlink' || t.endsWith('/rm') || t.endsWith('/unlink'),
    );
    if (isRm && /data[\\/](?:warehouse|overlay\.json)/i.test(rawSeg)) {
      deny(
        'Deleting data/warehouse or data/overlay.json is blocked (CLAUDE.md 9): live warehouse and user overlay are irreplaceable local state.',
      );
    }
  }

  process.exit(0);
} catch {
  // FAIL-OPEN: process gate - never block on a broken hook
  process.exit(0);
}
