// scripts/commitmsg-trailer-guard.mjs
//
// Commit-msg hook: catches a malformed/incorrect AI `Co-Authored-By:` trailer at commit time,
// before it is ever in a diff a reviewer has to read past, before it's pushed, before CI runs.
//
// Background (2026-09): an AI-assisted commit landed with an incorrect Co-Authored-By trailer
// (a wrong model-name string). It had to be caught by a human reviewer and fixed with
// `git filter-branch` after the fact, and by luck, before it was ever pushed. There was no
// automated check for this at all. This hook is that check.
//
// Scope: this ONLY inspects `Co-Authored-By:` lines whose name portion looks like it is naming
// an AI/Claude/Anthropic co-author (contains "claude" or "anthropic", case-insensitive). Any
// other co-author trailer -- a real human, "Test <test@test.com>", etc. -- is left completely
// alone. A commit with no such line at all passes silently.
//
// Allowlist: a Claude/Anthropic-named trailer line must EXACTLY match one entry in
// ALLOWED_AI_TRAILERS below. To add a new legitimate model-name trailer (e.g. a new model tier
// comes into use), add its exact canonical line as a new array entry -- nothing else needs to
// change. Entries were seeded 2026-09-22 by checking this repo's actual commit history
// (`git log --all --grep="Co-Authored-By" -i`), which currently uses exactly two: the default
// "Claude Sonnet 5" trailer, and "Claude Fable 5.1" (used for confidential/financial/governor
// work per CLAUDE.md's model-floor rule -- Fable never below).
//
// Blocking: unlike the advisory NOI cross-check, this is a hard gate (non-zero exit blocks the
// commit). A blocked LOCAL commit costs nothing to retry immediately -- the whole point is
// catching this before it exists in history at all, unlike a pushed commit that needs a history
// rewrite to fix.
//
// Node built-ins only (runs in a git hook with no install step -- see prepush-*.mjs headers for
// why: hooks run from the raw .git/hooks directory with no guarantee node_modules exists).
import { readFileSync } from 'node:fs';

export const ALLOWED_AI_TRAILERS = [
  'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
  'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>',
];

// Case-insensitive on the trailer key ("Co-authored-by:" etc. -- git/GitHub both accept slight
// case variance) and on the name portion's "claude"/"anthropic" substring.
const CO_AUTHOR_LINE_RE = /^co-authored-by:\s*(.+)$/i;
const AI_NAME_RE = /claude|anthropic/i;

/**
 * Return every line in `message` that is a Co-Authored-By trailer naming an AI (Claude/
 * Anthropic) co-author, verbatim (original casing/spacing preserved) so it can be printed back
 * and exact-matched against the allowlist.
 *
 * @param {string} message
 * @returns {string[]}
 */
export function findAiCoAuthorLines(message) {
  if (typeof message !== 'string') return [];
  const hits = [];
  for (const rawLine of message.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = CO_AUTHOR_LINE_RE.exec(line.trim());
    if (!m) continue;
    if (AI_NAME_RE.test(m[1])) hits.push(line.trim());
  }
  return hits;
}

/**
 * Validate every AI co-author trailer line in `message` against ALLOWED_AI_TRAILERS.
 *
 * @param {string} message
 * @returns {{ok: boolean, offending: string[]}}
 */
export function validateAiTrailers(message) {
  const aiLines = findAiCoAuthorLines(message);
  const offending = aiLines.filter((line) => !ALLOWED_AI_TRAILERS.includes(line));
  return { ok: offending.length === 0, offending };
}

function main() {
  const msgFile = process.argv[2];
  if (!msgFile) {
    console.error('[commitmsg-trailer-guard] no commit message file path given (expected process.argv[2]) -- skipping.');
    process.exit(0);
  }

  let message;
  try {
    message = readFileSync(msgFile, 'utf8');
  } catch (err) {
    console.warn(`[commitmsg-trailer-guard] WARN: could not read commit message file ${msgFile} (${err?.message ?? err}) -- skipping.`);
    process.exit(0);
  }

  const { ok, offending } = validateAiTrailers(message);
  if (ok) process.exit(0);

  console.error('\n✖  COMMIT BLOCKED — malformed/incorrect AI Co-Authored-By trailer:\n');
  for (const line of offending) console.error(`   found:    ${line}`);
  console.error('');
  console.error('   expected one of:');
  for (const allowed of ALLOWED_AI_TRAILERS) console.error(`     ${allowed}`);
  console.error(
    '\nFix the trailer line to match exactly (copy-paste one of the lines above), then retry the commit.\n' +
      'If this is a legitimate new model-name trailer, add its exact line to ALLOWED_AI_TRAILERS in\n' +
      'scripts/commitmsg-trailer-guard.mjs.\n',
  );
  process.exit(1);
}

// Only run as a CLI when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('commitmsg-trailer-guard.mjs')) {
  main();
}
