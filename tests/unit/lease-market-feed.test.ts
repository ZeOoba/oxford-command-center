// tests/unit/lease-market-feed.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { loadMarketRentFeed } from '../../server/warehouse/lease-market/feed';
import { marketRentGaps } from '../../src/analytics/lease-forecast';
import type { Lease } from '../../src/contracts/lease';

function lease(patch: Partial<Lease> = {}): Lease {
  return {
    id: 'L1', propertyKey: '1100 Rarig', propertyId: null, tenantName: 'Acme', unit: 'B', company: null, sf: 8000,
    monthlyRent: 5000, rentPerSf: 7.5, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null,
    status: 'Active', annualRent: 60000, monthsToExpiry: 12, flags: [], ...patch,
  };
}

describe('marketRentGaps with a feed', () => {
  it('uses the feed when no manual value exists, tagged derived-asking', () => {
    const [g] = marketRentGaps([lease()], {}, { '1100 Rarig': 9.3 });
    expect(g).toMatchObject({ marketRentPsf: 9.3, provenance: 'derived-asking', underMarket: true });
    expect(g!.gapPsf).toBeCloseTo(1.8);
  });
  it('a manual property value beats the feed', () => {
    expect(marketRentGaps([lease()], { '1100 Rarig': 11 }, { '1100 Rarig': 9.3 })[0]).toMatchObject({ marketRentPsf: 11, provenance: 'derived' });
  });
  it('a manual lease value beats the feed', () => {
    expect(marketRentGaps([lease()], { L1: 8 }, { '1100 Rarig': 9.3 })[0]).toMatchObject({ marketRentPsf: 8, provenance: 'derived' });
  });
  it('stays absent with neither', () => {
    expect(marketRentGaps([lease()], {}, {})[0]!.provenance).toBe('absent');
    expect(marketRentGaps([lease()], {})[0]!.provenance).toBe('absent');
  });
});

describe('feed loading', () => {
  let db: WarehouseDb | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('loads the feed table, keyed by ORA property key', () => {
    db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'lm-feed-')), 't.sqlite'));
    db.prepare(
      `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, comp_basis, confidence, cell_key, n, computed_at) VALUES ('1100 Rarig', 9.3, 'similarity', 'MEDIUM', 'k', 12, '2026-03-01')`,
    ).run();
    expect(loadMarketRentFeed(db)).toEqual({ '1100 Rarig': 9.3 });
  });

  it('excludes LOW-confidence rows (defense in depth; compute never persists them, but the read guards anyway)', () => {
    db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'lm-feed-')), 't.sqlite'));
    db.prepare(
      `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, comp_basis, confidence, cell_key, n, computed_at) VALUES ('1100 Rarig', 9.3, 'similarity', 'MEDIUM', 'k', 12, '2026-03-01')`,
    ).run();
    db.prepare(
      `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, comp_basis, confidence, cell_key, n, computed_at) VALUES ('Low Confidence Property', 20, 'cell', 'LOW', 'k2', 3, '2026-03-01')`,
    ).run();
    const feed = loadMarketRentFeed(db);
    expect(feed).toEqual({ '1100 Rarig': 9.3 });
    expect(feed).not.toHaveProperty('Low Confidence Property');
  });
});
