// @vitest-environment node
//
// Every script that opens the warehouse writable must refuse to run on synthetic stand-in data
// outside CI / tests, or it would write synthetic records next to real ones (refute round 4 F8:
// import-insurance-data inserted synthetic premium rows into the live warehouse). Static check over
// scripts/*.ts AND server/**/*.ts (refute round 5 F6), on CODE only (comments stripped): the guard
// must be called, and before the first writable open. The exceptions are listed with the reason
// they are safe. Read-only opens (openWarehouseReadOnly) are not writers and are not matched.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Strip block and line comments. A block comment must start at a line start or after whitespace, so
 *  a route string such as '/api/*' is not mistaken for one; a line comment must not follow a quote or
 *  a colon (URLs). Naive, but enough for these files. */
const code = (src: string): string =>
  src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** A writable open CALL (not the function's own definition). */
const OPEN = /(?<!function\s)\bopenWarehouse(NoMigrate)?\(/;
const GUARD = /\brefuseIfSynthetic\(/;

function tsFiles(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (recursive) out.push(...tsFiles(p, true));
    } else if (n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts')) out.push(relative(ROOT, p).replace(/\\/g, '/'));
  }
  return out;
}

/** Writable warehouse opens that never write synthetic-seedable inputs into it, with the reason. */
const ALLOWED: Record<string, string> = {
  'scripts/acq-sync.ts': 'input is the HubSpot / Notion APIs, never a manifest path',
  'scripts/lease-market.ts': 'input is the licensed CoStar exports under data/lease-market/ (neverTrack, never seeded)',
  'scripts/warehouse-verify.ts': 'migrates only a scratch copy in the temp dir; the live warehouse is opened read-only',
  'scripts/warehouse-live-drift-check.ts': 'read-only drift check (scratch copy in the temp dir)',
  'server/index.ts':
    'the Brain Server: its warehouse writes (occupancy / month / insurance / debt captures) come from the snapshot parsed from the ' +
    'live workbook, never from a seeded manifest file; on a synthetic checkout every served snapshot carries error-severity ' +
    'synthetic-data flags (server/brain.ts: refresh, cold fallback, write-back) and the boot banner warns. Refusing here would ' +
    'take the whole UI down on a synthetic dev checkout, so the boundary is a loud flag, not a refusal.',
};

describe('warehouse writers refuse synthetic stand-ins (scripts/ and server/)', () => {
  const files = [...tsFiles(join(ROOT, 'scripts'), false), ...tsFiles(join(ROOT, 'server'), true)];
  const src = new Map(files.map((f) => [f, code(readFileSync(join(ROOT, f), 'utf8'))]));
  const opensWarehouse = files.filter((f) => OPEN.test(src.get(f)!));

  it('finds the writable warehouse opens in scripts/ and server/ (not vacuous)', () => {
    expect(opensWarehouse.filter((f) => f.startsWith('scripts/')).length).toBeGreaterThan(8);
    expect(opensWarehouse).toContain('server/index.ts');
  });

  it('every writable warehouse open is preceded by refuseIfSynthetic, unless allowed for a stated reason', () => {
    const bad = opensWarehouse.filter((f) => {
      if (f in ALLOWED) return false;
      const s = src.get(f)!;
      const g = s.search(GUARD);
      return g < 0 || g > s.search(OPEN);
    });
    expect(bad).toEqual([]);
  });

  it('the allowlist names only files that exist and really open the warehouse writable (code, not comments)', () => {
    for (const f of Object.keys(ALLOWED)) expect(opensWarehouse, f).toContain(f);
  });

  it('a commented-out guard does not count, and the definition of openWarehouse is not a call', () => {
    expect(GUARD.test(code("// refuseIfSynthetic('x');\nopenWarehouse(p);"))).toBe(false);
    expect(GUARD.test(code("/* refuseIfSynthetic('x'); */ openWarehouse(p);"))).toBe(false);
    expect(OPEN.test('export function openWarehouse(path: string): WarehouseDb {')).toBe(false);
  });
});
