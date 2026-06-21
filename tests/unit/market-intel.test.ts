// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';

vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn() }));
import { getMacro } from '../../server/macro/getMacro';
const mockGetMacro = vi.mocked(getMacro);

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'market-intel-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function seedMarketSeries(
  db: WarehouseDb,
  rows: Array<{ cluster: string; as_of: string; source: string; metric: string; value: number | null; confidence: number }>,
) {
  const stmt = db.prepare(
    'INSERT INTO market_series (cluster, as_of, source, metric, value, confidence) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) stmt.run(r.cluster, r.as_of, r.source, r.metric, r.value, r.confidence);
}

// Reusable macro helpers (shape matches actual MacroSnapshot from src/contracts/macro.ts)
function makeMacro(dgs5: number | null, cpi: number | null) {
  return {
    asOf: '2026-06-21',
    source: 'mock' as const,
    indicators: [
      { id: 'DGS10', label: '10Y Treasury', value: 4.47, unit: '%', change: null },
      { id: 'DGS5', label: '5Y Treasury', value: dgs5, unit: '%', change: null },
      { id: 'DGS2', label: '2Y Treasury', value: 4.05, unit: '%', change: null },
      { id: 'SOFR', label: 'SOFR', value: 3.63, unit: '%', change: null },
      { id: 'FEDFUNDS', label: 'Fed Funds (effective)', value: 3.63, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI (YoY)', value: cpi, unit: '%', change: null },
    ],
    tenYearHistory: [],
  };
}

const MACRO_NEUTRAL = makeMacro(4.18, 3.8);   // fredScore = 66.25
const MACRO_BEARISH = makeMacro(8.0, 7.0);    // fredScore = 15
const MACRO_BULLISH = makeMacro(3.0, 2.5);    // fredScore = 82.5
const MACRO_EMPTY   = makeMacro(null, null);   // fredScore = null

beforeEach(() => {
  mockGetMacro.mockResolvedValue(MACRO_NEUTRAL as never);
});

describe('buildMarketIntel', () => {
  it('M-1: FRED-only (no market_series rows) — confidence01 === 0.5, action valid, not null score', async () => {
    const { buildMarketIntel } = await import('../../server/warehouse/market-intel');
    const db = freshDb();
    // cluster 'fred-only-test' has no property_master rows and no market_series rows
    const sig = await buildMarketIntel(db, 'fred-only-test', '2026-06-21');
    expect(sig.cluster).toBe('fred-only-test');
    expect(sig.advisoryOnly).toBe(true);
    expect(sig.confidence01).toBeCloseTo(0.5, 5);
    expect(['enter', 'expand', 'maintain', 'exit']).toContain(sig.action);
    expect(sig.marketScore).not.toBeNull();
    expect(sig.sources.find(s => s.source === 'fred')?.stale).toBe(false);
  });

  it('M-2: all three sources fresh — confidence01 === 1.0', async () => {
    const { buildMarketIntel } = await import('../../server/warehouse/market-intel');
    const db = freshDb();
    seedMarketSeries(db, [
      { cluster: 'all-three', as_of: '2026-06-01', source: 'census-acs', metric: 'vacancy_rate', value: 4.2, confidence: 1.0 },
      { cluster: 'all-three', as_of: '2026-06-01', source: 'comps-ai',   metric: 'cap_rate',     value: 6.8, confidence: 1.0 },
    ]);
    const sig = await buildMarketIntel(db, 'all-three', '2026-06-21');
    expect(sig.confidence01).toBeCloseTo(1.0, 5);
    expect(sig.sources).toHaveLength(3);
  });

  it('M-3: bearish FRED + bad comps + high vacancy — action === "exit"', async () => {
    const { buildMarketIntel } = await import('../../server/warehouse/market-intel');
    mockGetMacro.mockResolvedValue(MACRO_BEARISH as never);
    const db = freshDb();
    seedMarketSeries(db, [
      { cluster: 'bad-market', as_of: '2026-06-01', source: 'census-acs', metric: 'vacancy_rate', value: 18.0, confidence: 1.0 },
      { cluster: 'bad-market', as_of: '2026-06-01', source: 'comps-ai',   metric: 'cap_rate',     value: 10.5, confidence: 1.0 },
    ]);
    const sig = await buildMarketIntel(db, 'bad-market', '2026-06-21');
    // fredScore=15, censusScore=0, compsScore=20 → composite < 45 → exit
    expect(sig.action).toBe('exit');
    expect(sig.advisoryOnly).toBe(true);
    expect(sig.marketScore).not.toBeNull();
    expect(sig.marketScore!).toBeLessThan(45);
  });

  it('M-4: bullish FRED + low vacancy + good comps + oraCount=0 — action === "enter"', async () => {
    const { buildMarketIntel } = await import('../../server/warehouse/market-intel');
    mockGetMacro.mockResolvedValue(MACRO_BULLISH as never);
    const db = freshDb();
    // 'new-market' cluster has no property_master rows (freshDb has no seeded properties)
    seedMarketSeries(db, [
      { cluster: 'new-market', as_of: '2026-06-01', source: 'census-acs', metric: 'vacancy_rate', value: 2.0,  confidence: 1.0 },
      { cluster: 'new-market', as_of: '2026-06-01', source: 'comps-ai',   metric: 'cap_rate',     value: 5.5,  confidence: 1.0 },
    ]);
    const sig = await buildMarketIntel(db, 'new-market', '2026-06-21');
    // fredScore=82.5, census=84, comps=67.5 → composite ≈ 79.95 ≥ 75 AND oraCount=0
    expect(sig.oraPropertyCount).toBe(0);
    expect(sig.marketScore).not.toBeNull();
    expect(sig.marketScore!).toBeGreaterThanOrEqual(75);
    expect(sig.action).toBe('enter');
  });

  it('M-5: stale comps (>90d) marked stale — confidence01 ≤ 0.5', async () => {
    const { buildMarketIntel } = await import('../../server/warehouse/market-intel');
    const db = freshDb();
    // as_of='2026-02-01' vs asOf='2026-06-21' = 140 days > 90
    seedMarketSeries(db, [
      { cluster: 'stale-test', as_of: '2026-02-01', source: 'comps-ai', metric: 'cap_rate', value: 5.5, confidence: 1.0 },
    ]);
    const sig = await buildMarketIntel(db, 'stale-test', '2026-06-21');
    const comps = sig.sources.find(s => s.source === 'comps-ai');
    expect(comps).toBeDefined();
    expect(comps!.stale).toBe(true);
    // FRED (0.5) only active — comps stale, census missing
    expect(sig.confidence01).toBeCloseTo(0.5, 5);
  });

  it('M-6: no FRED indicators + no market_series — marketScore null, confidence01 0, action maintain', async () => {
    const { buildMarketIntel } = await import('../../server/warehouse/market-intel');
    mockGetMacro.mockResolvedValue(MACRO_EMPTY as never);
    const db = freshDb();
    const sig = await buildMarketIntel(db, 'empty-cluster', '2026-06-21');
    expect(sig.marketScore).toBeNull();
    expect(sig.confidence01).toBe(0);
    expect(sig.action).toBe('maintain');
    expect(sig.advisoryOnly).toBe(true);
    expect(sig.reasons.some(r => r.includes('Insufficient'))).toBe(true);
  });
});
