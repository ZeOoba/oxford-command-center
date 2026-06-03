import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Bundle-budget gate (Phase 6, §0). Run after `vite build`. Asserts:
 *   • the entry/main chunk is < 250 kB gzip
 *   • each lazy route (module) chunk is < 60 kB gzip
 * Vendor chunks are reported but not failed (they cache independently). Fails CI on breach —
 * "performance is a feature": silent bundle bloat is caught here, not in production.
 */
const MAIN_BUDGET = 250 * 1024;
const ROUTE_BUDGET = 60 * 1024;
const ASSETS = join(process.cwd(), 'dist', 'assets');

function gz(path: string): number {
  return gzipSync(readFileSync(path)).length;
}
const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;

function main() {
  let files: string[];
  try {
    files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  } catch {
    console.error('✗ dist/assets not found — run `npm run build` first.');
    process.exit(1);
  }

  const rows = files
    .map((f) => ({ f, gzip: gz(join(ASSETS, f)), raw: statSync(join(ASSETS, f)).size }))
    .sort((a, b) => b.gzip - a.gzip);

  // The entry chunk is the largest `index-*.js`.
  const entry = rows.filter((r) => /^index-/.test(r.f)).sort((a, b) => b.gzip - a.gzip)[0];
  const isVendor = (f: string) => /^vendor-/.test(f) || /^workbox-/.test(f) || /^sw\.js$/.test(f);
  const isRoute = (f: string) => /Module-/.test(f);

  let failed = 0;
  console.log('── BUNDLE BUDGET (gzip) ───────────────────────────────');
  for (const r of rows) {
    const budget = entry && r.f === entry.f ? MAIN_BUDGET : isRoute(r.f) ? ROUTE_BUDGET : null;
    const over = budget !== null && r.gzip > budget;
    if (over) failed++;
    const tag = entry && r.f === entry.f ? 'ENTRY' : isVendor(r.f) ? 'vendor' : isRoute(r.f) ? 'route' : 'chunk';
    const limit = budget !== null ? ` / ${kb(budget)}` : '';
    console.log(`${over ? '✗ OVER' : '  ok  '} [${tag.padEnd(6)}] ${r.f.padEnd(42)} ${kb(r.gzip).padStart(10)}${limit}`);
  }
  console.log('───────────────────────────────────────────────────────');
  if (!entry) {
    console.error('✗ No entry chunk (index-*.js) found.');
    process.exit(1);
  }
  if (failed > 0) {
    console.error(`✗ Bundle budget FAILED: ${failed} chunk(s) over budget.`);
    process.exit(1);
  }
  console.log(`✓ Bundle within budget — entry ${kb(entry.gzip)} < ${kb(MAIN_BUDGET)}; routes < ${kb(ROUTE_BUDGET)}.`);
}

main();
