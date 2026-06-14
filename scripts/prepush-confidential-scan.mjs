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
 * Collect string leaves from an arbitrary roster value (arrays / nested objects), skipping the
 * `_meta` block. Defensive: tolerates whatever shape the roster has.
 */
function collectStrings(value, keyPath, out) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, keyPath, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (keyPath.length === 0 && k === '_meta') continue; // metadata, not terms
      // Skip obvious non-term scalar metadata fields nested in deal objects.
      if (typeof v === 'string' && (k === 'label' || k === 'note' || k === 'purpose')) continue;
      if (typeof v === 'boolean') continue;
      collectStrings(v, [...keyPath, k], out);
    }
  }
}

/**
 * Load confidential terms: built-in denylist MERGED with string terms extracted from the
 * machine-local roster (if present and parseable). Never throws; prints a WARN and returns just
 * the denylist when the roster is missing or unparseable.
 *
 * @param {string} [homeDirOverride] - test seam; defaults to os.homedir().
 * @returns {string[]} de-duplicated term strings.
 */
export function loadTerms(homeDirOverride) {
  const home = homeDirOverride ?? homedir();
  const rosterPath = join(home, '.claude', 'hooks', 'confidential-terms.json');
  const terms = [...BUILTIN_DENYLIST];

  if (!existsSync(rosterPath)) {
    console.warn(
      `[prepush-confidential-scan] WARN: roster not found at ${rosterPath} — scanning built-in denylist only.`,
    );
    return dedupe(terms);
  }

  try {
    const parsed = JSON.parse(readFileSync(rosterPath, 'utf8'));
    const extracted = [];
    collectStrings(parsed, [], extracted);
    return dedupe([...terms, ...extracted]);
  } catch (err) {
    console.warn(
      `[prepush-confidential-scan] WARN: roster at ${rosterPath} is unparseable (${err?.message ?? err}) — scanning built-in denylist only.`,
    );
    return dedupe(terms);
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
  const terms = loadTerms();
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
    allHits.push(...scanDiffForConfidential(added, terms));
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
