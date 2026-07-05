/**
 * Governance gate — validates the multi-agent protocol is operational.
 * Runs as the first step of `npm run gate`. Exits 1 on any blocking violation.
 * Warnings are non-blocking (stale files, etc.).
 *
 * Exported functions allow unit testing without process.exit side effects.
 */
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface GovernanceResult {
  pass: boolean;
  errors: string[];
  warnings: string[];
}

const REQUIRED_FILES = [
  'CLAUDE.md',
  'architecture/system-overview.md',
  'architecture/database-schema.md',
  'architecture/api-contracts.md',
  'architecture/coding-standards.md',
  'architecture/agent-assignments.md',
  'architecture/ownership.json',
];

const ARCH_FILES = [
  'architecture/system-overview.md',
  'architecture/database-schema.md',
  'architecture/api-contracts.md',
  'architecture/coding-standards.md',
  'architecture/agent-assignments.md',
  'CLAUDE.md',
];

/** FM-1, FM-2, FM-5: Check all conductor + lock files exist. */
export function checkRequiredFiles(root: string): GovernanceResult {
  const errors: string[] = [];
  for (const rel of REQUIRED_FILES) {
    const full = join(root, rel);
    if (!existsSync(full)) {
      errors.push(`MISSING required governance file: ${rel}`);
    }
  }
  return { pass: errors.length === 0, errors, warnings: [] };
}

/** FM-9: Warn (non-blocking) when architecture files are older than threshold days. */
export function checkStaleFiles(root: string, thresholdDays: number): GovernanceResult {
  const warnings: string[] = [];
  const cutoffMs = thresholdDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const rel of ARCH_FILES) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    try {
      const stat = statSync(full);
      const ageMs = now - stat.mtimeMs;
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      if (ageMs > cutoffMs) {
        warnings.push(
          `STALE: ${rel} is ${ageDays} days old (threshold: ${thresholdDays}d). ` +
            `Update it if architecture has changed.`,
        );
      }
    } catch {
      // stat failure on an existing file is unusual — skip silently
    }
  }
  return { pass: true, errors: [], warnings };
}

