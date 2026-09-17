// tests/unit/lease-market-positioning.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { loadMarketState } from '../../server/warehouse/lease-market/compute';
import { computePositioning, recommendationFor } from '../../server/warehouse/lease-market/positioning';
import type { ResolvedComparables } from '../../src/analytics/lease-market/similarity';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

const stats = (patch: Partial<ResolvedComparables> = {}): ResolvedComparables => ({
  basis: 'similarity', n: 12, low: 7, p25: 9, median: 10, p75: 11, high: 12, values: [8, 9, 10, 11, 12], confidence: 'MEDIUM', cellKey: null, comps: [], ...patch,
});

describe('recommendationFor', () => {
  it('covers every branch', () => {
    expect(recommendationFor({ asking: 10, stats: null, bandPct: 0.1 })).toBe('No comparable asking rents yet for this size and type.');
    expect(recommendationFor({ asking: null, stats: stats(), bandPct: 0.1 })).toBe('No ORA asking rent found in CoStar — confirm the unit is being marketed. Comparable range $9.00–$11.00.');
    expect(recommendationFor({ asking: 11.5, stats: stats(), bandPct: 0.1 })).toBe('Asking is 15% above the comparable median ($10.00); comparable range $9.00–$11.00.');
    expect(recommendationFor({ asking: 8.5, stats: stats(), bandPct: 0.1 })).toBe('Asking is 15% below the comparable median ($10.00); room to move toward $9.00–$10.00.');
    expect(recommendationFor({ asking: 10.5, stats: stats(), bandPct: 0.1 })).toBe('Within the comparable range ($9.00–$11.00).');
    expect(recommendationFor({ asking: 10.5, stats: stats({ confidence: 'LOW', n: 3 }), bandPct: 0.1 })).toBe('Thin comparable set (n=3) — indicative only. Within the comparable range ($9.00–$11.00).');
  });
});

async function state(extraOra: FixtureListing[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-pos-'));
  const db = openWarehouse(join(dir, 't.sqlite'));
  const config = testConfig();
  const comps: FixtureListing[] = [8, 8.5, 9, 9.25, 9.5, 9.75, 10, 10.25, 10.5, 11].map((rent, i) => ({ id: `C${i}`, address: `${200 + i} Commerce Dr`, sf: 8000, rentLow: rent }));
  const ora: FixtureListing[] = [{ address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC', broker: 'Lee Lister', url: 'https://example.test/rarig-b' }, ...extraOra];
  await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', [...comps, ...ora]), {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
  });
  return { config, s: loadMarketState(db, config, '2026-03-01') };
}

describe('computePositioning', () => {
  it('positions a matched ORA suite against similarity comps with evidence', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'Suite B', sf: 8000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row).toMatchObject({ propertyKey: '1100 Rarig', unit: 'Suite B', oraAskingNnnEq: 11.5, band: 'above', flags: [], brokerName: 'Lee Lister', listingUrl: 'https://example.test/rarig-b', dateListed: '2026-01-15', effectiveDom: 45 });
    expect(row.stats).toMatchObject({ basis: 'similarity', n: 10, confidence: 'MEDIUM', low: 8, high: 11 });
    expect(row.stats!.median).toBeCloseTo(9.625);
    expect(row.gapPct).toBeCloseTo(11.5 / 9.625 - 1);
    expect(row.percentile).toBe(1);
    expect(row.comps).toHaveLength(10);
    expect(row.comps[0]!.address).toMatch(/Commerce Dr/);
    expect(row.recommendation).toMatch(/^Asking is 19% above the comparable median \(\$9\.63\)/);
    expect(r.listedButLeased).toEqual([]);
  });

  it('flags a vacant unit that is not listed, and a listed suite that is not vacant', async () => {
    const { config, s } = await state([{ address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' }]);
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'D', sf: 5000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ unit: 'D', oraAskingNnnEq: null, flags: ['not_listed'], band: 'unknown', effectiveDom: null });
    expect(r.rows[0]!.recommendation).toMatch(/^No ORA asking rent found in CoStar/);
    expect(r.listedButLeased.map((l) => l.suite).sort()).toEqual(['B', 'C']);
  });

  it('strips row-level identifiers and lists unconfigured properties', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }, { propertyKey: 'Sepich', unit: '1', sf: 2000 }, { propertyKey: 'Sepich', unit: '2', sf: 2000 }], config, s, false);
    expect(r.unconfiguredPropertyKeys).toEqual(['Sepich']);
    expect(r.rows[0]).toMatchObject({ brokerName: null, listingUrl: null });
    expect(r.rows[0]!.comps.every((c) => c.address === null)).toBe(true);
  });
});
