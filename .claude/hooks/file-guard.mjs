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
 * Override protocol (architect-owned files ONLY): the architect acks a
 * review_needed declaration by running
 *   mkdir -p .claude/overrides && touch .claude/overrides/architect-edit-ok
 * The sentinel is honored for 60 minutes from its mtime. Hard-deny paths
 * below ignore the sentinel entirely.
 *
 * Zero dependencies. Node >= 20. Runs identically on Windows and Linux.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';

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

/** Minimal glob matcher: supports ** (any path run) and * (within one segment). */
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

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const toolInput = input.tool_input ?? {};
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  const targets = [];
  if (typeof toolInput.file_path === 'string') targets.push(toolInput.file_path);
  if (typeof toolInput.notebook_path === 'string') targets.push(toolInput.notebook_path);
  if (targets.length === 0) process.exit(0);

  let architectGlobs = [];
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, '.claude', 'hooks', 'architect-owned.json'), 'utf8'),
    );
    if (Array.isArray(manifest.globs)) architectGlobs = manifest.globs;
  } catch {
    // manifest missing/corrupt -> architect-owned check degrades to no-op (fail-open)
  }
  const architectPatterns = architectGlobs.map(globToRegExp);

  let sentinelFresh = false;
  try {
    const st = statSync(join(root, '.claude', 'overrides', 'architect-edit-ok'));
    sentinelFresh = Date.now() - st.mtimeMs <= SENTINEL_TTL_MS;
  } catch {
    // sentinel absent
  }

  for (const target of targets) {
    const abs = isAbsolute(target) ? target : resolve(root, target);
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (rel === '' || rel === '..' || rel.startsWith('../')) continue; // outside the project - not policed here

    // --- Hard denies (sentinel does NOT apply) -------------------------------
    if (rel === 'data/overlay.json') {
      deny(
        'data/overlay.json holds live user mutations and must never be edited or overwritten by an agent (CLAUDE.md 9). It is written only by the running server.',
      );
    }
    if (rel === 'data/warehouse' || rel.startsWith('data/warehouse/')) {
      deny(
        'data/warehouse/ is the live SQLite warehouse (CLAUDE.md 9). Never edit it directly - schema changes go through server/warehouse/migrations/ and npm run warehouse:backfill.',
      );
    }
    if (
      rel === '.claude/settings.json' ||
      rel === '.claude/hooks' ||
      rel.startsWith('.claude/hooks/')
    ) {
      deny(
        'Guardrail self-protection: ' +
          rel +
          ' defines the session guardrails and cannot be modified from inside a session. Edit it outside a session (normal editor + reviewed PR).',
      );
    }

    // --- Architect-owned (CLAUDE.md 4) - override sentinel applies -----------
    if (architectPatterns.some((p) => p.test(rel))) {
      if (sentinelFresh) continue; // architect ack present and fresh -> allow
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
