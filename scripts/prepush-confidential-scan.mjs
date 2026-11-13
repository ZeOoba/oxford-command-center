// scripts/prepush-confidential-scan.mjs
//
// OCC pre-push PAYLOAD scanner (Hard Invariant 3 and the real-data ruling of 2026-11-10). Fail-closed:
// run as a git pre-push hook stage, it exits 1 and prints the offending locations when a push would
// send any of these to the PUBLIC remote:
//   * a binary or export file (xlsx/pdf/docx/csv...) added or modified under data/;
//   * a path listed in scripts/fixtures/real-data-manifest.json (or a copy of one);
//   * added lines carrying FINGERPRINT_BLOCK_MIN+ distinct real amounts from the local real-data files;
//   * a `confidential: true` payload, unless this repo is registered as a confidential store.
//
// Confidential deal TERMS are matched by the shared, refute-hardened Python scanner
// scripts/prepush_confidential_scan.py (vendored from ora-skills; one source of truth for terms, roster
// handling and term output withholding across every ORA repo). This file RUNS it first (runTermScan)
// and blocks on any failure, so every installed wrapper version gets the term scan, including an older
// one that never calls Python itself (refute run wf_0df7879e-d79). This file used to carry its own
// term/context-term matcher.
//
// Range per pushed ref, mirroring the Python scanner (no local tracking ref is ever trusted):
//   * an existing remote ref scans remoteSha..localSha (git took remoteSha from the destination);
//   * a new remote ref (or a remoteSha this clone does not have) scans the pushed commits NOT
//     reachable from what the destination advertises (`git ls-remote <push url>`, hook argv[2],
//     with the same insteadOf / receivepack / transport guards), or the FULL history when the
//     destination cannot be asked or advertises nothing usable.
// Every git call runs with --no-replace-objects and GIT_NO_REPLACE_OBJECTS=1, so `git replace`
// cannot show this scan a different object from the one pack-objects sends.
//
// Node built-ins only (runs in a git hook with no install step).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This scanner's own implementation + tests necessarily contain `confidential: true` fixtures, so they
// are excluded from that one check to avoid self-triggering. They are NOT excluded from the real-amount
// check (synthetic literals cannot match real fingerprints) or from term scanning (the Python scanner
// reads every file).
const EXCLUDE_PATHS = new Set([
  'scripts/prepush-confidential-scan.mjs',
  'scripts/prepush-confidential-scan.d.mts',
  'scripts/install-git-hooks.ts',
  'tests/unit/prepush-confidential-scan.test.ts',
]);

// ── pinned git (2026-11-12) ──────────────────────────────────────────────────────────────────────
// Every git call whose output this scanner parses is pinned against user/repo config that changes
// what git prints. Unpinned, `color.diff=always` wraps each '+' line in an escape sequence (no line
// starts with '+', nothing is scanned), `diff.external` or a textconv driver replaces the diff
// text outright, `diff.noprefix` / `diff.mnemonicPrefix` / `diff.srcPrefix` change the '+++ b/'
// header, and `diff.relative` narrows the diff to a subdirectory. `--no-replace-objects` (plus
// GIT_NO_REPLACE_OBJECTS=1 in gitEnv) makes git read the objects push actually sends. Mirrors GIT_BASE
// in the Python scanner.
const GIT_CONFIG_PIN = [
  '--no-replace-objects',
  '-c', 'core.quotepath=off',
  '-c', 'color.ui=never',
  '-c', 'color.diff=never',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.relative=false',
  '-c', 'diff.suppressBlankEmpty=false',
  '-c', 'i18n.logOutputEncoding=UTF-8',
  '-c', 'log.showSignature=false',
];
// --text: a `-diff` / `binary` attribute (committed, info/attributes or core.attributesFile), a NUL
// byte or core.bigFileThreshold would otherwise print "Binary files differ" instead of the lines.
const DIFF_OPTION_PIN = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'];

/** The hook's environment with replace refs disabled and no credential prompt. */
function gitEnv() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
  delete env['GIT_REPLACE_REF_BASE'];
  return env;
}

/**
 * Run a pinned git command and return stdout (throws on a non-zero exit; callers fail closed).
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {{input?: string, buffer?: boolean, timeout?: number}} [opts]
 * @returns {any}
 */
function gitRun(args, cwd, opts = {}) {
  return execFileSync('git', [...GIT_CONFIG_PIN, ...args], {
    ...(opts.buffer ? {} : { encoding: 'utf8' }),
    maxBuffer: Infinity,
    input: opts.input ?? '',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: gitEnv(),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
    cwd,
  });
}

/** @param {string[]} args @param {string} [cwd] @param {string} [input] @returns {string} */
function gitOut(args, cwd, input) {
  return /** @type {string} */ (gitRun(args, cwd, input === undefined ? {} : { input }));
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
  // Tracked files that share a listed file's stem but are not copies of it, each with its reason.
  const allow = parsed?.copyRuleAllow && typeof parsed.copyRuleAllow === 'object' ? Object.keys(parsed.copyRuleAllow) : [];
  return { files, dirs, allow };
}

/** What may follow a listed file's stem in a copy's name: end of name, or a separator (space, '-',
 *  '_', '(', '.', '~'). Explorer / browser / editor / writer copies all take one of these shapes:
 *  "x - Copy.ts", "x (1).json", "x_old.json", "x.json.tmp-1", "x.json~", "x.2026-11-10.json". */
