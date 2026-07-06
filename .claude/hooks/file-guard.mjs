#!/usr/bin/env node
/**
 * file-guard.mjs - PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit.
 *
 * Enforces CLAUDE.md section 4 (architect-owned files) and section 9
 * (never-touch files) mechanically. Reads the tool-call JSON from stdin,
 * emits a PreToolUse deny decision on stdout when the target file is
 * protected, otherwise exits 0 silently (allow).
 *
 * FAIL-OPEN by design: this is a process gate (EOS doctrine - productivity
 * gates fail open; confidentiality gates fail closed). Any parse or fs
 * error exits 0 so a broken hook can never block legitimate work.
 * Confidentiality (confidential-terms.json) is enforced fail-closed by
 * permissions.deny in .claude/settings.json, not here.
 *
 * Path resolution is done against the repo root that OWNS the TARGET file
 * (found by walking up for CLAUDE.md), NOT merely the session's project dir.
 * That way a session whose cwd/CLAUDE_PROJECT_DIR is a worktree cannot use an
 * ABSOLUTE path to reach into the main checkout's protected files and evade the
 * denies. Only files whose repo root is the session root (or an ancestor /
 * descendant of it - i.e. the main<->worktree family) are policed; genuinely
 * unrelated repos are left alone.
 *
 * Override protocol (architect-owned files ONLY): the architect acks a
 * review_needed declaration by running
 *   mkdir -p .claude/overrides && touch .claude/overrides/architect-edit-ok
 * The sentinel is honored for 60 minutes from its mtime. Hard-deny paths
 * below ignore the sentinel entirely.
 *
 * Zero dependencies. Node >= 20. Runs identically on Windows and Linux.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';

const SENTINEL_TTL_MS = 60 * 60 * 1000; // 60 minutes

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

/**
 * Minimal glob matcher: supports ** (any path run) and * (within one segment).
 * The glob is expected pre-lowercased by the caller (matching is done against a
 * lowercased repo-relative path so the case-insensitive desktop NTFS checkout
 * cannot evade with e.g. `Data/overlay.json`).
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Walk up from startDir to the first ancestor containing CLAUDE.md, or null. */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    try {
      statSync(join(dir, 'CLAUDE.md'));
      return dir;
    } catch {
      // no CLAUDE.md here - keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True when `a` is the same directory as `b` or an ancestor of `b`. */
function isAncestorOrSame(a, b) {
  const rel = relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Per-repo-root caches (a single tool call can carry multiple targets).
const manifestCache = new Map();
function architectPatternsFor(repoRoot) {
  if (manifestCache.has(repoRoot)) return manifestCache.get(repoRoot);
  let patterns = [];
  try {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, '.claude', 'hooks', 'architect-owned.json'), 'utf8'),
    );
    if (Array.isArray(manifest.globs)) {
      // Lowercase every glob so matching is case-insensitive (see globToRegExp).
      patterns = manifest.globs.map((g) => globToRegExp(String(g).toLowerCase()));
    }
  } catch {
    // manifest missing/corrupt -> architect-owned check degrades to no-op (fail-open)
  }
  manifestCache.set(repoRoot, patterns);
  return patterns;
}

function sentinelFreshFor(repoRoot) {
  try {
    const st = statSync(join(repoRoot, '.claude', 'overrides', 'architect-edit-ok'));
    return Date.now() - st.mtimeMs <= SENTINEL_TTL_MS;
  } catch {
    return false; // sentinel absent
  }
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const toolInput = input.tool_input ?? {};
  const sessionRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  const targets = [];
  if (typeof toolInput.file_path === 'string') targets.push(toolInput.file_path);
  if (typeof toolInput.notebook_path === 'string') targets.push(toolInput.notebook_path);
  if (targets.length === 0) process.exit(0);

  for (const target of targets) {
    const abs = isAbsolute(target) ? target : resolve(sessionRoot, target);

    // Resolve the repo root that OWNS this target (not just the session dir),
    // so an absolute path into the main checkout from a worktree session is
    // still policed against its own repo-relative path.
    const targetRoot = findRepoRoot(dirname(abs));
    if (!targetRoot) continue; // not inside any known repo -> not policed (fail-open)

    // Only police files in THIS project's repo family: the session root, an
    // ancestor of it (the main checkout when the session is a worktree), or a
    // descendant of it (a worktree living under the session root). A genuinely
    // unrelated repo is neither, so its edits are never denied.
    if (
      !isAncestorOrSame(sessionRoot, targetRoot) &&
      !isAncestorOrSame(targetRoot, sessionRoot)
    ) {
      continue;
    }

    const rel = relative(targetRoot, abs).replace(/\\/g, '/');
    if (rel === '' || rel === '..' || rel.startsWith('../')) continue;
    // Lowercase for comparison: the desktop checkout is case-insensitive NTFS,
    // so `Data/overlay.json` must match `data/overlay.json`. The repo has no
    // case-colliding paths, so this is safe on case-sensitive Linux too.
    const relLc = rel.toLowerCase();

    // --- Hard denies (sentinel does NOT apply) -------------------------------
    if (relLc === 'data/overlay.json') {
      deny(
        'data/overlay.json holds live user mutations and must never be edited or overwritten by an agent (CLAUDE.md 9). It is written only by the running server.',
      );
    }
    if (relLc === 'data/warehouse' || relLc.startsWith('data/warehouse/')) {
      deny(
        'data/warehouse/ is the live SQLite warehouse (CLAUDE.md 9). Never edit it directly - schema changes go through server/warehouse/migrations/ and npm run warehouse:backfill.',
      );
    }
    if (
      relLc === '.claude/settings.json' ||
      relLc === '.claude/settings.local.json' ||
      relLc === '.claude/hooks' ||
      relLc.startsWith('.claude/hooks/')
    ) {
      deny(
        'Guardrail self-protection: ' +
          rel +
          ' defines the session guardrails and cannot be modified from inside a session. Edit it outside a session (normal editor + reviewed PR).',
      );
    }

    // --- Architect-owned (CLAUDE.md 4) - override sentinel applies -----------
    if (architectPatternsFor(targetRoot).some((p) => p.test(relLc))) {
      if (sentinelFreshFor(targetRoot)) continue; // architect ack present and fresh -> allow
      deny(
        rel +
          ' is an architect-owned file per CLAUDE.md 4. Declare review_needed: true with a review_detail in architecture/status.json and wait for architect acknowledgment. Architect ack = touch .claude/overrides/architect-edit-ok (60-min TTL), then retry the edit.',
      );
    }
  }

  process.exit(0);
} catch {
  // FAIL-OPEN: process gate - never block on a broken hook
  process.exit(0);
}
