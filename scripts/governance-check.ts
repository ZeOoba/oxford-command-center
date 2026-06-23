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
