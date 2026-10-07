// @vitest-environment node
//
// tests/unit/capital-allocation.pca-capex.test.ts
//
// Phase 4: the `improve` gate's capex denominator is ASSUMED_CAPEX_PSF ($10) PLUS the property's PCA
// near-term repair $/SF where a current PCA exists. Pins the safety property the design rests on:
// a PCA can only make `improve` HARDER to reach, never easier (PCA-informed yield ≤ proxy-only yield),
// and with no PCA the engine is exactly the pre-existing proxy.
//
// Same module-mock scaffolding as capital-allocation.test.ts (scores / debt-scoring / metrics mocked so
// the Spine-B fixture is controlled); the warehouse itself is real so the PCA ledger loads for real.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';

vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn() }));
vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn() }));
import type { WarehouseDb as WarehouseDbForMock } from '../../server/warehouse/db';
vi.mock('../../server/warehouse/debt-scoring', async () => {
  const { readDebtBookTrust } = await import('../../server/warehouse/debt-trust');
  const scoreDebtPositions = vi.fn();
  return {
    scoreDebtPositions,
    scoreDebtPositionsWithTrust: vi.fn((db: unknown, ...rest: unknown[]) => {
      const scores = scoreDebtPositions(db, ...rest);
      return { scores, bookTrust: scores[0]?.bookTrust ?? readDebtBookTrust(db as WarehouseDbForMock) };
    }),
  };
});
import type * as MetricsModule from '../../server/warehouse/metrics';
vi.mock('../../server/warehouse/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof MetricsModule>();
  return { ...actual, propertyPeriodMetrics: vi.fn() };
});

import { getMacro } from '../../server/macro/getMacro';
import { scoreProperties } from '../../server/warehouse/scores';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { capexIrrEstimate } from '../../server/warehouse/capital-allocation';
import { writeRegister } from '../../scripts/import-pca-register';
import type { PropertyScore, PeriodMetrics } from '../../src/contracts/warehouse';
import type { DebtScore } from '../../src/contracts/debt';
import type { PcaReport } from '../../src/contracts/property-condition';

const mockGetMacro = vi.mocked(getMacro);
const mockScoreProperties = vi.mocked(scoreProperties);
const mockScoreDebt = vi.mocked(scoreDebtPositions);
const mockPropertyPeriodMetrics = vi.mocked(propertyPeriodMetrics);

function freshDb(): WarehouseDb {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'cap-alloc-pca-')), 'test.sqlite'));
  for (const id of ['prop-a', 'prop-b', 'prop-invest', 'prop-other']) {
    db.prepare('INSERT OR IGNORE INTO property_master (id, name) VALUES (?, ?)').run(id, id);
  }
  return db;
}

function score(overrides: Partial<PropertyScore> = {}): PropertyScore {
  return {
    propertyId: 'prop-test', propertyName: 'Test Property', period: '2025', health: 70, healthBand: 'good', attentionBand: 'yellow',
    capitalAction: 'hold', subScores: { noi: 70, growth: 60, efficiency: 65 }, noiPerSfQuartile: 2, benchmarkCohortSize: 5,
    reasons: ['Test property'], ...overrides,
  };
}

function debt(overrides: Partial<DebtScore> = {}): DebtScore {
  return {
    propertyId: 'prop-test', propertyName: 'Test Property', noiBasis: 'ledger', dscr: 1.45, dscrHeadroom: 0.2, ltv: 0.3, ltvHeadroom: 0.1,
    debtYield: 0.1, signal: 'hold', signalReason: null, score: 75, scoreBand: 'strong', capitalConfigVersion: 1, refiCashSavingsPct: 0.05,
    bookTrust: 'trusted', ...overrides,
  };
}

function metrics(overrides: Partial<PeriodMetrics> = {}): PeriodMetrics {
  return {
    propertyId: 'prop-test', propertyName: 'Test Property', period: '2025', grainHint: 'year', basis: 'accrual', rentableSf: 20000,
    ownershipPct: 1, revenue: 150000, opex: 75000, noi: 75000, noiMargin: 0.5, expenseRatio: 0.5, capex: 0, ti: 0, leasing: 0,
    categories: {}, revenueCategories: {}, revenuePerSf: 7.5, noiPerSf: 3.75, expensePerSf: 3.75, taxesPerSf: null,
    insurancePerSf: null, repairsPerSf: null, oxfordNoi: 75000, ...overrides,
  };
}

function pcaReport(over: Partial<PcaReport>): PcaReport {
  return {
    reportId: 'R01', propertyKey: 'prop-invest', propertyMasterId: 'prop-invest', propertyLabel: 'Invest', location: null, consultant: 'X',
    client: null, oraCommissioned: true, purpose: null, inspectionDate: null, reportDate: '2026-04-07', sf: 10000, buildings: 1,
    yearBuilt: null, immediateUsd: 0, shortTermUsd: 0, reservesUninflUsd: null, reservesInflUsd: null, termYears: 12, psfYrStated: null,
    usabilityRaw: 'CURRENT', usabilityClass: 'current', sourceFiles: null, notes: null, ...over,
  };
}

