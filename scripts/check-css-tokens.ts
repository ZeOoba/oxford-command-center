import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for design-review finding 13: `var(--border)`, `var(--surface)`,
 * `var(--text)`, `var(--danger)`, ... were referenced in components but defined nowhere,
 * so progress-bar tracks rendered transparent and fallbacks (`#b45309`, `#e05c5c`) ignored
 * the active theme. An undefined custom property fails silently in the browser; nothing
 * else in the gate catches it.
 *
 * Every `var(--name)` under src/ must have a definition somewhere under src/: a
 * stylesheet declaration (`--name:`) or an inline setter (`'--name': value`). A `var()`
 * fallback does not excuse a missing definition -- the fallback is what hides the bug.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_EXT = /\.(css|ts|tsx|html)$/;

export interface SourceFile {
  path: string;
  text: string;
}
export interface UndefinedToken {
  token: string;
  path: string;
  line: number;
}

// `var(--pf-c${slot})` builds the name at runtime; the static prefix isn't checkable.
const REFERENCE = /var\(\s*(--[\w-]+)(?![\w-]|\$\{)/g;
const DEFINITION = /(?<![\w-])(--[\w-]+)(?=['"]?\s*:)/g;

export function findUndefinedTokens(files: SourceFile[]): UndefinedToken[] {
  const defined = new Set<string>();
  for (const f of files) for (const m of f.text.matchAll(DEFINITION)) defined.add(m[1]!);

  const out: UndefinedToken[] = [];
  for (const f of files) {
    f.text.split('\n').forEach((lineText, i) => {
      for (const m of lineText.matchAll(REFERENCE)) {
        if (!defined.has(m[1]!)) out.push({ token: m[1]!, path: f.path, line: i + 1 });
      }
    });
  }
  return out;
}

function walk(dir: string, acc: SourceFile[]): SourceFile[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (SCAN_EXT.test(e.name)) {
      acc.push({ path: relative(REPO_ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
    }
  }
  return acc;
}

function main() {
  const files = walk(join(REPO_ROOT, 'src'), []);
  const bad = findUndefinedTokens(files);
  if (bad.length === 0) {
    console.log(`✓ css-tokens: every var(--*) in src/ has a definition (${files.length} files scanned)`);
    return;
  }
  console.error('✗ css-tokens: var() references with no definition in any stylesheet or inline setter:');
  for (const b of bad) console.error(`  ${b.path}:${b.line}  ${b.token}`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