const STEM_SEPARATOR = /[\s\-_(.~]/;

/** The declared copy markers (corrupt, tmp, temp, bak, backup, orig, old, quarantine, copy), anchored on
 *  name-segment boundaries so ordinary words ("golden", "template", "copyright") never match. Used for
 *  names that carry the stem later, such as "Copy of x.json" or "backup_x.json". */
export const COPY_MARKER = /(?:^|[\s.\-_~()])(?:corrupt|tmp|temp|bak|backup|orig|old|quarantine|copy)(?:$|[\s.\-_~()\d])/i;

/** Normalized repo-relative path: forward slashes, no leading './', lower case (NTFS / core.ignorecase). */
const normPath = (x) => String(x).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/**
 * True when `path` is a copy of the listed file `listed` (refute rounds 5-6): anywhere at any depth
 * under the listed file's folder, a name that starts with the listed stem followed by the end of the
 * name or a separator, or a name that contains the stem (anchored on a non-alphanumeric boundary)
 * together with a declared copy marker. Kept identical to scripts/governance-check.ts isCopyOf.
 * @param {string} p - normalized path
 * @param {string} listed - normalized listed file
 */
export function isCopyOf(p, listed) {
  const slash = listed.lastIndexOf('/');
  const dir = slash >= 0 ? listed.slice(0, slash + 1) : '';
  if (!p.startsWith(dir) && !inCopiedFolder(p, dir)) return false;
  const base = listed.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/^\./, ''); // '.x.json' -> 'x'
  if (!stem) return false;
  const name = p.slice(p.lastIndexOf('/') + 1).replace(/^\./, ''); // '.x.json.swp' (vim) is a copy too
  if (name.startsWith(stem)) {
    const next = name.charAt(stem.length);
    if (next === '' || STEM_SEPARATOR.test(next)) return true;
  }
  const at = name.indexOf(stem);
  if (at > 0 && !/[a-z0-9]/.test(name.charAt(at - 1))) {
    const after = name.charAt(at + stem.length);
    if ((after === '' || !/[a-z0-9]/.test(after)) && COPY_MARKER.test(name.slice(0, at))) return true;
  }
  return false;
}

/** True when `p` lies under a copy of the folder `dir` (for "a/b/" that is "a/b - Copy/", "a/b.bak/",
 *  "a/b (1)/" ...): the listed folder's own name followed by a separator, beside the original. */
function inCopiedFolder(p, dir) {
  const trimmed = dir.replace(/\/$/, '');
  if (!trimmed) return false;
  const cut = trimmed.lastIndexOf('/');
  const parent = cut >= 0 ? trimmed.slice(0, cut + 1) : '';
  const folder = trimmed.slice(cut + 1);
  if (!p.startsWith(parent + folder)) return false;
  const rest = p.slice(parent.length + folder.length);
  const end = rest.indexOf('/');
  return end > 0 && STEM_SEPARATOR.test(rest.charAt(0));
}

/**
 * True when `path` is a real-data path the manifest covers: a listed file or directory, or a copy of a
 * listed file (isCopyOf). Synthetic stand-ins under fixtures/synthetic/ never match, and neither do the
 * reasoned tracked siblings in the manifest's copyRuleAllow.
 * @param {string} path - repo-relative, either slash style.
 * @param {{files: string[], dirs: string[], allow?: string[]}} manifest
 */
export function isRealDataPath(path, manifest) {
  const p = normPath(path);
  if (p.startsWith(SYNTHETIC_PREFIX)) return false;
  if ((manifest.allow ?? []).some((a) => normPath(a) === p)) return false;
  if (manifest.dirs.some((d) => p.startsWith(normPath(d)))) return true;
  return manifest.files.some((f) => isCopyOf(p, normPath(f)));
}

// ── content fingerprint (refute round 6) ─────────────────────────────────────────────────────────
// A path rule cannot see a renamed copy, or real figures pasted into an ordinary file. This check
// reads the REAL manifest files on this machine, collects their distinctive amounts, and blocks a
// push whose added lines in any one file carry FINGERPRINT_BLOCK_MIN or more of them. It FAILS OPEN
// where no real data exists (CI and synthetic checkouts: every manifest file is absent or a synthetic
// stand-in, so there is nothing to compare against); the path rules above still apply there.

/** Distinct real amounts in one file's added lines that block the push. */
export const FINGERPRINT_BLOCK_MIN = 3;
/** The same threshold for the committed synthetic fixtures. Their money is seeded random draws (each
 *  proved to be its own public draw #0 in CI), and across thousands of drawn values a handful equal a
 *  real amount from some other field by pure coincidence (the generator's own leak check is field-aware
 *  and reports none). A copy of real data would carry hundreds or thousands; coincidences stay in the
 *  single digits. */
export const FINGERPRINT_BLOCK_MIN_SYNTHETIC = 50;

/** JSON keys whose numbers are quantities, not money (square feet, counts, pages). */
const NON_MONEY_KEYS = /^(sf|leased_sf|common_area_sf|rentable_sf|rentableSf|building_sf|land_sf|qty|n|nm|n_months|index|tenants|tenantCount|pages_total|pages_without_text|pages_read|source_page|buildings|year|units)$/i;

/** Canonical form of a numeric token: separators and '$' dropped, absolute value. */
const canonAmount = (raw) => {
  const n = Number(String(raw).replace(/[$,_\s]/g, ''));
  return Number.isFinite(n) ? String(Math.abs(n)) : null;
};

/** Distinctive: at least 1,000, not a round thousand, six or more significant digits. */
const distinctiveAmount = (c) => {
  const n = Number(c);
  if (!(n >= 1000) || Number.isInteger(n / 1000)) return false;
  return c.replace(/\D/g, '').replace(/^0+/, '').length >= 6;
};

