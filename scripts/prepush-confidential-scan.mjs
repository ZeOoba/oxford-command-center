// scripts/prepush-confidential-scan.mjs
//
// Pre-push confidentiality scanner (audit finding H1: the repo had NO native pre-push
// confidentiality hook, which let an active deal's terms get committed). Fail-closed: when
// run as a git pre-push hook and ANY confidential term appears in an ADDED diff line, it
// prints the offending locations and exits 1, blocking the push.
//
// The roster of real deal terms lives ONLY on the machine at ~/.claude/hooks/confidential-terms.json
// (git-ignored, off-repo). If that file is absent or unparseable we still scan a small generic
// built-in denylist and WARN — we never block all pushes just because the roster is missing.
//
// Node built-ins only (runs in a git hook with no install step).
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Generic patterns the repo should never push. Intentionally NOT real deal terms — keep this
// list synthetic/structural so the file itself is safe to commit. Extend cautiously: anything
// here matches against every added line case-insensitively.
const BUILTIN_DENYLIST = [
  // A document watermark that should never appear in pushed source. Keep entries generic and
  // structural — NOT real deal terms, and NOT legitimate filenames (e.g. 'confidential-terms.json'
  // is a path the codebase references legitimately, so it must NOT be a denylist entry). The real
  // protection is the machine-local roster (loadTerms).
  'CONFIDENTIAL — DO NOT DISTRIBUTE',
];

// This scanner's own implementation + tests necessarily contain term-like literals (denylist
// entries, the roster filename, synthetic fixtures), so they are excluded from scanning to avoid
// self-triggering — standard linter self-exclusion. The roster scan still protects every other file.
const EXCLUDE_PATHS = new Set([
  'scripts/prepush-confidential-scan.mjs',
  'scripts/prepush-confidential-scan.d.mts',
  'scripts/install-git-hooks.mjs',
  'tests/unit/prepush-confidential-scan.test.ts',
]);

const MIN_TERM_LENGTH = 3;

/**
 * Extract this roster's per-deal terms, honoring the roster's OWN documented contract
 * (confidential-terms.json's `_meta.matching` / `_meta.policy`):
 *   - a deal only contributes terms while `active === true` — `_meta.policy` says "Set
 *     active=false to retire a deal post-closing"; a retired deal's block stays in the JSON as
 *     an audit-trail record, but is no longer enforced by this scanner.
 *   - `always` terms fire on any occurrence, same as BUILTIN_DENYLIST.
 *   - `context` terms (generic words only confidential in deal context — e.g. an environmental
 *     abbreviation) fire ONLY alongside a co-occurring `context_requires_any` term from the SAME
 *     deal, never standalone. `_meta.matching` states this explicitly; the prior implementation
 *     never actually implemented it, flattening every string from every deal (active or not)
 *     into one undifferentiated always-list — which is what let a short, generic context term
 *     false-positive against ordinary code containing it as a substring.
 * Tolerates any roster shape defensively (a malformed deal entry is skipped, not fatal).
 */
function collectDealTerms(parsed, alwaysTerms, contextGroups) {
  if (!parsed || typeof parsed !== 'object') return;
  for (const [key, deal] of Object.entries(parsed)) {
    if (key === '_meta') continue;
    if (!deal || typeof deal !== 'object' || deal.active !== true) continue;
    if (Array.isArray(deal.always)) {
      for (const t of deal.always) if (typeof t === 'string') alwaysTerms.push(t);
    }
    if (Array.isArray(deal.context) && Array.isArray(deal.context_requires_any)) {
      const contextTerms = deal.context.filter((t) => typeof t === 'string');
      const requiresAny = deal.context_requires_any.filter((t) => typeof t === 'string');
      if (contextTerms.length > 0 && requiresAny.length > 0) {
        contextGroups.push({ dealKey: key, contextTerms, requiresAny });
      }
    }
  }
}

