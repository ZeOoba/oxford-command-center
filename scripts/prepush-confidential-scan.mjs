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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'scripts/install-git-hooks.ts',
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
 * @returns {{alwaysTerms: string[], contextGroups: {dealKey: string, contextTerms: string[], requiresAny: string[]}[], rosterOk: boolean, rosterDetail: string}}
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
    return { alwaysTerms: dedupe(alwaysTerms), contextGroups, rosterOk: false, rosterDetail: detail };
  }

  collectDealTerms(result.data, alwaysTerms, contextGroups);
  return { alwaysTerms: dedupe(alwaysTerms), contextGroups, rosterOk: true, rosterDetail: '' };
}

/**
 * Invariant 3 fail-closed rule (cc-audit-army 2026-09-28, prepush-scan-fails-open): with no usable
 * roster the scan degrades to a one-entry denylist, which is NOT protection for real deal names.
 * Block the push unless the operator explicitly opts out for this push with
 * PREPUSH_ALLOW_NO_ROSTER=1. Pure so it is unit-testable without process.exit.
 *
 * @param {boolean} rosterOk
 * @param {Record<string, string|undefined>} env
 * @returns {boolean} true = block the push
 */
export function shouldBlockOnMissingRoster(rosterOk, env) {
  if (rosterOk) return false;
  return env['PREPUSH_ALLOW_NO_ROSTER'] !== '1';
}

// ── real-data paths (ruling 2026-11-10) ──────────────────────────────────────────────────────────
// Real firm data is never tracked. scripts/fixtures/real-data-manifest.json lists every real-data
// path (exact files + directory prefixes); each is gitignored, and fixtures/synthetic/<same path>
// holds the committed synthetic stand-in. A push that ADDS or MODIFIES a manifest path (a `git add -f`,
// a negated ignore rule, a rename into place) is blocked. Deleting one (untracking) is always fine.

const REAL_DATA_MANIFEST = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-data-manifest.json');
const SYNTHETIC_PREFIX = 'fixtures/synthetic/';

/**
 * Load the real-data manifest. Throws when it is missing or malformed, so the caller fails closed.
 * @param {string} [pathOverride] - test seam.
 * @returns {{files: string[], dirs: string[]}}
 */
export function loadRealDataManifest(pathOverride) {
  const parsed = JSON.parse(readFileSync(pathOverride ?? REAL_DATA_MANIFEST, 'utf8'));
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  // `neverTrack` lists real-data paths that have no synthetic stand-in (baked outputs, the overlay, the
  // warehouse, raw exports): never seeded, but blocked here exactly like the manifest paths.
  const files = [...strings(parsed?.files), ...strings(parsed?.neverTrack?.files)];
  const dirs = [...strings(parsed?.dirs), ...strings(parsed?.neverTrack?.dirs)];
  if (files.length === 0 && dirs.length === 0) throw new Error('real-data manifest lists no paths');
  return { files, dirs };
}

/**
 * True when `path` is a real-data path the manifest covers. Synthetic stand-ins under
 * fixtures/synthetic/ never match (they are what the repo is meant to carry).
 * @param {string} path - repo-relative, either slash style.
 * @param {{files: string[], dirs: string[]}} manifest
 */
export function isRealDataPath(path, manifest) {
  // Case-insensitive and normalized: the checkout lives on NTFS (core.ignorecase), so a case variant
  // of a manifest path is the same file there and must be caught too.
  const norm = (x) => String(x).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const p = norm(path);
  if (p.startsWith(SYNTHETIC_PREFIX)) return false;
  return manifest.files.some((f) => norm(f) === p) || manifest.dirs.some((d) => p.startsWith(norm(d)));
}

/**
 * Parse `git diff --name-status --no-renames --diff-filter=AMT` output and return every added or
 * modified real-data path.
 * @param {string} nameStatusText
 * @param {{files: string[], dirs: string[]}} manifest
 * @returns {string[]}
 */
