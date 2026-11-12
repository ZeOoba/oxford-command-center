// @vitest-environment node
//
// Every script that opens the warehouse writable (or writes a real-data manifest path) must refuse to
// run on synthetic stand-in data outside CI / tests, or it would write synthetic records next to real
// ones (refute round 4 F8: import-insurance-data inserted synthetic premium rows into the live
// warehouse). Static check over scripts/*.ts, on CODE only (comments stripped): the guard must be
// called, and before the first warehouse open. The exceptions are listed with the reason they are safe.
// Read-only opens (openWarehouseReadOnly) are not writers and are not matched.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(process.cwd(), 'scripts');

/** Strip block and line comments (a naive pass is enough for these scripts: no `//` inside strings
 *  precedes a warehouse call or the guard). */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const OPEN = /\bopenWarehouse(NoMigrate)?\(/;
const GUARD = /\brefuseIfSynthetic\(/;

/** Scripts that open the warehouse writable but never write synthetic-seedable inputs into it. */
const ALLOWED: Record<string, string> = {
  'acq-sync.ts': 'input is the HubSpot / Notion APIs, never a manifest path',
  'lease-market.ts': 'input is the licensed CoStar exports under data/lease-market/ (neverTrack, never seeded)',
  'warehouse-verify.ts': 'migrates only a scratch copy in the temp dir; the live warehouse is opened read-only',
  'warehouse-live-drift-check.ts': 'read-only drift check (scratch copy in the temp dir)',
};

describe('warehouse writers refuse synthetic stand-ins', () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
  const src = new Map(files.map((f) => [f, code(readFileSync(join(SCRIPTS, f), 'utf8'))]));
  const opensWarehouse = files.filter((f) => OPEN.test(src.get(f)!));

  it('finds the warehouse-opening scripts (not vacuous)', () => {
    expect(opensWarehouse.length).toBeGreaterThan(8);
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

  it('the allowlist names only scripts that exist and really open the warehouse (code, not comments)', () => {
    for (const f of Object.keys(ALLOWED)) expect(opensWarehouse, f).toContain(f);
  });

  it('a commented-out guard does not count', () => {
    expect(GUARD.test(code("// refuseIfSynthetic('x');\nopenWarehouse(p);"))).toBe(false);
    expect(GUARD.test(code("/* refuseIfSynthetic('x'); */ openWarehouse(p);"))).toBe(false);
  });
});