/**
 * Load confidential terms: built-in denylist MERGED with `always` terms from every ACTIVE deal
 * in the machine-local roster (if present and parseable), plus that roster's `context` groups
 * (scanned separately by scanDiffForContextTerms — see collectDealTerms above for why they
 * can't just be flattened into the same list). Never throws; prints a WARN and returns just the
 * denylist (no context groups) when the roster is missing or unparseable.
 *
 * @param {string} [homeDirOverride] - test seam; defaults to os.homedir().
 * @returns {{alwaysTerms: string[], contextGroups: {dealKey: string, contextTerms: string[], requiresAny: string[]}[]}}
 */
export function loadTerms(homeDirOverride) {
  const home = homeDirOverride ?? homedir();
  const rosterPath = join(home, '.claude', 'hooks', 'confidential-terms.json');
  const alwaysTerms = [...BUILTIN_DENYLIST];
  const contextGroups = [];

  if (!existsSync(rosterPath)) {
    console.warn(
      `[prepush-confidential-scan] WARN: roster not found at ${rosterPath} — scanning built-in denylist only.`,
    );
    return { alwaysTerms: dedupe(alwaysTerms), contextGroups };
  }

  try {
    const parsed = JSON.parse(readFileSync(rosterPath, 'utf8'));
    collectDealTerms(parsed, alwaysTerms, contextGroups);
    return { alwaysTerms: dedupe(alwaysTerms), contextGroups };
  } catch (err) {
    console.warn(
      `[prepush-confidential-scan] WARN: roster at ${rosterPath} is unparseable (${err?.message ?? err}) — scanning built-in denylist only.`,
    );
    return { alwaysTerms: dedupe(alwaysTerms), contextGroups };
  }
}

function dedupe(arr) {
  return [...new Set(arr)];
}

/**
 * Scan added diff lines for confidential terms.
 *
 * @param {{file: string, lineNo: number, text: string}[]} addedLines
 * @param {string[]} terms
 * @returns {{term: string, line: number, text: string, file: string}[]}
 */
export function scanDiffForConfidential(addedLines, terms) {
  const hits = [];
  if (!Array.isArray(addedLines) || !Array.isArray(terms)) return hits;

  const usable = terms.filter((t) => typeof t === 'string' && t.trim().length >= MIN_TERM_LENGTH);

  for (const added of addedLines) {
    if (!added || typeof added.text !== 'string') continue;
    const haystack = added.text.toLowerCase();
    for (const term of usable) {
      if (haystack.includes(term.toLowerCase())) {
        hits.push({ term, line: added.lineNo, text: added.text, file: added.file });
      }
    }
  }
  return hits;
}

/**
 * Scan added diff lines for `context` terms, per-deal, honoring the roster's documented gating:
 * a context term is a hit ONLY when at least one of its deal's `context_requires_any` companions
 * also appears somewhere in the SAME scanned corpus (this function's whole `addedLines` input —
 * the entire diff range being pushed, not necessarily the same line or file). A generic/ambiguous
 * context term with no identifying companion anywhere in the push is never flagged standalone.
 *
 * @param {{file: string, lineNo: number, text: string}[]} addedLines
 * @param {{dealKey: string, contextTerms: string[], requiresAny: string[]}[]} contextGroups
 * @returns {{term: string, line: number, text: string, file: string}[]}
 */
export function scanDiffForContextTerms(addedLines, contextGroups) {
  const hits = [];
  if (!Array.isArray(addedLines) || !Array.isArray(contextGroups)) return hits;

  const lines = addedLines.filter((a) => a && typeof a.text === 'string');
  const corpus = lines.map((a) => a.text.toLowerCase()).join('\n');

  for (const group of contextGroups) {
    const requiresAny = (group?.requiresAny ?? []).filter(
      (t) => typeof t === 'string' && t.trim().length >= MIN_TERM_LENGTH,
    );
    const companionPresent = requiresAny.some((t) => corpus.includes(t.toLowerCase()));
    if (!companionPresent) continue; // no identifying companion anywhere — context suppressed

    const contextTerms = (group?.contextTerms ?? []).filter(
      (t) => typeof t === 'string' && t.trim().length >= MIN_TERM_LENGTH,
    );
    for (const added of lines) {
      const haystack = added.text.toLowerCase();
      for (const term of contextTerms) {
        if (haystack.includes(term.toLowerCase())) {
          hits.push({ term, line: added.lineNo, text: added.text, file: added.file });
        }
      }
    }
  }
  return hits;
}