export function parseRealDataPaths(nameStatusText, manifest) {
  const out = [];
  for (const line of String(nameStatusText ?? '').split('\n')) {
    // "A\tpath", "M\tpath", "T\tpath"; a rename/copy row ("R100\told\tnew") carries the new path last.
    const m = /^([AMTCR])\d*\t(?:[^\t]+\t)?(.+)$/.exec(line.trimEnd());
    if (!m || !m[2]) continue;
    if (isRealDataPath(m[2], manifest)) out.push(m[2].replace(/\\/g, '/'));
  }
  return out;
}

/** @param {string} remoteSha
 * @param {string} localSha
 * @param {{files: string[], dirs: string[]}} manifest
 * @param {string} [cwd] - test seam; defaults to the process cwd.
 * @returns {string[]} */
export function realDataPathsFor(remoteSha, localSha, manifest, cwd) {
  const base = resolveDiffBase(remoteSha, localSha, cwd);
  const text = execFileSync('git', ['-c', 'core.quotepath=off', 'diff', '--name-status', '--no-renames', '--diff-filter=AMT', `${base}..${localSha}`], {
    encoding: 'utf8',
    maxBuffer: Infinity,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });
  return parseRealDataPaths(text, manifest);
}

const EXPORT_EXT_RE = /\.(xlsx|xlsm|xls|pdf|docx|doc|csv)$/i;

/**
 * Binary files (xlsx/pdf/docx) are invisible to the text-line scan: `git diff` prints only
 * "Binary files differ". Any binary ADDED or MODIFIED under data/ is firm/tenant data that the
 * scan cannot inspect, so it blocks (deletions are fine). Parses `git diff --numstat`, where a
 * binary file is reported as "-<TAB>-<TAB>path".
 *
 * @param {string} numstatText - output of `git diff --numstat --diff-filter=AM`
 * @returns {string[]} binary paths under data/
 */
export function parseBinaryPathsUnderData(numstatText) {
  const out = [];
  for (const line of numstatText.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line.trimEnd());
    if (!m || !m[3]) continue;
    const path = m[3].replace(/\\/g, '/');
    if (!path.startsWith('data/')) continue;
    // Binary by git's own detection ("-<TAB>-"), OR an export/document extension: a CSV, or a small
    // PDF with no NUL byte in its first 8 KB, is classified as text and would otherwise pass.
    if ((m[1] === '-' && m[2] === '-') || EXPORT_EXT_RE.test(path)) out.push(m[3]);
  }
  return out;
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

// cc-audit-army finding confidential-deals-committed-to-git-remote (2026-08-21). The 2026-08-21
// ruling that let data/snapshots/portfolio.json carry real confidential-deal records in git is
// SUPERSEDED: real firm data is never tracked (ruling 2026-11-10). The snapshot and every other path
// in scripts/fixtures/real-data-manifest.json are gitignored and local-only; the tracked copies under
// fixtures/synthetic/ are synthetic, and the real-data path check below blocks any push that adds or
// modifies a manifest path. This flag check stays as a second, payload-shaped line of defense:
// a `"confidential": true` record may only ever be pushed from a repo registered as an intentional
// confidential store (the synthetic fixtures carry the flag so the code paths that read it are
// exercised), and it is independent of whether any term denylist entry also matched.
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
 * @returns {boolean}
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

// Parses a unified `git diff` into ADDED content lines only ('+' lines, excluding the '+++' file
// header), tracking the current file (from '+++ b/<path>') and new-side line numbers (from the
// unified-diff hunk-header markers). Note: those markers are not spelled out literally inside the
// JSDoc block below because two adjacent '@' characters there parse as an (invalid) JSDoc tag.
/**
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
/** @param {string} [localSha]
 * @param {string} [cwd] - test seam; defaults to the process cwd. */
