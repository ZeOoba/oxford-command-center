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
import { join, resolve } from 'node:path';

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

  const result = readJsonSafe(rosterPath);
  if (!result.ok) {
    const detail =
      result.reason === 'missing'
        ? `roster not found at ${rosterPath}`
        : `roster at ${rosterPath} is unparseable (${result.error?.message ?? result.error})`;
    console.warn(`[prepush-confidential-scan] WARN: ${detail} — scanning built-in denylist only.`);
    return { alwaysTerms: dedupe(alwaysTerms), contextGroups };
  }

  collectDealTerms(result.data, alwaysTerms, contextGroups);
  return { alwaysTerms: dedupe(alwaysTerms), contextGroups };
}

function dedupe(arr) {
  return [...new Set(arr)];
}

/** Safely read+parse a JSON file: `{ok:true, data}` or `{ok:false, reason:'missing'|'unparseable',
 * error}`. Never throws — the one safe-read shape loadTerms() and isRegisteredConfidentialRepo()
 * both need, previously duplicated between them. */
function readJsonSafe(path) {
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, reason: 'unparseable', error };
  }
}

// cc-audit-army finding confidential-deals-committed-to-git-remote (2026-08-21), resolved per
// Gabriel's ruling: this repo's data/snapshots/portfolio.json deliberately carries real
// confidential-deal records (the .gitignore negation at .gitignore:14 is intentional, not a
// leak) — formalized as an in-perimeter confidential store rather than redacted. The gap was
// that the ONLY control on that boundary was a term denylist with no structural rule about the
// payload SHAPE: nothing asserted that a `"confidential": true` record may only ever be pushed
// from a repo actually registered as an intentional confidential store. This closes that gap
// structurally — it does not change what data may be committed to THIS repo (still real data,
// deliberately), it only makes the control assert its own precondition instead of assuming it.
// Matches both the JSON-quoted-key shape ("confidential": true) and the unquoted object-literal
// shape (confidential: true) — the latter is the idiomatic form this codebase's own TS source
// and test fixtures actually use to construct these records (e.g. src/data/public-deals.ts),
// not just data/snapshots/portfolio.json's raw JSON. \b before 'confidential' means a longer
// identifier ending in it (e.g. isConfidential) can't match, since \b requires a non-word
// character immediately before — camelCase has none there.
const CONFIDENTIAL_FLAG_RE = /["']?\bconfidential\b["']?\s*:\s*true\b/;

/** Resolve the current repo's directory name (matches confidential-repos.json's naming), via
 * git rather than process.cwd() so this is correct regardless of invocation directory.
 *
 * --git-common-dir, NOT --show-toplevel: from inside a linked worktree, --show-toplevel
 * returns the WORKTREE's own directory, not the main repo's — this repo runs with several
 * live worktrees (financial-sweep-fixes, deploy-build, etc.), none of whose directory names
 * match the registered 'oxford-command-center', which would false-block every push made from
 * one. --git-common-dir resolves to the main repo's .git directory regardless of which
 * worktree invoked it; its parent directory is the main repo root in every case.
 *
 * @param {string} [cwdOverride] - test seam; defaults to the real process cwd. */
export function currentRepoName(cwdOverride) {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
    }).trim();
    const top = resolve(cwdOverride ?? '.', gitDir, '..');
    return top.split(/[\\/]/).filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
}

/**
 * True if `repoName` is registered on ~/.claude/confidential-repos.json's `confidential_repos`
 * list — the roster ORA already maintains for "this repo embeds confidential deal figures"
 * (see that file's own `rule`/`notes`). Never throws: an absent/unparseable roster or an empty
 * repoName is treated as NOT registered (fail toward blocking a confidential:true payload from
 * an unrecognized repo, never toward silently allowing one).
 *
 * @param {string} repoName
 * @param {string} [homeDirOverride] - test seam; defaults to os.homedir().
 */