/**
 * Parse a unified `git diff` into ADDED content lines only ('+' lines, excluding the '+++' file
 * header), tracking the current file (from '+++ b/<path>') and new-side line numbers (from
 * '@@ -a,b +c,d @@' hunk headers).
 *
 * @param {string} diffText
 * @returns {{file: string, lineNo: number, text: string}[]}
 */
export function parseAddedLines(diffText) {
  const added = [];
  if (typeof diffText !== 'string' || diffText.length === 0) return added;

  let currentFile = '';
  let newLineNo = 0;
  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      // '+++ b/path/to/file' (or '+++ /dev/null'); strip the a/ or b/ prefix.
      const path = raw.slice(4).trim();
      currentFile = path.replace(/^[ab]\//, '');
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const m = hunkHeader.exec(raw);
    if (m) {
      newLineNo = Number.parseInt(m[1], 10);
      continue;
    }
    if (raw.startsWith('+')) {
      added.push({ file: currentFile, lineNo: newLineNo, text: raw.slice(1) });
      newLineNo += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      // removed line — does not advance the new-side counter
      continue;
    }
    // context line (starts with ' ' or is empty) advances the new-side counter
    newLineNo += 1;
  }
  return added;
}

const ZERO_SHA = /^0+$/;

/** Resolve a base ref to diff a new branch against: origin/main if it exists, else the empty tree. */
function baseForNewBranch() {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { stdio: 'pipe' });
    return 'origin/main';
  } catch {
    // 4b825dc642cb6eb9a060e54bf8d69288fbee4904 is git's well-known empty-tree object.
    return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  }
}

function diffFor(remoteSha, localSha) {
  const base = ZERO_SHA.test(remoteSha) ? baseForNewBranch() : remoteSha;
  return execFileSync('git', ['diff', `${base}..${localSha}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const { alwaysTerms, contextGroups } = loadTerms();
  const stdin = readStdin();
  const allHits = [];

  for (const rawLine of stdin.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO_SHA.test(localSha)) continue; // branch deletion — nothing to scan
    let diffText = '';
    try {
      diffText = diffFor(remoteSha ?? '', localSha);
    } catch (err) {
      // Fail SAFE on infrastructure errors (could not compute the diff): warn loudly but do NOT
      // block — only an actual confidential-term HIT blocks a push. Because this hook lives in the
      // shared .git/hooks and guards every worktree's pushes, a transient git error must not brick
      // a legitimate push. The manual path-2 scan remains the belt to this hook's suspenders.
      console.warn(
        `[prepush-confidential-scan] WARN: could not compute diff for ${localSha} (${err?.message ?? err}) — skipping scan for this ref.`,
      );
      continue;
    }
    const added = parseAddedLines(diffText).filter((a) => !EXCLUDE_PATHS.has(a.file));
    allHits.push(...scanDiffForConfidential(added, alwaysTerms));
    allHits.push(...scanDiffForContextTerms(added, contextGroups));
  }

  if (allHits.length > 0) {
    console.error('\n✖  PUSH BLOCKED — confidential terms found in added lines:\n');
    for (const h of allHits) {
      console.error(`   ${h.file}:${h.line}  ->  matched '${h.term}'`);
    }
    console.error('\nRemove the confidential content (and scrub history if already committed) before pushing.\n');
    process.exit(1);
  }

  process.exit(0);
}

// Only run as a CLI when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('prepush-confidential-scan.mjs')) {
  main();
}