export function baseForNewBranch(localSha, cwd) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { stdio: 'pipe', cwd });
    // merge-base, NOT origin/main itself: a two-dot diff from origin/main reads everything main has
    // since REMOVED as "added" on the branch, so after an untrack lands on main every older branch
    // would false-block on the files main deleted.
    if (localSha) {
      try {
        const mb = execFileSync('git', ['merge-base', 'origin/main', localSha], { encoding: 'utf8', stdio: 'pipe', cwd }).trim();
        if (mb) return mb;
      } catch {
        // unrelated histories: fall through to origin/main
      }
    }
    return 'origin/main';
  } catch {
    // 4b825dc642cb6eb9a060e54bf8d69288fbee4904 is git's well-known empty-tree object.
    return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  }
}

/**
 * The base a pushed ref's diff is computed against. A zero remote sha (new branch) uses
 * baseForNewBranch. A non-zero remote sha that is NOT in the local object database (the remote
 * moved and was not fetched, or was force-pushed) also falls back to baseForNewBranch -- the
 * merge-base with origin/main -- instead of letting `git diff` fail and the ref go unscanned
 * (prepush-scan-skips-on-diff-error, 2026-11-08).
 *
 * @param {string} remoteSha
 * @param {string} localSha
 * @param {string} [cwd] - test seam; defaults to the process cwd.
 * @returns {string}
 */
export function resolveDiffBase(remoteSha, localSha, cwd) {
  if (!remoteSha || ZERO_SHA.test(remoteSha)) return baseForNewBranch(localSha, cwd);
  try {
    execFileSync('git', ['cat-file', '-e', `${remoteSha}^{commit}`], { stdio: 'pipe', cwd });
    return remoteSha;
  } catch {
    console.warn(
      `[prepush-confidential-scan] remote sha ${remoteSha} is not in the local object DB -- ` +
        'scanning from the merge-base with origin/main instead.',
    );
    return baseForNewBranch(localSha, cwd);
  }
}

// No fixed maxBuffer cap: the old 64 MB cap threw ENOBUFS on exactly the largest, most
// data-heavy pushes, and the caller then skipped them. Every scanner needs the ref's whole added
// corpus in memory anyway (context terms gate on the full range), so streaming would not lower
// the peak. A diff too large for one JS string still throws, and that throw now BLOCKS the push.
/** @param {string} remoteSha
 * @param {string} localSha
 * @param {string} [cwd] */
function diffFor(remoteSha, localSha, cwd) {
  const base = resolveDiffBase(remoteSha, localSha, cwd);
  return execFileSync('git', ['diff', `${base}..${localSha}`], {
    encoding: 'utf8',
    maxBuffer: Infinity,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });
}

/**
 * Invariant 3 fail-closed rule for diff errors (prepush-scan-skips-on-diff-error, 2026-11-08): a
 * ref whose diff or numstat could not be computed was never scanned, so the push blocks unless
 * the operator explicitly opts out for this push with PREPUSH_ALLOW_DIFF_ERROR=1. Pure so it is
 * unit-testable without process.exit.
 *
 * @param {{localSha: string, message: string}[]} diffErrors
 * @param {Record<string, string|undefined>} env
 * @returns {boolean} true = block the push
 */
