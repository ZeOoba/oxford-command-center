// tests/unit/lease-market-contract.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CanonicalListingRow, LeaseMarketConfig, RadarDecisionInput, SIZE_BANDS } from '../../src/contracts/lease-market';

const shipped = JSON.parse(readFileSync(join(process.cwd(), 'config', 'lease-market.json'), 'utf8')) as unknown;
const baseRow = {
  costarPropertyId: null, address: '1 Main St', suite: null, city: null, state: null, zip: null, lat: null, lon: null,
  submarket: null, subtype: 'warehouse', buildingStatus: 'existing', buildingSf: null, yearBuilt: null, clearHeightFt: null,
  docks: null, driveIns: null, officePct: null, ownerName: null, availableSf: 1200, minDivisibleSf: null, rentLow: null,
  rentHigh: null, rentPeriod: null, rentIsTotal: false, rentBasis: 'WITHHELD', opexQuotedPsf: null, isSublease: false,
  costarDateOnMarket: null, brokerName: null, brokerCompany: null, listingUrl: null, description: null, sourceRow: 2,
};

describe('lease-market contracts', () => {
  it('the shipped config parses with spec rev 3 thresholds and only attributed opex', () => {
    const cfg = LeaseMarketConfig.parse(shipped);
    expect(cfg.markets.map((m) => m.id)).toContain('columbus');
    expect(cfg.thresholds).toMatchObject({ belowMarketMedianRatio: 0.85, benchmarkMinN: 5, similarityMinScore: 60, similarityTopK: 15, similarityMinComps: 8, similarityHighComps: 15, radarMinScore: 50, rentMinPsfYr: 1, rentMaxPsfYr: 60 });
    expect(Object.values(cfg.similarityWeights).reduce((a, b) => a + b, 0)).toBe(100);
    // Opex defaults are what convert an MG/gross quote to an NNN-equivalent, so a wrong one moves
    // every converted comp. The invariant is NOT "there are none" — Columbus now carries a set
    // Gabriel ratified — it is that a set may never be anonymous: each one must name where it came
    // from and as of when, and a market with no ratified figure stays null rather than inheriting a
    // neighbour's. A future market that fills these must state its own source.
    for (const m of cfg.markets) {
      for (const sub of ['warehouse', 'flex'] as const) {
        const d = m.opexDefaults[sub];
        if (d === null) continue;
        expect(d.source.trim().length, `${m.id}/${sub} opex default must name its source`).toBeGreaterThan(0);
        expect(d.asOf, `${m.id}/${sub} opex default must carry an asOf date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    expect(cfg.markets.filter((m) => m.opexDefaults.flex !== null).map((m) => m.id)).toEqual(['columbus']);
  });

  it('rejects weights that do not sum to 100, unknown ORA markets, and duplicate markets', () => {
    const cfg = LeaseMarketConfig.parse(shipped);
    expect(LeaseMarketConfig.safeParse({ ...cfg, similarityWeights: { ...cfg.similarityWeights, location: 31 } }).success).toBe(false);
    const ora = { propertyKey: 'X', marketId: 'nowhere', submarket: null, subtype: 'warehouse', officePct: null, typicalUnitSf: 5000, leaseBasis: 'NNN', addressNorms: ['1 MAIN ST'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null };
    expect(LeaseMarketConfig.safeParse({ ...cfg, oraProperties: [ora] }).success).toBe(false);
    expect(LeaseMarketConfig.safeParse({ ...cfg, markets: [cfg.markets[0], cfg.markets[0]] }).success).toBe(false);
  });

  it('rejects duplicate oraProperties propertyKeys (a config error the positioning market filter would otherwise silently hide)', () => {
    const cfg = LeaseMarketConfig.parse(shipped);
    const marketId = cfg.markets[0]!.id;
    const ora = { propertyKey: 'X', marketId, submarket: null, subtype: 'warehouse', officePct: null, typicalUnitSf: 5000, leaseBasis: 'NNN', addressNorms: ['1 MAIN ST'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null };
    expect(LeaseMarketConfig.safeParse({ ...cfg, oraProperties: [ora] }).success).toBe(true);
    expect(LeaseMarketConfig.safeParse({ ...cfg, oraProperties: [ora, { ...ora, submarket: 'other' }] }).success).toBe(false);
  });

  it('rejects inverted threshold orderings: radarMinScore <= radarPushScore, similarityMinComps <= similarityHighComps, candidateMaxBuildingSf <= benchmarkMaxBuildingSf, similarityTopK >= similarityHighComps', () => {
    const cfg = LeaseMarketConfig.parse(shipped);
    expect(LeaseMarketConfig.safeParse({ ...cfg, thresholds: { ...cfg.thresholds, radarMinScore: cfg.thresholds.radarPushScore + 1 } }).success).toBe(false);
    expect(LeaseMarketConfig.safeParse({ ...cfg, thresholds: { ...cfg.thresholds, radarMinScore: cfg.thresholds.radarPushScore } }).success).toBe(true);
    expect(LeaseMarketConfig.safeParse({ ...cfg, thresholds: { ...cfg.thresholds, similarityMinComps: cfg.thresholds.similarityHighComps + 1 } }).success).toBe(false);
    expect(LeaseMarketConfig.safeParse({ ...cfg, thresholds: { ...cfg.thresholds, candidateMaxBuildingSf: cfg.thresholds.benchmarkMaxBuildingSf + 1 } }).success).toBe(false);
    expect(LeaseMarketConfig.safeParse({ ...cfg, thresholds: { ...cfg.thresholds, similarityTopK: cfg.thresholds.similarityHighComps - 1 } }).success).toBe(false);
    expect(LeaseMarketConfig.safeParse({ ...cfg, thresholds: { ...cfg.thresholds, similarityTopK: cfg.thresholds.similarityHighComps } }).success).toBe(true);
  });

  it('size bands are ordered', () => {
    expect(SIZE_BANDS).toEqual(['<5K', '5-15K', '15-30K', '30-50K', '50-80K']);
  });

  it('canonical row validates SF and coordinates', () => {
    expect(CanonicalListingRow.safeParse(baseRow).success).toBe(true);
    expect(CanonicalListingRow.safeParse({ ...baseRow, availableSf: 0 }).success).toBe(false);
    expect(CanonicalListingRow.safeParse({ ...baseRow, lat: 91 }).success).toBe(false);
  });

  it('radar decision input is bounded', () => {
    expect(RadarDecisionInput.safeParse({ propertyId: 3, decision: 'investigate', note: null }).success).toBe(true);
    expect(RadarDecisionInput.safeParse({ propertyId: 3, decision: 'buy', note: null }).success).toBe(false);
    expect(RadarDecisionInput.safeParse({ propertyId: 3, decision: 'pass', note: 'x'.repeat(501) }).success).toBe(false);
  });
});