function loadPca(db: WarehouseDb, reports: PcaReport[]): void {
  writeRegister(db, { reports, components: [], quotes: [], assets: [], pairs: [], openItems: [], rejects: [] });
}

/** Three same-basis properties, 10,000 SF each: noiPerSf 15 / 10 / 5 → median 10, prop-invest gap = 5 → proxy yield 5/10 = 50%. */
function seedGapScenario(): void {
  mockScoreProperties.mockReturnValue([
    score({ propertyId: 'prop-a', capitalAction: 'hold' }),
    score({ propertyId: 'prop-b', capitalAction: 'hold' }),
    score({ propertyId: 'prop-invest', capitalAction: 'invest', healthBand: 'watch' }),
  ]);
  mockScoreDebt.mockReturnValue([
    debt({ propertyId: 'prop-a' }), debt({ propertyId: 'prop-b' }), debt({ propertyId: 'prop-invest' }),
  ]);
  mockPropertyPeriodMetrics.mockReturnValue([
    metrics({ propertyId: 'prop-a', rentableSf: 10_000, noi: 150_000, noiPerSf: 15 }),
    metrics({ propertyId: 'prop-b', rentableSf: 10_000, noi: 100_000, noiPerSf: 10 }),
    metrics({ propertyId: 'prop-invest', rentableSf: 10_000, noi: 50_000, noiPerSf: 5 }),
  ]);
}

beforeEach(() => {
  mockGetMacro.mockResolvedValue({
    asOf: '2026-06-21', source: 'mock' as const,
    indicators: [{ id: 'DGS5', label: '5Y Treasury', value: 4.18, unit: '%', change: null }],
    tenYearHistory: [],
  } as never);
  mockScoreProperties.mockReturnValue([]);
  mockScoreDebt.mockReturnValue([]);
  mockPropertyPeriodMetrics.mockReturnValue([]);
});

describe('capexIrrEstimate — PCA floor (max) denominator', () => {
  it('no PCA (omitted, null, NaN, ≤ 0) is EXACTLY the pre-existing proxy gap ÷ $10', () => {
    const base = capexIrrEstimate(5, 10);
    expect(base).toBe(0.5);
    for (const pca of [null, Number.NaN, Number.POSITIVE_INFINITY, 0, -3]) {
      expect(capexIrrEstimate(5, 10, pca)).toBe(base);
    }
  });

  it('uses the larger of the assumption and the PCA intensity: gap ÷ max(10, pca)', () => {
    expect(capexIrrEstimate(5, 10, 20)).toBeCloseTo(0.25, 12);
    expect(capexIrrEstimate(5, 10, 10)).toBeCloseTo(0.5, 12);
    expect(capexIrrEstimate(5, 10, 0.04)).toBe(0.5); // below the floor: no effect
  });

  it('SAFETY: a PCA-informed yield is never ABOVE the proxy-only yield (PCA can only demote improve)', () => {
    for (const own of [0, 1, 4.9, 9.99]) {
      for (const median of [10, 12.5, 40]) {
        for (const pca of [0, 0.01, 0.04, 1, 8.7, 52.5, 250]) {
          const withPca = capexIrrEstimate(own, median, pca);
          const without = capexIrrEstimate(own, median);
          expect(withPca === null).toBe(without === null);
          if (withPca !== null && without !== null) expect(withPca).toBeLessThanOrEqual(without);
        }
      }
    }
  });

  it('a tiny PCA total cannot manufacture a yield: $0.04/SF PCA does NOT replace the $10 assumption', () => {
    // A substitution design would give 5 / 0.04 = 125 (12,500%). The $10 floor holds it at the proxy.
    expect(capexIrrEstimate(5, 10, 0.04)).toBe(0.5);
  });

  it('stays null when the own/peer NOI/SF is unknown or the property is not below peers', () => {
    expect(capexIrrEstimate(null, 10, 5)).toBeNull();
    expect(capexIrrEstimate(5, null, 5)).toBeNull();
    expect(capexIrrEstimate(12, 10, 5)).toBeNull();
  });
});