const NUMBER_TOKEN = /\$?\d{1,3}(?:[,_]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * The distinctive amounts of the REAL manifest files under `root`, or null when none is real (CI, a
 * synthetic checkout): the caller then fails open. A file counts as synthetic when it is listed in
 * data/.synthetic-seeded.json or byte-identical to its stand-in under fixtures/synthetic/.
 * @param {string} root
 * @param {string} [manifestPath] - test seam
 * @returns {Set<string> | null}
 */
export function realAmountFingerprints(root, manifestPath) {
  const parsed = JSON.parse(readFileSync(manifestPath ?? join(root, 'scripts', 'fixtures', 'real-data-manifest.json'), 'utf8'));
  const marker = join(root, 'data', '.synthetic-seeded.json');
  let seeded = new Set();
  try {
    if (existsSync(marker)) seeded = new Set((JSON.parse(readFileSync(marker, 'utf8')).seeded ?? []).map((x) => normPath(x)));
  } catch {
    seeded = new Set(['*']); // unreadable marker: treat everything as synthetic (no comparison possible)
  }
  const rels = [...(parsed.files ?? [])];
  const walk = (d) => {
    const abs = join(root, d);
    if (!existsSync(abs)) return;
    for (const n of readdirSync(abs)) {
      const rel = `${d.replace(/\/$/, '')}/${n}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else rels.push(rel);
    }
  };
  for (const d of parsed.dirs ?? []) walk(d);
  const out = new Set();
  let realFiles = 0;
  const add = (c) => {
    if (c && distinctiveAmount(c)) out.add(c);
  };
  const walkJson = (v, key) => {
    if (Array.isArray(v)) v.forEach((x) => walkJson(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkJson(x, k);
    else if (typeof v === 'number' && !NON_MONEY_KEYS.test(key)) add(canonAmount(v));
  };
  for (const rel of rels) {
    const abs = join(root, rel);
    if (!existsSync(abs) || seeded.has('*') || seeded.has(normPath(rel))) continue;
    const text = readFileSync(abs, 'utf8');
    const fixture = join(root, 'fixtures', 'synthetic', rel);
    if (existsSync(fixture) && readFileSync(fixture, 'utf8') === text) continue;
    realFiles += 1;
    const embedded = rel.endsWith('.html') ? /<script type="application\/json" id="data">(.*)<\/script>/.exec(text)?.[1] : undefined;
    try {
      if (rel.endsWith('.json')) walkJson(JSON.parse(text), '');
      else if (embedded !== undefined) walkJson(JSON.parse(embedded), '');
      else for (const m of text.matchAll(NUMBER_TOKEN)) if (m[0].includes('.')) add(canonAmount(m[0])); // non-JSON: cents only
    } catch {
      for (const m of text.matchAll(NUMBER_TOKEN)) if (m[0].includes('.')) add(canonAmount(m[0]));
    }
  }
  return realFiles === 0 ? null : out;
}

/**
 * Files whose added lines carry FINGERPRINT_BLOCK_MIN or more distinct real amounts.
 * @param {{file: string, lineNo: number, text: string}[]} addedLines
 * @param {Set<string>} fingerprints
 * @returns {{file: string, count: number}[]}
 */
export function scanAddedLinesForRealAmounts(addedLines, fingerprints) {
  const byFile = new Map();
  for (const a of addedLines) {
    for (const m of a.text.matchAll(NUMBER_TOKEN)) {
      const c = canonAmount(m[0]);
      if (c && fingerprints.has(c)) {
        const set = byFile.get(a.file) ?? new Set();
        set.add(c);
        byFile.set(a.file, set);
      }
    }
  }
  const min = (file) => (normPath(file).startsWith(SYNTHETIC_PREFIX) ? FINGERPRINT_BLOCK_MIN_SYNTHETIC : FINGERPRINT_BLOCK_MIN);
  return [...byFile].filter(([file, set]) => set.size >= min(file)).map(([file, set]) => ({ file, count: set.size }));
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
    // A merge's combined (--cc) row carries one letter per parent ("AA\tpath", "MM\tpath"); any
    // A/M/T/C/R letter means the path exists in the result. Pure deletions ("D", "DD") never match.
    const m = /^([A-Z]*[AMTCR][A-Z]*)\d*\t(?:[^\t]+\t)?(.+)$/.exec(line.trimEnd());
    if (!m || !m[2]) continue;
    if (isRealDataPath(m[2], manifest)) out.push(m[2].replace(/\\/g, '/'));
  }
  return out;
}

/** Safely read+parse a JSON file: `{ok:true, data}` or `{ok:false, reason:'missing'|'unparseable',
 * error}`. Never throws (isRegisteredConfidentialRepo). */
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
    const gitDir = gitOut(['rev-parse', '--git-common-dir'], cwdOverride).trim();
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

/** Pseudo-file name that commit-message lines carry in parseAddedLines output. */
export const COMMIT_MESSAGE_FILE_PREFIX = '(commit message ';

// Parses unified `git diff` / `git log -p --cc` text into ADDED content lines only, tracking the
// current file (from '+++ b/<path>') and new-side line numbers (from the hunk-header markers).
// Note: those markers are not spelled out literally inside the JSDoc block below because two
// adjacent '@' characters there parse as an (invalid) JSDoc tag.
//
// State machine (2026-11-12): '+++ ' / '--- ' are file headers ONLY outside a hunk. Inside a hunk
// every line is content, classified by its prefix columns, so an added line whose own text starts
// with "++ " (raw "+++ ...") is scanned instead of being mistaken for a header (it used to be
// skipped AND re-point the current file). A merge's combined hunk (N+1 '@' characters for N
// parents) carries N prefix columns; any '+' column means the line is in the result and absent
// from at least one parent, so it is treated as added. 'commit <sha>' lines (from diffFor's log
// format) end the hunk and open that commit's message block, whose 4-space-indented lines are
// returned as added lines of the pseudo-file "(commit message <sha12>)".
/**
 * @param {string} diffText
 * @returns {{file: string, lineNo: number, text: string}[]}
 */
export function parseAddedLines(diffText) {
  const added = [];
  if (typeof diffText !== 'string' || diffText.length === 0) return added;

  let currentFile = '';
  let newLineNo = 0;
  let inHunk = false;
  let columns = 1;
  /** @type {string | null} */
  let messageFile = null;
  let messageLineNo = 0;
  const hunkHeader = /^(@{2,}) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @{2,}/;
  const commitLine = /^commit ([0-9a-f]{40,64})$/;

  for (const rawLine of diffText.split('\n')) {
    const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const commit = commitLine.exec(raw);
    if (commit) {
      inHunk = false;
      currentFile = '';
      messageFile = `${COMMIT_MESSAGE_FILE_PREFIX}${commit[1]?.slice(0, 12)})`;
      messageLineNo = 0;
      continue;
    }
    if (raw.startsWith('diff ')) {
      inHunk = false;
      messageFile = null;
      continue;
    }
    if (messageFile !== null) {
      // Message block: every line until the first 'diff ' header (or the next commit) belongs to
      // the commit message. diffFor indents each message line by 4 spaces.
      messageLineNo += 1;
      if (raw.trim()) added.push({ file: messageFile, lineNo: messageLineNo, text: raw.replace(/^ {4}/, '') });
      continue;
    }
    const m = hunkHeader.exec(raw);
    if (m) {
      inHunk = true;
      columns = (m[1]?.length ?? 2) - 1;
      newLineNo = Number.parseInt(m[2] ?? '0', 10);
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith('+++ ')) {
        // '+++ b/path/to/file' (or '+++ /dev/null'); strip the a/ or b/ prefix.
        // Strip only the TAB git appends after a name containing a space: trimming all whitespace
        // turned 'scripts/install-git-hooks.ts ' (trailing space) into an EXCLUDE_PATHS entry
        // (refute run wf_0df7879e-d79, low).
        currentFile = raw.slice(4).replace(/\t$/, '').replace(/^[ab]\//, '');
        continue;
      }
      if (raw.startsWith('--- ')) continue;
      // Any other '+' line outside a hunk is unexpected; scan it rather than drop it.
      if (raw.startsWith('+')) added.push({ file: currentFile, lineNo: newLineNo, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const prefix = raw.slice(0, columns);
    if (prefix.includes('+')) {
      added.push({ file: currentFile, lineNo: newLineNo, text: raw.slice(columns) });
      newLineNo += 1;
      continue;
    }
    if (prefix.includes('-')) continue; // removed line — does not advance the new-side counter
    // context line (prefix of spaces, or an empty line) advances the new-side counter
    newLineNo += 1;
  }
  return added;
}

const ZERO_SHA = /^0+$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LS_REMOTE_TIMEOUT_MS = 60_000;
const PLAIN_SCHEMES = new Set(['file', 'ssh', 'http', 'https', 'git']);

/** True for a plain file / ssh / http(s) / git URL, scp-like `host:path` or local path; false for
 * `<helper>::...` (ext:: included) or any other scheme. Same rule as the Python scanner.
 * @param {string} target */
function plainTransport(target) {
  if (target.includes('::')) return false;
  const at = target.indexOf('://');
  if (at >= 0) return PLAIN_SCHEMES.has(target.slice(0, at).toLowerCase());
  return true;
}

/**
 * Local commit shas the push destination advertises (`git ls-remote`), or [] when it cannot be asked
 * or advertises nothing usable (the caller then scans full history). Mirrors destination_bound() in
 * scripts/prepush_confidential_scan.py: the bound is REFUSED unless ls-remote provably asks the
 * repository the push goes to (the target resolves to itself through insteadOf, no custom
 * receivepack / uploadpack on the remote, a plain transport). No local tracking ref is consulted.
 *
 * @param {string | undefined} remote - the hook's argv[1] (remote name or URL).
 * @param {string | undefined} url - the hook's argv[2] (push URL).
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function destinationBound(remote, url, cwd) {
  const target = url || remote;
  if (!target || target.startsWith('-') || !plainTransport(target)) return [];
  if (remote && !remote.startsWith('-')) {
    for (const key of ['receivepack', 'uploadpack']) {
      try {
        if (gitOut(['config', '--get', `remote.${remote}.${key}`], cwd).trim()) return [];
      } catch {
        // unset: exit 1
      }
    }
  }
  let advertised;
  try {
    const resolved = /** @type {string} */ (gitRun(['ls-remote', '--get-url', target], cwd, { timeout: LS_REMOTE_TIMEOUT_MS })).trim();
    if (resolved !== target) return []; // insteadOf would rewrite the target again: another repository
    const listing = /** @type {string} */ (gitRun(['ls-remote', target], cwd, { timeout: LS_REMOTE_TIMEOUT_MS }));
    advertised = [...new Set(listing.split('\n').map((l) => (l.split('\t')[0] ?? '').trim()).filter((s) => SHA_RE.test(s)))];
  } catch {
    return [];
  }
  if (advertised.length === 0) return [];
  let check;
  try {
    check = gitOut(['cat-file', '--batch-check'], cwd, advertised.map((s) => `${s}^{commit}\n`).join(''));
  } catch {
    return [];
  }
  const out = [];
  for (const line of check.split('\n')) {
    const [sha, type] = line.trim().split(/\s+/);
    if (type === 'commit' && sha && SHA_RE.test(sha) && !out.includes(sha)) out.push(sha);
  }
  return out;
}

/**
 * The commits one pushed ref makes new on the destination, as git rev arguments plus `^<sha>` lines
 * for --stdin (any number of them, no command-line cap).
 *   * existing remote ref whose sha this clone has: localSha ^remoteSha;
 *   * otherwise (new ref, or a remote sha unknown here): localSha minus the destination-advertised
 *     `bound` (destinationBound), i.e. the FULL history of localSha when the bound is empty.
 *
 * @param {string} remoteSha
 * @param {string} localSha
 * @param {string} [cwd]
 * @param {string[]} [bound]
 * @returns {{args: string[], exclude: string[]}}
 */
export function rangeFor(remoteSha, localSha, cwd, bound) {
  if (remoteSha && !ZERO_SHA.test(remoteSha)) {
    try {
      gitOut(['cat-file', '-e', `${remoteSha}^{commit}`], cwd);
      return { args: [localSha, `^${remoteSha}`], exclude: [] };
    } catch {
      console.warn(
        `[prepush-confidential-scan] remote sha ${remoteSha} is not in the local object DB -- ` +
          'bounding the scan by what the destination advertises instead (full history if it cannot be asked).',
      );
    }
  }
  return { args: [localSha], exclude: [...(bound ?? [])] };
}

/** Run `git log <logArgs> <range>`, feeding the range's exclusions on --stdin.
 * @param {string[]} logArgs @param {{args: string[], exclude: string[]}} range @param {string} [cwd]
 * @param {boolean} [buffer] @returns {any} */
function logRange(logArgs, range, cwd, buffer) {
  const stdin = range.exclude.length > 0;
  return gitRun(['log', ...logArgs, ...range.args, ...(stdin ? ['--stdin'] : [])], cwd, {
    input: stdin ? range.exclude.map((s) => `^${s}\n`).join('') : '',
    buffer,
  });
}

/**
 * The type a pushed sha finally peels to ('commit', 'tree', 'blob', ...), following annotated tags.
 * @param {string} sha @param {string} [cwd] @returns {string}
 */
export function peeledType(sha, cwd) {
  return gitOut(['cat-file', '-t', `${sha}^{}`], cwd).trim();
}

/**
 * Every blob a range adds or modifies, merges included (`--cc` lists what a merge resolution itself
 * changed), parsed from `git log --raw -z` so a path with a quote, backslash, tab or newline is read
 * verbatim (never C-quoted), and T (type-change) rows count like A/M. Raw output never consults
 * gitattributes. Deletions and submodules are skipped.
 *
 * @param {{args: string[], exclude: string[]}} range
 * @param {string} [cwd]
 * @returns {{commit: string, path: string, blob: string}[]}
 */
export function rangeBlobs(range, cwd) {
  const marker = `ORA-PREPUSH-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const raw = /** @type {string} */ (
    logRange(['--raw', '--cc', '--root', '-z', '--no-abbrev', '--no-renames', '--no-color', `--format=${marker}%H`], range, cwd)
  );
  return parseRawLog(raw, marker);
}

/**
 * Parse `git log --raw -z --format=<marker>%H` output. Any non-empty field that is neither a marker
 * nor a raw record THROWS (the caller fails closed): an unexpected line could otherwise shift blobs
 * onto the wrong commit. Same rules as parse_raw_log() in the Python scanner.
 *
 * @param {string} raw
 * @param {string} marker
 * @returns {{commit: string, path: string, blob: string}[]}
 */
export function parseRawLog(raw, marker) {
  const fields = raw.split('\0');
  const out = [];
  const seen = new Set();
  let commit = '';
  for (let i = 0; i < fields.length; ) {
    const meta = (fields[i] ?? '').replace(/^\n+/, '');
    if (meta.startsWith(marker)) {
      commit = meta.slice(marker.length).trim();
      if (!SHA_RE.test(commit)) throw new Error('unparseable `git log --raw` commit line');
      i += 1;
      continue;
    }
    if (!meta.startsWith(':')) {
      if (meta.trim()) throw new Error('unrecognised `git log --raw` output');
      i += 1;
      continue;
    }
    if (!commit) throw new Error('`git log --raw` record before any commit line');
    const path = fields[i + 1] ?? '';
    i += 2;
    const parents = meta.length - meta.replace(/^:+/, '').length;
    const parts = meta.replace(/^:+/, '').trim().split(/\s+/);
    if (parts.length < 2 * parents + 3) throw new Error('unparseable `git log --raw` record');
    const newMode = parts[parents] ?? '';
    const newSha = parts[2 * parents + 1] ?? '';
    if (ZERO_SHA.test(newSha) || newMode === '160000') continue; // deletion or submodule
    const key = `${commit}\0${path}\0${newSha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ commit, path, blob: newSha });
  }
  return out;
}

/**
 * Read objects whole through one `git cat-file --batch`. Throws on a missing object.
 * @param {string[]} shas @param {string} [cwd] @returns {Map<string, Buffer>}
 */
function readBlobs(shas, cwd) {
  const out = new Map();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return out;
  const buf = /** @type {Buffer} */ (gitRun(['cat-file', '--batch'], cwd, { input: unique.map((s) => `${s}\n`).join(''), buffer: true }));
  let at = 0;
  for (const sha of unique) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) throw new Error(`short read for object ${sha.slice(0, 12)}`);
    const header = buf.subarray(at, nl).toString('ascii').split(' ');
    if (header[1] === 'missing' || header.length < 3) throw new Error(`object ${sha.slice(0, 12)} unreadable`);
    const size = Number(header[2]);
    out.set(sha, buf.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1; // trailing LF
  }
  return out;
}

const EXPORT_EXT_RE = /\.(xlsx|xlsm|xls|pdf|docx|doc|csv)$/i;

/**
 * True when a file under data/ must not be pushed: binary by CONTENT (a NUL byte anywhere; never by
 * git's binary flag, which a gitattribute can flip either way), or an export/document extension (a
 * CSV, or a small PDF with no NUL byte, reads as text and would otherwise pass).
 * @param {string} path @param {Uint8Array} content
 */
export function isBlockedDataFile(path, content) {
  const p = path.replace(/\\/g, '/');
  if (!p.startsWith('data/')) return false;
  return EXPORT_EXT_RE.test(p) || content.includes(0);
}

/**
 * Per-commit text of a pushed range for the payload checks: `git log -p --cc --root --text` (see
 * DIFF_OPTION_PIN). An endpoint `git diff base..local` compares two trees only, so content added in
 * commit A and removed in commit B was never scanned, yet A's blob still reaches the remote. --cc shows
 * what a merge resolution itself introduced; --no-renames shows a renamed file's whole content. Each
 * commit is preceded by a 'commit <sha>' line and its 4-space-indented message (parseAddedLines).
 *
 * No fixed maxBuffer cap: a diff too large for one JS string throws, and that throw BLOCKS the push.
 * @param {string} remoteSha @param {string} localSha @param {string} [cwd] @param {string[]} [bound]
 * @returns {string}
 */
export function diffFor(remoteSha, localSha, cwd, bound) {
  return /** @type {string} */ (
    logRange(['-p', '--cc', '--root', '--no-renames', '--format=commit %H%n%w(0,4,4)%B', ...DIFF_OPTION_PIN], rangeFor(remoteSha, localSha, cwd, bound), cwd)
  );
}

/** Binary/export paths under data/ added or modified by ANY commit of the pushed range.
 * @param {string} remoteSha @param {string} localSha @param {string} [cwd] @param {string[]} [bound]
 * @returns {string[]} */
export function binaryPathsFor(remoteSha, localSha, cwd, bound) {
  const entries = rangeBlobs(rangeFor(remoteSha, localSha, cwd, bound), cwd).filter((e) => e.path.replace(/\\/g, '/').startsWith('data/'));
  const blobs = readBlobs(entries.map((e) => e.blob), cwd);
  const hits = entries.filter((e) => isBlockedDataFile(e.path, blobs.get(e.blob) ?? new Uint8Array())).map((e) => e.path.replace(/\\/g, '/'));
  return [...new Set(hits)];
}

/** Real-data manifest paths added or modified by ANY commit of the pushed range.
 * @param {string} remoteSha @param {string} localSha @param {{files: string[], dirs: string[]}} manifest
 * @param {string} [cwd] @param {string[]} [bound] @returns {string[]} */
export function realDataPathsFor(remoteSha, localSha, manifest, cwd, bound) {
  const paths = rangeBlobs(rangeFor(remoteSha, localSha, cwd, bound), cwd).map((e) => e.path);
  return [...new Set(paths.filter((p) => isRealDataPath(p, manifest)).map((p) => p.replace(/\\/g, '/')))];
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

// ── confidential-term scan (Python, run from here) ───────────────────────────────────────────────
/** The shared Python term scanner, from the same tree as this file (vendored from ora-skills). */
export const PY_SCANNER = join(dirname(fileURLToPath(import.meta.url)), 'prepush_confidential_scan.py');

/** Interpreter names probed in order. Each must actually RUN Python 3.8+ (the Windows Store
 * 'python' stub exists on PATH but fails the probe). */
export const PYTHON_CANDIDATES = ['python', 'python3', 'py'];

/**
 * First interpreter in PYTHON_CANDIDATES that runs Python 3.8+ in isolated mode, or null.
 * @param {typeof spawnSync} [run] - test seam.
 * @returns {string | null}
 */
export function findPython(run = spawnSync) {
  for (const c of PYTHON_CANDIDATES) {
    const r = run(c, ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30_000,
    });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

/**
 * Run the Python term scanner over the push: the buffered ref lines on its stdin, git's remote name
 * and push URL as argv. `-I` (isolated mode): no PYTHONPATH / PYTHONSTARTUP / PYTHONINSPECT, no user
 * site-packages, and the script's directory is not on sys.path, so nothing beside it can shadow a
 * stdlib module. Its stderr (block lines, never a term) passes through. Fails closed on everything:
 * no scanner, no usable Python, a spawn error, a signal, any non-zero exit.
 *
 * @param {string} stdinText
 * @param {(string | undefined)[]} argv - [remote, url]; trailing undefined entries are dropped.
 * @param {{scanner?: string, python?: string | null, run?: typeof spawnSync}} [deps] - test seams.
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function runTermScan(stdinText, argv, deps = {}) {
  const scanner = deps.scanner ?? PY_SCANNER;
  const run = deps.run ?? spawnSync;
  if (!existsSync(scanner)) {
    return { ok: false, message: `confidentiality term scanner not found (${scanner}); fail closed (Invariant 3).` };
  }
  const python = deps.python !== undefined ? deps.python : findPython(run);
  if (!python) {
    return {
      ok: false,
      message: `no Python 3.8+ found (tried ${PYTHON_CANDIDATES.join(', ')}) to run the confidentiality term scan; fail closed (Invariant 3).`,
    };
  }
  const args = [...argv];
  while (args.length && args[args.length - 1] === undefined) args.pop();
  const r = run(python, ['-I', scanner, ...args.map((a) => a ?? '')], {
    input: stdinText,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
    maxBuffer: Infinity,
  });
  if (r.error) return { ok: false, message: `confidentiality term scan could not run (${errorLine(r.error)}); fail closed (Invariant 3).` };
  if (r.status !== 0) {
    return {
      ok: false,
      message: `confidentiality term scan ${r.status === null ? `was killed (${r.signal})` : `exited ${r.status}`}; see the lines above (Invariant 3).`,
    };
  }
  return { ok: true };
}

/**
 * Read git's pre-push stdin. A read ERROR used to be swallowed into '' -- no refs, nothing scanned,
 * exit 0 -- so it now comes back as `error` and the caller fails closed (2026-11-12). A genuinely
 * empty stdin (git sends none on an up-to-date push) is still `{text: '', error: null}`, and so is
 * an EOF error, which some platforms raise for a closed, empty pipe.
 *
 * @param {() => string} [read] - test seam; defaults to a synchronous read of fd 0.
 * @returns {{text: string, error: string | null}}
 */
export function readPushStdin(read) {
  try {
    return { text: (read ?? (() => readFileSync(0, 'utf8')))(), error: null };
  } catch (err) {
    if (/** @type {{code?: string}} */ (err)?.code === 'EOF') return { text: '', error: null };
    return { text: '', error: `stdin read: ${errorLine(err)}` };
  }
}

/** Shared "print header, list hits, print trailer, exit 1" shape both block paths below use. */
function blockOnHits(hits, header, formatHit, trailer) {
  console.error(`\n✖  PUSH BLOCKED — ${header}:\n`);
  for (const h of hits) console.error(`   ${formatHit(h)}`);
  console.error(`\n${trailer}\n`);
  process.exit(1);
}

/** First line of an error's code or message, for a one-line diffErrors entry. @param {unknown} err */
function errorLine(err) {
  const e = /** @type {{code?: string, message?: string}} */ (err);
  return String(e?.code ?? e?.message ?? err).split('\n')[0] ?? '';
}

/**
 * Parse git's pre-push stdin ("<local ref> <local sha> <remote ref> <remote sha>" per line) and
 * collect, per pushed ref, the added diff lines (minus EXCLUDE_PATHS), the binary/export paths under
 * data/ and (with `deps.manifest`) the real-data paths. A ref that could NOT be scanned is recorded in
 * diffErrors -- never silently skipped -- so the caller can fail closed: a git failure, or a pushed
 * ref that peels to a tree or blob (git log shows nothing for it; the Python scanner reads its content
 * for terms, but this payload scan has no commit range to read).
 *
 * The three checks run in SEPARATE try blocks: one failing records its own diffErrors entry and
 * never discards another that succeeded (refute run wf_44a3341e-b41, low).
 *
 * @param {string} stdinText
 * @param {string} [cwd] - test seam; defaults to the process cwd.
 * @param {{remote?: string, url?: string, destinationBound?: (remote: string | undefined, url: string | undefined, cwd?: string) => string[], diffFor?: (remoteSha: string, localSha: string, cwd?: string, bound?: string[]) => string, binaryPathsFor?: (remoteSha: string, localSha: string, cwd?: string, bound?: string[]) => string[], realDataPathsFor?: (remoteSha: string, localSha: string, manifest: {files: string[], dirs: string[]}, cwd?: string, bound?: string[]) => string[], peeledType?: (sha: string, cwd?: string) => string, manifest?: {files: string[], dirs: string[]}}} [deps] - the hook's argv (remote, url) and test seams; defaults to the real git calls.
 * @returns {{addedByRef: {file: string, lineNo: number, text: string}[][], binaryHits: string[], realDataHits: string[], diffErrors: {localSha: string, message: string}[]}}
 */
export function collectRefScan(stdinText, cwd, deps) {
  const getDiff = deps?.diffFor ?? diffFor;
  const getBinaries = deps?.binaryPathsFor ?? binaryPathsFor;
  const getRealData = deps?.realDataPathsFor ?? realDataPathsFor;
  const getType = deps?.peeledType ?? peeledType;
  const getBound = deps?.destinationBound ?? destinationBound;
  const manifest = deps?.manifest;
  /** @type {string[]} */
  const realDataHits = [];
  /** @type {{file: string, lineNo: number, text: string}[][]} */
  const addedByRef = [];
  /** @type {string[]} */
  const binaryHits = [];
  /** @type {{localSha: string, message: string}[]} */
  const diffErrors = [];
  /** @type {string[] | undefined} */
  let bound;
  // Asked once per push, and only if some ref needs it (rangeFor ignores it for a known remote sha).
  const boundOnce = () => (bound ??= getBound(deps?.remote, deps?.url, cwd));
  for (const rawLine of String(stdinText ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO_SHA.test(localSha)) continue; // branch deletion — nothing to scan
    try {
      const type = getType(localSha, cwd);
      if (type !== 'commit') {
        diffErrors.push({ localSha, message: `pushed ref peels to a ${type || 'unknown object'}, not a commit; the payload scan cannot bound it` });
        continue;
      }
    } catch (err) {
      diffErrors.push({ localSha, message: `object type: ${errorLine(err)}` });
      continue;
    }
    const remote = remoteSha ?? '';
    const refBound = !remote || ZERO_SHA.test(remote) || !hasCommit(remote, cwd) ? boundOnce() : undefined;
    try {
      const diffText = getDiff(remote, localSha, cwd, refBound);
      // Unfiltered: EXCLUDE_PATHS applies only to the confidential:true check (main), the one check
      // these files would self-trigger. Real amounts are counted in them too (wf_0df7879e-d79, medium).
      addedByRef.push(parseAddedLines(diffText));
    } catch (err) {
      diffErrors.push({ localSha, message: `text diff: ${errorLine(err)}` });
    }
    try {
      binaryHits.push(...getBinaries(remote, localSha, cwd, refBound));
    } catch (err) {
      diffErrors.push({ localSha, message: `binary paths: ${errorLine(err)}` });
    }
    if (manifest) {
      try {
        realDataHits.push(...getRealData(remote, localSha, manifest, cwd, refBound));
      } catch (err) {
        diffErrors.push({ localSha, message: `real-data paths: ${errorLine(err)}` });
      }
    }
  }
  return { addedByRef, binaryHits, realDataHits, diffErrors };
}

/** @param {string} sha @param {string} [cwd] */
function hasCommit(sha, cwd) {
  try {
    gitOut(['cat-file', '-e', `${sha}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * `node scripts/prepush-confidential-scan.mjs --staged`: the real-data path and content-fingerprint
 * checks over what is staged for the next commit (git diff --cached). Not installed as a hook (the
 * hooks directory is shared by every worktree of the live checkout); run it by hand or from CI.
 */
function stagedMain() {
  const manifest = loadRealDataManifest();
  const names = gitOut(['diff', '--cached', '--name-status', '--no-renames', '--diff-filter=AMT', ...DIFF_OPTION_PIN]);
  const pathHits = parseRealDataPaths(names, manifest);
  const added = parseAddedLines(gitOut(['diff', '--cached', '-U0', '--no-renames', ...DIFF_OPTION_PIN]));
  const fps = realAmountFingerprints(String(gitOut(['rev-parse', '--show-toplevel'])).trim());
  const amountHits = fps ? scanAddedLinesForRealAmounts(added, fps) : [];
  if (!fps) console.log('[prepush-confidential-scan --staged] content fingerprint check skipped: no real data on this machine.');
  for (const p of pathHits) console.error(`real-data path staged: ${p}`);
  for (const h of amountHits) console.error(`real amounts staged: ${h.file} (${h.count})`);
  process.exit(pathHits.length || amountHits.length ? 1 : 0);
}

function main() {
  if (process.argv.includes('--staged')) return stagedMain();
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
  // A stdin read ERROR means the pushed refs are unknown, so nothing would be scanned: it is recorded
  // as a diff error and fails closed through the same PREPUSH_ALLOW_DIFF_ERROR gate (2026-11-12). An
  // empty stdin (up-to-date push) is not an error.
  const stdin = readPushStdin();
  // git passes pre-push hooks the remote name and push URL (argv[1], argv[2]); the hook wrapper
  // forwards them. They bound a new ref by what the destination advertises. A wrapper that predates
  // the forwarding passes neither, and both scanners then scan new refs in full.
  const [remote, url] = process.argv.slice(2).filter((a) => a !== '--staged');

  // Confidential TERMS first. This file runs the Python scanner itself, so the term scan cannot be
  // skipped by whichever pre-push wrapper happens to be installed in the SHARED .git/hooks (an older
  // worktree's installer rewrites it with a wrapper that never calls Python; refute run
  // wf_0df7879e-d79, high). No override here: PREPUSH_ALLOW_DIFF_ERROR covers the payload scan only.
  if (stdin.error) {
    console.error(`\n✖  PUSH BLOCKED — the pushed refs could not be read (${stdin.error}), so the confidential-term scan cannot run (Invariant 3, fail closed).\n`);
    process.exit(1);
  }
  const terms = runTermScan(stdin.text, [remote, url]);
  if (!terms.ok) {
    console.error(`\n✖  PUSH BLOCKED — ${terms.message}\n`);
    process.exit(1);
  }

  const { addedByRef, binaryHits, realDataHits, diffErrors } = collectRefScan(stdin.text, undefined, { manifest, remote, url });
  const flagHits = [];
  for (const added of addedByRef) {
    // The confidential:true check is payload-shaped: a commit message describing the flag is not a
    // payload, and this scanner's own files carry the flag as fixtures (EXCLUDE_PATHS).
    flagHits.push(
      ...scanDiffForConfidentialFlag(added.filter((a) => !a.file.startsWith(COMMIT_MESSAGE_FILE_PREFIX) && !EXCLUDE_PATHS.has(a.file))),
    );
  }

  // Fail CLOSED on a ref that could not be scanned (prepush-scan-skips-on-diff-error, 2026-11-08).
  // The explicit per-push opt-out keeps a transient git error from bricking pushes permanently, and
  // it does not suppress real hits found on the refs that WERE scanned (the checks below still run).
  if (diffErrors.length > 0) {
    if (shouldBlockOnDiffError(diffErrors, process.env)) {
      blockOnHits(
        diffErrors,
        'the payload scan could not read the pushed refs (stdin) or scan them, so they were NOT scanned',
        (e) => `${e.localSha}  ->  ${e.message}`,
        'Invariant 3, fail closed. Fix the git error (for a missing remote sha, `git fetch`) ' +
          'and push again, or set PREPUSH_ALLOW_DIFF_ERROR=1 for this one push if you have verified ' +
          'it carries no firm data.',
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

  // Content fingerprint: real figures in a renamed copy or pasted into any file (fails open where no
  // real data exists, e.g. CI).
  let fingerprints = null;
  try {
    fingerprints = realAmountFingerprints(String(gitOut(['rev-parse', '--show-toplevel'])).trim());
  } catch (err) {
    console.warn(`[prepush-confidential-scan] WARN: real-amount fingerprint list unavailable (${errorLine(err)}); content check skipped.`);
  }
  if (fingerprints === null) {
    console.log('[prepush-confidential-scan] content fingerprint check skipped: no real data on this machine (CI or a synthetic checkout).');
  } else {
    // Pooled across every pushed ref, and every commit message counts as one file, so amounts split
    // across refs or across several messages still reach the threshold (wf_0df7879e-d79, low).
    const amountHits = scanAddedLinesForRealAmounts(
      addedByRef.flat().map((a) => (a.file.startsWith(COMMIT_MESSAGE_FILE_PREFIX) ? { ...a, file: `${COMMIT_MESSAGE_FILE_PREFIX}*)` } : a)),
      fingerprints,
    );
    if (amountHits.length > 0) {
      blockOnHits(
        amountHits,
        `added lines carry ${FINGERPRINT_BLOCK_MIN}+ distinct real amounts from the local real-data files`,
        (h) => `${h.file}  ->  ${h.count} real amount(s)`,
        'A copy of real data (renamed or pasted) is about to be pushed. Remove it from the commit and use ' +
          'synthetic values. There is no override.',
      );
    }
  }

  if (binaryHits.length > 0) {
    blockOnHits(
      [...new Set(binaryHits)],
      'binary or export file(s) added or modified under data/',
      (p) => p,
      'Tenant/firm exports (xlsx/pdf) must not be pushed. Gitignore the directory and untrack the ' +
        'file (git rm --cached); decide any history purge with Gabriel.',
    );
  }

  // Structural check: a `"confidential": true` payload is only ever legitimate FROM a repo
  // registered as an intentional in-perimeter confidential store. Registered → informational
  // (the control is visibly firing, not silently no-op); unregistered → BLOCK.
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

  process.exit(0);
}

// Only run as a CLI when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('prepush-confidential-scan.mjs')) {
  main();
}
