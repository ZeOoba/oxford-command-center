// @vitest-environment node
// Tier 4 (2026-11-23 review): two migrations share number 017. Ordering is then deterministic only by
// filename, and a third collision could apply out of the intended order. The existing pair is
// grandfathered (already applied on live warehouses; renaming an applied migration is its own risk);
// any NEW duplicate prefix fails here.
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const GRANDFATHERED = new Set(['017']);

describe('warehouse migration numbering', () => {
  it('every migration has a numeric prefix, and no new prefix is shared', () => {
    const files = readdirSync(join('server', 'warehouse', 'migrations')).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const byPrefix = new Map<string, string[]>();
    for (const f of files) {
      const m = /^(\d{3})_/.exec(f);
      expect(m, `${f} has no NNN_ prefix`).not.toBeNull();
      byPrefix.set(m![1]!, [...(byPrefix.get(m![1]!) ?? []), f]);
    }
    const dupes = [...byPrefix].filter(([p, fs]) => fs.length > 1 && !GRANDFATHERED.has(p));
    expect(dupes).toEqual([]);
  });
});