export function isRegisteredConfidentialRepo(repoName, homeDirOverride) {
  if (!repoName) return false;
  const home = homeDirOverride ?? homedir();
  const rosterPath = join(home, '.claude', 'confidential-repos.json');
  const result = readJsonSafe(rosterPath);
  if (!result.ok) return false;
  const list = Array.isArray(result.data?.confidential_repos) ? result.data.confidential_repos : [];
  return list.includes(repoName);
}

/**
 * Scan added diff lines for a `"confidential": true` payload shape (JSON key, not a term —
 * this fires regardless of which specific deal it is, closing the gap a per-deal denylist
 * structurally cannot: a NEW confidential deal added to the roster is protected from the moment
 * its `confidential: true` flag is pushed, not only once someone remembers to add its terms to
 * confidential-terms.json too).
 *
 * @param {{file: string, lineNo: number, text: string}[]} addedLines
 * @returns {{line: number, text: string, file: string}[]}
 */
export function scanDiffForConfidentialFlag(addedLines) {
  const hits = [];
  if (!Array.isArray(addedLines)) return hits;
  for (const added of addedLines) {
    if (!added || typeof added.text !== 'string') continue;
    if (CONFIDENTIAL_FLAG_RE.test(added.text)) {
      hits.push({ line: added.lineNo, text: added.text, file: added.file });
    }
  }
  return hits;
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

/** Shared "print header, list hits, print trailer, exit 1" shape both block paths below use. */
function blockOnHits(hits, header, formatHit, trailer) {
  console.error(`\n✖  PUSH BLOCKED — ${header}:\n`);
  for (const h of hits) console.error(`   ${formatHit(h)}`);
  console.error(`\n${trailer}\n`);
  process.exit(1);
}

function main() {
  const { alwaysTerms, contextGroups } = loadTerms();
  const stdin = readStdin();
  const allHits = [];
  const flagHits = [];

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
    flagHits.push(...scanDiffForConfidentialFlag(added));
  }

  // Structural check: a `"confidential": true` payload is only ever legitimate FROM a repo
  // registered as an intentional in-perimeter confidential store. Registered → informational
  // (the control is visibly firing, not silently no-op); unregistered → BLOCK, independent of
  // whether any specific term denylist entry also matched.
  //
  // currentRepoName()/isRegisteredConfidentialRepo() (a git subprocess spawn + a file read) are
  // resolved HERE, not at the top of main() — they're only ever consulted in this branch, and
  // the overwhelmingly common push touches no confidential:true line at all.
  if (flagHits.length > 0) {
    const repoName = currentRepoName();
    const registered = isRegisteredConfidentialRepo(repoName);
    if (registered) {
      console.log(
        `[prepush-confidential-scan] ${flagHits.length} confidential:true record(s) detected — ` +
        `'${repoName}' is registered on ~/.claude/confidential-repos.json as an intentional ` +
        `in-perimeter confidential store. Not blocking.`,
      );
    } else {
      blockOnHits(
        flagHits,
        `confidential:true record(s) found, but '${repoName || '(unresolved repo)'}' is NOT ` +
          'registered on ~/.claude/confidential-repos.json',
        (h) => `${h.file}:${h.line}  ->  ${h.text.trim()}`,
        'Either this repo should not be carrying confidential-deal payloads, or it is an ' +
          'intentional in-perimeter store that was never registered — decide which with Gabriel, ' +
          'then either remove the payload or add this repo to confidential-repos.json.',
      );
    }
  }

  if (allHits.length > 0) {
    blockOnHits(
      allHits,
      'confidential terms found in added lines',
      (h) => `${h.file}:${h.line}  ->  matched '${h.term}'`,
      'Remove the confidential content (and scrub history if already committed) before pushing.',
    );
  }

  process.exit(0);
}

// Only run as a CLI when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('prepush-confidential-scan.mjs')) {
  main();
}