/** FM-14: Detect duplicate route definitions across server files. */
export function checkRouteDuplication(root: string): GovernanceResult {
  const errors: string[] = [];
  const serverDir = join(root, 'server');
  if (!existsSync(serverDir)) return { pass: true, errors: [], warnings: [] };

  // Collect all .ts files in server/ (non-recursive for simplicity — routes live at top level)
  let files: string[] = [];
  try {
    files = (readdirSync(serverDir) as unknown as string[])
      .filter((f: string) => f.endsWith('.ts'))
      .map((f: string) => join(serverDir, f));
  } catch {
    return { pass: true, errors: [], warnings: [] };
  }

  // Extract route strings: app.get("/api/foo") → "/api/foo"
  const routePattern = /app\.\w+\(\s*['"`](\/api\/[^'"`]+)['"`]/g;
  const seen = new Map<string, string>(); // route → file

  for (const filePath of files) {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(content)) !== null) {
      const route = match[1];
      if (!route) continue;
      const prev = seen.get(route);
      if (prev) {
        errors.push(
          `DUPLICATE route "${route}" defined in both ${prev} and ${filePath}`,
        );
      } else {
        seen.set(route, filePath);
      }
      // Reset lastIndex after exec loop — pattern has /g flag
    }
    routePattern.lastIndex = 0;
  }

  return { pass: errors.length === 0, errors, warnings: [] };
}

/** Step 9: Enforce that acq-engine.ts never imports directly from capital-config. */
export function checkAcqGovernorCoupling(root: string): GovernanceResult {
  const errors: string[] = [];
  const target = join(root, 'server', 'warehouse', 'acq-engine.ts');
  if (!existsSync(target)) return { pass: true, errors: [], warnings: [] };
  let content = '';
  try {
    content = readFileSync(target, 'utf8');
  } catch {
    return { pass: true, errors: [], warnings: [] };
  }
  // Strip block and line comments before checking to avoid false positives on commented-out imports.
  const code = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const forbidden = /(?:from\s*|import\s*\(\s*)['"][^'"]*capital[-_]config[^'"]*['"]/;
  if (forbidden.test(code)) {
    errors.push(
      'acq-engine.ts must import governors via ./governors — direct import from capital-config detected',
    );
  }
  const requiredLoadGovernorsImport =
    /import\s*\{[^}]*\bloadGovernors\b[^}]*\}\s*from\s*['"]\.\/governors['"]/;
  if (!requiredLoadGovernorsImport.test(code)) {
    errors.push(
      "acq-engine.ts must import loadGovernors from './governors' — governor coupling is broken",
    );
  }
  return { pass: errors.length === 0, errors, warnings: [] };
}

/**
 * Step 10: Detect bare governor-value literals in binary comparisons against
 * governor-named variables in server/warehouse/*.ts.
 *
 * Flags: dscr < 1.25 | dscr > 1.25 | ltv > 0.40 | ltv > 0.4 etc.
 * Pass:  dscr < dscrFloor (symbolic) | width: 1.25 (non-comparison) | // comment
 * Allowlist: governors.ts, debt-api.ts, tests/**
 */
export function checkGovernorLiteralCoupling(root: string): GovernanceResult {
  const errors: string[] = [];
  const warehouseDir = join(root, 'server', 'warehouse');
  const insightsDir = join(root, 'server', 'insights');

  const ALLOWLIST = new Set(['governors.ts', 'debt-api.ts']);

  const files: string[] = [];

  // Stack-based recursive traversal — catches nested files (e.g. server/warehouse/parse/).
  // Scans both server/warehouse/** and server/insights/**.
  // Each root dir is skipped gracefully if it does not yet exist.
  const scanRoots: string[] = [];
  if (existsSync(warehouseDir)) scanRoots.push(warehouseDir);
  if (existsSync(insightsDir)) scanRoots.push(insightsDir);

  if (scanRoots.length === 0) return { pass: true, errors: [], warnings: [] };

  try {
    const stack = [...scanRoots];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !ALLOWLIST.has(entry.name)) {
          files.push(full);
        }
      }
    }
  } catch {
    return { pass: true, errors: [], warnings: [] };
  }

  // Matches a line containing BOTH a governor-named operand AND a governor literal
  // in a comparison context (either order). Explicit comparison operators exclude
  // bare `=` assignments like `const dscr = 1.25`.
  const GOVERNOR_LITERAL_IN_COMPARISON =
    /\b(?:dscr|ltv|loanToValue|ltvRatio|dscrRatio)\b.*?(?:<=|>=|<|>|===|!==|==|!=)\s*(?:1\.25|0\.40?)\b|(?:1\.25|0\.40?)\s*(?:<=|>=|<|>|===|!==|==|!=).*?\b(?:dscr|ltv|loanToValue|ltvRatio|dscrRatio)\b/;

  for (const filePath of files) {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // Strip block and line comments before checking. Preserve newlines within
    // block comments so that line-number reporting in error messages stays accurate.
    const code = content
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
      .replace(/\/\/.*$/gm, '');

    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (GOVERNOR_LITERAL_IN_COMPARISON.test(line)) {
        const rel = filePath.replace(root + '/', '').replace(root + '\\', '');
        errors.push(
          `GOVERNOR_LITERAL: bare governor literal in comparison at ${rel}:${i + 1} — ` +
            `"${line.trim()}" — use loadGovernors(db) instead`,
        );
      }
    }
  }

  return { pass: errors.length === 0, errors, warnings: [] };
}

/**
 * Status-bus integrity: validate architecture/status.json.
 *
 * Blocking errors:
 *   MISSING       — file absent
 *   INVALID_JSON  — JSON.parse failure (this exact defect has shipped before)
 *   DUPLICATE_KEY — raw-text scan; JSON.parse silently keeps the last occurrence,
 *                   so duplicates must be caught before parse semantics hide them
 *   STATUS_SCHEMA — entry violates the file's own _schema (status enum,
 *                   review_needed boolean, last_updated ISO-8601, required keys)
 * Warnings (non-blocking):
 *   STALE_STATUS  — in_progress / review_needed entries not updated in 14 days
 *
 * Entries nested under the legacy "worktrees" wrapper are validated too.
 * Underscore-prefixed keys (_comment, _schema) and the "usage" key are skipped.
 */
const STATUS_VALUES = new Set(['idle', 'in_progress', 'blocked', 'review_needed', 'merged']);
const STATUS_REQUIRED_KEYS = ['agent_role', 'phase', 'status', 'last_updated'];
const STALE_STATUS_THRESHOLD_DAYS = 14;

/** Raw-text duplicate-key scan with brace-depth tracking and proper JSON string skipping. */
function findDuplicateKeys(raw: string): string[] {
  const errors: string[] = [];
  // Per-open-object map of key -> first line seen; parallel stack of entry names.
  const keyStacks: Array<Map<string, number>> = [];
  const nameStack: string[] = [];
  let pendingKey: string | null = null;
  let line = 1;
  let i = 0;

  while (i < raw.length) {
    const c = raw[i];
    if (c === undefined) break;
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '"') {
      // Consume a JSON string, honoring escapes (strings may contain braces/colons).
      let j = i + 1;
      let str = '';
      while (j < raw.length) {
        const sc = raw[j];
        if (sc === undefined) break;
        if (sc === '\\') {
          str += raw[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (sc === '"') break;
        if (sc === '\n') line++;
        str += sc;
        j++;
      }
      // Peek past whitespace: a ':' means this string was a key.
      let k = j + 1;
      while (k < raw.length && /\s/.test(raw[k] ?? '')) {
        if (raw[k] === '\n') line++;
        k++;
      }
      if (raw[k] === ':') {
        const scope = keyStacks[keyStacks.length - 1];
        if (scope) {
          if (scope.has(str)) {
            const entry = nameStack[nameStack.length - 1] ?? '(root)';
            errors.push(
              `DUPLICATE_KEY: architecture/status.json - "${str}" appears twice in entry "${entry}" (line ${line})`,
            );
          } else {
            scope.set(str, line);
          }
        }
        pendingKey = str;
        i = k + 1;
      } else {
        i = j + 1; // string value - not a key
      }
      continue;
    }
    if (c === '{') {
      keyStacks.push(new Map());
      nameStack.push(pendingKey ?? nameStack[nameStack.length - 1] ?? '(root)');
      pendingKey = null;
    } else if (c === '}') {
      keyStacks.pop();
      nameStack.pop();
    }
    i++;
  }
  return errors;
}

/** ISO-8601 timestamp: date-time with Z or numeric offset, parseable by Date. */
function isIso8601(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function validateStatusEntry(
  name: string,
  entry: unknown,
  errors: string[],
  warnings: string[],
): void {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`STATUS_SCHEMA: entry "${name}" - value is not an object`);
    return;
  }
  const record = entry as Record<string, unknown>;

  const missing = STATUS_REQUIRED_KEYS.filter((k) => !(k in record));
  if (missing.length > 0) {
    errors.push(
      `STATUS_SCHEMA: entry "${name}" - missing required keys ${missing.join('/')} ` +
        `(required: agent_role/phase/status/last_updated)`,
    );
  }

  if ('status' in record) {
    const status = record['status'];
    if (typeof status !== 'string' || !STATUS_VALUES.has(status)) {
      errors.push(
        `STATUS_SCHEMA: entry "${name}" - status "${String(status)}" not in ` +
          `idle|in_progress|blocked|review_needed|merged`,
      );
    }
  }

  if ('review_needed' in record && typeof record['review_needed'] !== 'boolean') {
    errors.push(
      `STATUS_SCHEMA: entry "${name}" - review_needed "${String(record['review_needed'])}" not boolean`,
    );
  }

  if ('last_updated' in record && !isIso8601(record['last_updated'])) {
    errors.push(
      `STATUS_SCHEMA: entry "${name}" - last_updated "${String(record['last_updated'])}" not ISO-8601`,
    );
  }

  // Non-blocking staleness: open work (in_progress or awaiting review) untouched for 14+ days.
  const isOpen = record['status'] === 'in_progress' || record['review_needed'] === true;
  if (isOpen && isIso8601(record['last_updated'])) {
    const ageMs = Date.now() - Date.parse(record['last_updated'] as string);
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    if (ageDays > STALE_STATUS_THRESHOLD_DAYS) {
      warnings.push(
        `STALE_STATUS: entry "${name}" - status "${String(record['status'])}"` +
          `${record['review_needed'] === true ? ' with review_needed=true' : ''} ` +
          `last updated ${ageDays} days ago (threshold: ${STALE_STATUS_THRESHOLD_DAYS}d). ` +
          `Close it out or refresh last_updated.`,
      );
    }
  }
}

export function checkStatusJson(root: string): GovernanceResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rel = 'architecture/status.json';
  const full = join(root, 'architecture', 'status.json');

  if (!existsSync(full)) {
    errors.push(`MISSING required governance file: ${rel}`);
    return { pass: false, errors, warnings };
  }

  let raw = '';
  try {
    raw = readFileSync(full, 'utf8');
  } catch {
    // read failure on an existing file is unusual - skip silently (matches checkStaleFiles)
    return { pass: true, errors: [], warnings: [] };
  }

  // Duplicate keys are detectable even when the file does not parse.
  errors.push(...findDuplicateKeys(raw));

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push(`INVALID_JSON: ${rel} - ${(e as Error).message}`);
    return { pass: false, errors, warnings };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push(`INVALID_JSON: ${rel} - root is not an object`);
    return { pass: false, errors, warnings };
  }

  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (name.startsWith('_') || name === 'usage') continue;
    if (name === 'worktrees' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Legacy nested wrapper - validate each child entry.
      for (const [childName, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (childName.startsWith('_')) continue;
        validateStatusEntry(childName, childValue, errors, warnings);
      }
      continue;
    }
    validateStatusEntry(name, value, errors, warnings);
  }

  return { pass: errors.length === 0, errors, warnings };
}

/** Run all checks, print results, and exit with appropriate code. */
function main(): void {
  const root = resolve(process.cwd());
  let allErrors: string[] = [];
  let allWarnings: string[] = [];

  const checks = [
    checkRequiredFiles(root),
    checkStaleFiles(root, 14),
    checkRouteDuplication(root),
    checkAcqGovernorCoupling(root),
    checkGovernorLiteralCoupling(root),
    checkStatusJson(root),
  ];

  for (const result of checks) {
    allErrors = allErrors.concat(result.errors);
    allWarnings = allWarnings.concat(result.warnings);
  }

  if (allWarnings.length > 0) {
    console.warn('\n⚠  Governance warnings (non-blocking):');
    for (const w of allWarnings) console.warn(`   ${w}`);
  }

  if (allErrors.length > 0) {
    console.error('\n✖  Governance check FAILED:');
    for (const e of allErrors) console.error(`   ${e}`);
    console.error(
      '\nFix these issues before proceeding. See CLAUDE.md §0 for the pre-flight checklist.\n',
    );
    process.exit(1);
  }

  console.log('✔  Governance check passed.');
}

// Only run main when executed directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith('governance-check.ts')) {
  main();
}