export function shouldBlockOnDiffError(diffErrors, env) {
  if (!Array.isArray(diffErrors) || diffErrors.length === 0) return false;
  return env['PREPUSH_ALLOW_DIFF_ERROR'] !== '1';
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

/** @param {string} remoteSha
 * @param {string} localSha
 * @param {string} [cwd] - test seam; defaults to the process cwd.
 * @returns {string[]} */
export function binaryPathsFor(remoteSha, localSha, cwd) {
  const base = resolveDiffBase(remoteSha, localSha, cwd);
  // quotepath=off: a non-ASCII filename (en dash in an Excel export name) is otherwise emitted
  // as a quoted "\342\200\223" string that fails the data/ prefix test. --no-renames: a binary
  // moved into data/ with edits is otherwise status R and dropped by --diff-filter=AM.
  const text = execFileSync('git', ['-c', 'core.quotepath=off', 'diff', '--numstat', '--no-renames', '--diff-filter=AM', `${base}..${localSha}`], {
    encoding: 'utf8',
    maxBuffer: Infinity,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });
  return parseBinaryPathsUnderData(text);
}

/** First line of an error's code or message, for a one-line diffErrors entry. @param {unknown} err */
function errorLine(err) {
  const e = /** @type {{code?: string, message?: string}} */ (err);
  return String(e?.code ?? e?.message ?? err).split('\n')[0] ?? '';
}

/**
 * Parse git's pre-push stdin ("<local ref> <local sha> <remote ref> <remote sha>" per line) and
 * collect, per pushed ref, the added diff lines (minus EXCLUDE_PATHS) and the binary/export
 * paths under data/. A ref whose diff or numstat could NOT be computed is recorded in diffErrors
 * -- never silently skipped -- so the caller can fail closed.
 *
 * The text diff and the binary numstat are computed in SEPARATE try blocks: a numstat failure
 * records its own diffErrors entry but never discards a text diff that succeeded, so its added
 * lines are still term-scanned (refute run wf_44a3341e-b41, low).
 *
 * When `deps.manifest` is given, each ref's added/modified real-data paths (ruling 2026-11-10) are
 * collected into realDataHits, in a third try block with its own diffErrors entry.
 *
 * @param {string} stdinText
 * @param {string} [cwd] - test seam; defaults to the process cwd.
 * @param {{diffFor?: (remoteSha: string, localSha: string, cwd?: string) => string, binaryPathsFor?: (remoteSha: string, localSha: string, cwd?: string) => string[], realDataPathsFor?: (remoteSha: string, localSha: string, manifest: {files: string[], dirs: string[]}, cwd?: string) => string[], manifest?: {files: string[], dirs: string[]}}} [deps] - test seam; defaults to the real git calls.
 * @returns {{addedByRef: {file: string, lineNo: number, text: string}[][], binaryHits: string[], realDataHits: string[], diffErrors: {localSha: string, message: string}[]}}
 */
export function collectRefScan(stdinText, cwd, deps) {
  const getDiff = deps?.diffFor ?? diffFor;
  const getBinaries = deps?.binaryPathsFor ?? binaryPathsFor;
  const getRealData = deps?.realDataPathsFor ?? realDataPathsFor;
  const manifest = deps?.manifest;
  /** @type {string[]} */
  const realDataHits = [];
  /** @type {{file: string, lineNo: number, text: string}[][]} */
  const addedByRef = [];
  /** @type {string[]} */
  const binaryHits = [];
  /** @type {{localSha: string, message: string}[]} */
  const diffErrors = [];
  for (const rawLine of String(stdinText ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO_SHA.test(localSha)) continue; // branch deletion — nothing to scan
    try {
      const diffText = getDiff(remoteSha ?? '', localSha, cwd);
      addedByRef.push(parseAddedLines(diffText).filter((a) => !EXCLUDE_PATHS.has(a.file)));
    } catch (err) {
      diffErrors.push({ localSha, message: `text diff: ${errorLine(err)}` });
    }
    try {
      binaryHits.push(...getBinaries(remoteSha ?? '', localSha, cwd));
    } catch (err) {
      diffErrors.push({ localSha, message: `binary numstat: ${errorLine(err)}` });
    }
    if (manifest) {
      try {
        realDataHits.push(...getRealData(remoteSha ?? '', localSha, manifest, cwd));
      } catch (err) {
        diffErrors.push({ localSha, message: `real-data paths: ${errorLine(err)}` });
      }
    }
  }
  return { addedByRef, binaryHits, realDataHits, diffErrors };
}

function main() {
  const { alwaysTerms, contextGroups, rosterOk, rosterDetail } = loadTerms();
  if (!rosterOk && process.env['PREPUSH_ALLOW_NO_ROSTER'] === '1') {
    console.warn(`[prepush-confidential-scan] WARN: PREPUSH_ALLOW_NO_ROSTER=1 - roster gate BYPASSED for this push (${rosterDetail}).`);
  }
  if (shouldBlockOnMissingRoster(rosterOk, process.env)) {
    console.error(
      `\n✖  PUSH BLOCKED — the confidential-deal roster is unavailable (${rosterDetail}), so the ` +
        'scan would cover only the built-in denylist and could miss real deal names (Invariant 3, ' +
        'fail closed).\n\n   Restore ~/.claude/hooks/confidential-terms.json, or set ' +
        'PREPUSH_ALLOW_NO_ROSTER=1 for this one push if you have verified it carries no deal data.\n',
    );
    process.exit(1);
  }
  // Real firm data is never tracked (ruling 2026-11-10). The manifest that names it must be readable,
  // or the push is blocked: without it this scan cannot tell a real-data path from any other.
  let manifest;
  try {
    manifest = loadRealDataManifest();
  } catch (err) {
    console.error(
      `\n✖  PUSH BLOCKED — scripts/fixtures/real-data-manifest.json is unreadable (${errorLine(err)}), so the ` +
        'real-data path check cannot run (fail closed). Restore the file and push again.\n',
    );
    process.exit(1);
  }
  const stdin = readStdin();
  const { addedByRef, binaryHits, realDataHits, diffErrors } = collectRefScan(stdin, undefined, { manifest });
  const allHits = [];
  const flagHits = [];
  for (const added of addedByRef) {
    allHits.push(...scanDiffForConfidential(added, alwaysTerms));
    allHits.push(...scanDiffForContextTerms(added, contextGroups));
    flagHits.push(...scanDiffForConfidentialFlag(added));
  }

  // Fail CLOSED on a ref that could not be diffed (prepush-scan-skips-on-diff-error, 2026-11-08).
  // This used to warn and skip, so the largest, most data-heavy pushes (ENOBUFS) went out
  // unscanned. The explicit per-push opt-out keeps a transient git error from bricking pushes
  // permanently, and it does not suppress real hits found on the refs that WERE scanned (the
  // hit checks below still run).
  if (diffErrors.length > 0) {
    if (shouldBlockOnDiffError(diffErrors, process.env)) {
      blockOnHits(
        diffErrors,
        'the confidential scan could not compute the diff for pushed ref(s), so they were NOT scanned',
        (e) => `${e.localSha}  ->  ${e.message}`,
        'Invariant 3, fail closed. Fix the git error (for a missing remote sha, `git fetch origin`) ' +
          'and push again, or set PREPUSH_ALLOW_DIFF_ERROR=1 for this one push if you have verified ' +
          'it carries no deal data.',
      );
    }
    for (const e of diffErrors) {
      console.warn(
        `[prepush-confidential-scan] WARN: PREPUSH_ALLOW_DIFF_ERROR=1 - ref ${e.localSha} pushed UNSCANNED (${e.message}).`,
      );
    }
  }

  if (realDataHits.length > 0) {
    blockOnHits(
      [...new Set(realDataHits)],
      'real firm data path(s) added or modified (scripts/fixtures/real-data-manifest.json; ruling 2026-11-10)',
      (p) => p,
      'Real firm data is never tracked. These paths are gitignored and local-only; the committed copy is ' +
        'the synthetic stand-in under fixtures/synthetic/ (regenerate it with `npm run data:synthetic`). ' +
        'Remove the file from the commit (git rm --cached <path>) and push again. There is no override.',
    );
  }

  if (binaryHits.length > 0) {
    blockOnHits(
      [...new Set(binaryHits)],
      'binary file(s) added or modified under data/ that this text scan cannot inspect',
      (p) => p,
      'Tenant/firm exports (xlsx/pdf) must not be pushed. Gitignore the directory and untrack the ' +
        'file (git rm --cached); decide any history purge with Gabriel.',
    );
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
