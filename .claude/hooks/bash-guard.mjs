#!/usr/bin/env node
/**
 * bash-guard.mjs - PreToolUse hook for the Bash tool.
 *
 * Blocks the always-wrong command classes named in CLAUDE.md:
 *   (a) git add -A / --all / bare '.' pathspec        (CLAUDE.md 2 - explicit paths only)
 *   (b) git commit --no-verify / -n                   (CLAUDE.md 9 - never bypass the gate)
 *   (c) git push --force / -f / --no-verify           (CLAUDE.md 8 - escalate to Gabriel)
 *   (d) git config touching core.hooksPath            (hook-tampering)
 *   (e) sqlite3 write DDL/DML against the live warehouse (CLAUDE.md 9)
 *   (f) rm/unlink of data/warehouse or data/overlay.json (CLAUDE.md 9)
 *   (g) writes to .claude/settings*.json / .claude/hooks/ (guardrail self-protection)
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

/**
 * Normalize a raw token for flag matching: strip surrounding quotes and remove
 * backslash escapes that precede a dash. This defeats quoting/escaping bypasses
 * like `git add "-A"` and `git add \-A`.
 */
function normalizeToken(t) {
  return t
    .replace(/^["']+/, '')
    .replace(/["']+$/, '')
    .replace(/\\(?=-)/g, '');
}

/** True when a token list is a `git add` that stages -A / --all / bare '.'. */
function gitAddAll(tokens) {
  const ai = gitSubcommandIndex(tokens, 'add');
  if (ai === -1) return false;
  const rest = tokens.slice(ai + 1).map(normalizeToken);
  return rest.some((t) => t === '--all' || t === '.' || shortClusterHas(t, 'A'));
}

/**
 * Extract executable payloads that hide commands from a naive token scan:
 *   - `sh -c "..."` / `bash -c '...'`   (the quoted script is executed)
 *   - `$( ... )` command substitution
 *   - `` ` ... ` `` backtick substitution
 * Run against the FULL command (not per-segment) because the segment splitter
 * is quote-unaware and would tear a quoted payload apart. A quoted string that
 * is a mere argument (e.g. `rg "git add -A"`) is intentionally NOT extracted.
 */
function extractExecPayloads(command) {
  const out = [];
  let m;
  const shc = /\b(?:sh|bash)\s+-c\s+(['"])([\s\S]*?)\1/g;
  while ((m = shc.exec(command)) !== null) out.push(m[2]);
  const sub = /\$\(([\s\S]*?)\)/g;
  while ((m = sub.exec(command)) !== null) out.push(m[1]);
  const bt = /`([\s\S]*?)`/g;
  while ((m = bt.exec(command)) !== null) out.push(m[1]);
  return out;
}

const GIT_ADD_MSG =
  'git add -A/--all/. is blocked: commit with explicit paths only (CLAUDE.md 2). ' +
  'Uncommitted files you did not create are another writer in-progress work.';

// Guardrail files whose in-session mutation is blocked (task g). Matches
// .claude/settings.json, .claude/settings.local.json and anything under
// .claude/hooks/ (both / and \ separators for the Windows checkout).
const GUARD_PATH = '\\.claude[\\\\/](?:settings\\.json|settings\\.local\\.json|hooks)';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) process.exit(0);

  // Best-effort compound-cd awareness: a leading `cd data` / `cd data/warehouse`
  // (optionally ./-prefixed) means a later BARE `finance.sqlite` / `warehouse`
  // token in the same command still refers to the live warehouse. This does not
  // track arbitrary cd state across every segment of every compound command
  // (e.g. a cd that is itself conditional), so it is best-effort only - the
  // residual limitation is accepted per the fail-open process-gate doctrine.
  const cdData = /\bcd\s+\.?[\\/]?data(?:[\\/]warehouse)?\b/i.test(command);

  // (e) live-warehouse write DDL/DML - checked on the FULL command so pipes
  // (echo "DELETE ..." | sqlite3 data/warehouse/finance.sqlite) cannot split it.
  if (
    /\b(?:sqlite3|better-sqlite3)\b/.test(command) &&
    /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT|VACUUM)\b/i.test(command) &&
    (/data[\\/]warehouse[\\/]finance\.sqlite/i.test(command) ||
      (cdData && /\bfinance\.sqlite\b/i.test(command)))
  ) {
    deny(
      'Write DDL/DML against the live warehouse (data/warehouse/finance.sqlite) is blocked (CLAUDE.md 9). Schema/data changes go through server/warehouse/migrations/ and npm run warehouse:backfill.',
    );
  }

  // (a) git add hidden inside sh -c/bash -c payloads or command substitutions -
  // scanned on the FULL command before the quote-unaware segment split.
  for (const payload of extractExecPayloads(command)) {
    const it = payload.trim().split(/\s+/).filter(Boolean);
    if (gitAddAll(it)) deny(GIT_ADD_MSG);
  }

  // Split compound commands so checks are scoped per invocation.
  const segments = command.split(/(?:\|\||&&|[;|\n])/);

  for (const rawSeg of segments) {
    // Blank out quoted strings so commit-message content etc. cannot false-positive
    // the token checks. Raw segment is kept for path/regex checks and for the
    // git-add scan (which must see through quoting/escaping bypasses).
    const strippedSeg = rawSeg
      .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
      .replace(/'[^']*'/g, " '' ");
    const tokens = strippedSeg.trim().split(/\s+/).filter(Boolean);
    const rawTokens = rawSeg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0 && rawTokens.length === 0) continue;

    // (a) git add -A / --all / bare '.' - scanned on RAW tokens (quotes and
    // backslash-escapes normalized per token) so `git add "-A"` / `git add \-A`
    // are caught. The commit -n false-positive is handled below on stripped
    // tokens, so the git-add scan does NOT need quote-blanking.
    if (gitAddAll(rawTokens)) deny(GIT_ADD_MSG);

    // (b) git commit --no-verify / -n (token-scoped to the commit invocation;
    // uses stripped tokens so a commit MESSAGE containing -n cannot false-positive)
    const ci = gitSubcommandIndex(tokens, 'commit');
    if (ci !== -1) {
      const rest = tokens.slice(ci + 1);
      if (rest.some((t) => t === '--no-verify' || shortClusterHas(t, 'n'))) {
        deny(
          'git commit --no-verify/-n is blocked: the gate must run on every commit (CLAUDE.md 9). Fix the failing step instead of bypassing it.',
        );
      }
    }

    // (c) git push --force / -f / --no-verify (--force-with-lease is allowed).
    // NOTE: for `git push`, -n means --dry-run (harmless), so -n is NOT treated
    // as no-verify here; only the long form --no-verify is denied.
    const pi = gitSubcommandIndex(tokens, 'push');
    if (pi !== -1) {
      const rest = tokens.slice(pi + 1);
      if (rest.some((t) => t === '--force' || shortClusterHas(t, 'f'))) {
        deny(
          'git push --force/-f is blocked (CLAUDE.md 8): never force-push; if a force-push is truly needed, use --force-with-lease on a feature branch or escalate to Gabriel.',
        );
      }
      if (rest.some((t) => t === '--no-verify')) {
        deny(
          'git push --no-verify is blocked: the pre-push hook runs a confidential-history scan before every push (CLAUDE.md confidentiality doctrine). Never bypass it - fix what it flags or escalate to Gabriel.',
        );
      }
    }

    // (d) git config / git -c touching core.hooksPath
    if (tokens.includes('git') && /core\.hookspath/i.test(rawSeg)) {
      deny(
        'Changing core.hooksPath is blocked: git hook-path tampering disables the repo safety hooks (CLAUDE.md 9).',
      );
    }

    // (f) rm/unlink of the live warehouse or overlay. With a preceding `cd data`
    // the bare `warehouse` / `overlay.json` token still refers to live state.
    const isRm = tokens.some(
      (t) => t === 'rm' || t === 'unlink' || t.endsWith('/rm') || t.endsWith('/unlink'),
    );
    if (
      isRm &&
      (/data[\\/](?:warehouse|overlay\.json)/i.test(rawSeg) ||
        (cdData && /(?:\bwarehouse\b|overlay\.json)/i.test(rawSeg)))
    ) {
      deny(
        'Deleting data/warehouse or data/overlay.json is blocked (CLAUDE.md 9): live warehouse and user overlay are irreplaceable local state.',
      );
    }

    // (g) writes to the guardrail files themselves (redirection, tee, sed -i,
    // mv/cp onto them, rm/unlink of them). Reads (e.g. `cat .claude/settings.json`)
    // are NOT blocked - only mutations. Best-effort; process gate, fail-open.
    if (new RegExp(GUARD_PATH, 'i').test(rawSeg)) {
      const guardWrite =
        // redirect target: `> .claude/settings.json`, `>>.claude/hooks/x`
        new RegExp('>>?\\s*["\']?[^\\s"\'<>|;&]*' + GUARD_PATH, 'i').test(rawSeg) ||
        // tee into the path
        new RegExp('\\btee\\b[^|;&]*' + GUARD_PATH, 'i').test(rawSeg) ||
        // in-place sed edit of the path
        new RegExp('\\bsed\\b[^|;&]*\\s-i\\b[^|;&]*' + GUARD_PATH, 'i').test(rawSeg) ||
        // mv/cp with the path as an argument (destination)
        new RegExp('\\b(?:mv|cp)\\b[^|;&]*' + GUARD_PATH, 'i').test(rawSeg) ||
        // rm/unlink of the path
        isRm;
      if (guardWrite) {
        deny(
          'Writing to .claude/settings*.json or .claude/hooks/ from inside a session is blocked: guardrails are edited only via a reviewed PR, never mutated from within a session.',
        );
      }
    }
  }

  process.exit(0);
} catch {
  // FAIL-OPEN: process gate - never block on a broken hook
  process.exit(0);
}