describe('buildPortfolioAllocation — improve gate with a PCA on file', () => {
  it('no PCA: unchanged proxy — improve fires at 50.0% and the flag text is the pre-PCA wording', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedGapScenario();
    const v = (await buildPortfolioAllocation(db, '2026-10-07')).verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    const reasons = v.reasons.join(' | ');
    expect(reasons).toContain('capexIrr proxy 50.0% clears hurdle');
    expect(reasons).not.toContain('PCA');
    const flag = v.dataQuality.find((f) => f.field === 'capexIrr')!;
    expect(flag.issue.startsWith('capexIrr is a proxy assuming a $10/SF capex spend instantly and permanently closes')).toBe(true);
    expect(flag.issue).not.toContain('PCA');
  });

  it('a PCA above the assumption ($20/SF near-term) lowers the yield to 25.0% but improve still fires, and the spend is disclosed', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedGapScenario();
    loadPca(db, [pcaReport({ reportId: 'R-INV', immediateUsd: 80000, shortTermUsd: 120000, sf: 10000 })]); // $200k / 10k SF = $20/SF
    const v = (await buildPortfolioAllocation(db, '2026-10-07')).verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    expect(v.reasons.join(' | ')).toContain('capexIrr proxy 25.0% clears hurdle (spend set by PCA near-term $20.00/SF, above the $10/SF assumption)');
    const flag = v.dataQuality.find((f) => f.field === 'capexIrr')!;
    expect(flag.issue).toContain('max($10/SF value-add assumption, $20.00/SF of near-term PCA repairs)');
    expect(flag.issue).toContain('R-INV');
    expect(flag.issue).toContain('oldest report 2026-04-07');
    expect(flag.issue).toContain('covers 10,000 SF');
  });

  it('a heavy PCA ($70/SF) DEMOTES improve to hold: yield 5/70 = 7.1% < 8% hurdle', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedGapScenario();
    loadPca(db, [pcaReport({ reportId: 'R-HEAVY', immediateUsd: 300000, shortTermUsd: 400000, sf: 10000 })]); // $70/SF
    const v = (await buildPortfolioAllocation(db, '2026-10-07')).verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('hold');
    expect(v.reasons.join(' | ')).toContain('improve deferred: capexIrr proxy 7.1% does not clear hurdle (spend set by PCA near-term $70.00/SF, above the $10/SF assumption)');
  });

  it('a PCA below the assumption ($5/SF) changes nothing but is still disclosed', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedGapScenario();
    loadPca(db, [pcaReport({ reportId: 'R-LOW', immediateUsd: 50000, shortTermUsd: null, sf: 10000 })]); // $5/SF
    const v = (await buildPortfolioAllocation(db, '2026-10-07')).verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    expect(v.reasons.join(' | ')).toContain('capexIrr proxy 50.0% clears hurdle (PCA near-term $5.00/SF is below the $10/SF assumption; assumption holds)');
  });

  it('a PCA with no SF is not applied — the verdict matches the no-PCA case and the flag discloses the exclusion', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedGapScenario();
    loadPca(db, [pcaReport({ sf: null, immediateUsd: 999999 })]);
    const v = (await buildPortfolioAllocation(db, '2026-10-07')).verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    expect(v.reasons.join(' | ')).toContain('capexIrr proxy 50.0% clears hurdle');
    expect(v.reasons.join(' | ')).not.toContain('PCA');
    // ...but the flag no longer pretends there is no PCA: it names the report and why it was not applied.
    const flag = v.dataQuality.find((f) => f.field === 'capexIrr')!.issue;
    expect(flag).toContain('PCA on file but not applied');
    expect(flag).toContain('$999,999');
    expect(flag).toContain('report has no SF');
  });

  it("another property's PCA does not bleed into this property's gate", async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedGapScenario();
    loadPca(db, [pcaReport({ propertyKey: 'prop-other', propertyMasterId: 'prop-other', immediateUsd: 9_000_000 })]);
    const v = (await buildPortfolioAllocation(db, '2026-10-07')).verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    expect(v.reasons.join(' | ')).toContain('capexIrr proxy 50.0% clears hurdle');
  });

  it('a draft report is still USED (current = newest report, no cutoff) and the disclosure says draft/limited-reliance', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedGapScenario();
    loadPca(db, [pcaReport({ usabilityClass: 'draft', immediateUsd: 200000, shortTermUsd: 0, sf: 10000, reportDate: '2014-10-23' })]);
    const v = (await buildPortfolioAllocation(db, '2026-10-07')).verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.reasons.join(' | ')).toContain('capexIrr proxy 25.0% clears hurdle');
    const flag = v.dataQuality.find((f) => f.field === 'capexIrr')!;
    expect(flag.issue).toContain('draft/limited-reliance report');
    expect(flag.issue).toContain('oldest report 2014-10-23');
  });

  it('a warehouse without the PCA ledger runs on the proxy exactly as before', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    db.exec('DROP TABLE pca_open_items; DROP TABLE capex_calibration_pairs; DROP TABLE asset_facts; DROP TABLE capex_quotes; DROP TABLE pca_components; DROP TABLE pca_reports;');
    seedGapScenario();
    const v = (await buildPortfolioAllocation(db, '2026-10-07')).verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    expect(v.reasons.join(' | ')).toContain('capexIrr proxy 50.0% clears hurdle');
  });
});
