// tests/unit/contracts-tax-strategy.test.ts
//
// TDD boundary tests for src/contracts/tax-strategy.ts (P4c C2 placeholder buildout —
// cost-seg opportunities, entity strategies, filed-returns metadata).
//
// Load-bearing invariants proven here (schema-enforced, not convention):
//   • savingsFullAsset / savingsOxfordShare are HARD-NULL in v1 (z.null()) — a non-null
//     value is REJECTED by the schema itself (no marginal-rate assumption may be invented).
//   • advisoryOnly is the literal `true` — a `false` payload is rejected.
import { describe, expect, it } from 'vitest';
import {
  StrategyDataSource,
  CostSegOpportunity,
  EntityStrategyItem,
  FiledReturnMeta,
  TaxStrategyReport,
} from '@contracts/tax-strategy';

// ── StrategyDataSource ─────────────────────────────────────────────────────────

describe('StrategyDataSource', () => {
  for (const src of ['warehouse', 'placeholder', 'absent']) {
    it(`accepts '${src}'`, () => {
      expect(StrategyDataSource.parse(src)).toBe(src);
    });
  }

  it('rejects an unknown source', () => {
    expect(() => StrategyDataSource.parse('fixture')).toThrow();
  });
});

// ── CostSegOpportunity ─────────────────────────────────────────────────────────

describe('CostSegOpportunity', () => {
  const valid = {
    propertyId: 'prop-westbelt-a',
    propertyName: 'Westbelt A',
    depreciableBasis: 4_000_000,
    landAllocationPct: 0.2,
    reclassifiablePct: 0.25,
    reclassifiableBasis: 1_000_000, // depreciableBasis × reclassifiablePct
    bonusYearPct: 0.6,
    firstYearAccelerationUsd: 600_000, // reclassifiableBasis × bonusYearPct — deduction timing
    firstYearAccelerationOxfordShare: 375_000, // × real ownershipPct
    savingsFullAsset: null,
    savingsOxfordShare: null,
    indeterminate: false,
    basisNote: 'placeholder cost-seg study; bonus schedule from fixture',
    prov: { source: 'placeholder:costseg 2026', confidence: 'estimated' as const },
  };

  it('parses a valid cost-seg opportunity', () => {
    const result = CostSegOpportunity.parse(valid);
    expect(result.propertyId).toBe('prop-westbelt-a');
    expect(result.reclassifiableBasis).toBe(1_000_000);
    expect(result.savingsFullAsset).toBeNull();
    expect(result.savingsOxfordShare).toBeNull();
  });

  it('accepts a null propertyName and null bonus/acceleration (year missing from schedule)', () => {
    const result = CostSegOpportunity.parse({
      ...valid,
      propertyName: null,
      bonusYearPct: null,
      firstYearAccelerationUsd: null,
      firstYearAccelerationOxfordShare: null,
      indeterminate: true,
    });
    expect(result.propertyName).toBeNull();
    expect(result.bonusYearPct).toBeNull();
    expect(result.firstYearAccelerationUsd).toBeNull();
    expect(result.indeterminate).toBe(true);
  });

  // The hard-null rule, enforced by the schema — NOT by convention.
  it('REJECTS a non-null savingsFullAsset (hard-null v1 rule is schema-enforced)', () => {
    expect(() => CostSegOpportunity.parse({ ...valid, savingsFullAsset: 5 })).toThrow();
  });

  it('REJECTS a non-null savingsOxfordShare (hard-null v1 rule is schema-enforced)', () => {
    expect(() => CostSegOpportunity.parse({ ...valid, savingsOxfordShare: 250_000 })).toThrow();
  });

  it('rejects a negative depreciableBasis', () => {
    expect(() => CostSegOpportunity.parse({ ...valid, depreciableBasis: -1 })).toThrow();
  });

  it('rejects a landAllocationPct above 1', () => {
    expect(() => CostSegOpportunity.parse({ ...valid, landAllocationPct: 1.2 })).toThrow();
  });

  it('rejects a reclassifiablePct below 0', () => {
    expect(() => CostSegOpportunity.parse({ ...valid, reclassifiablePct: -0.1 })).toThrow();
  });

  it('rejects a negative firstYearAccelerationUsd', () => {
    expect(() => CostSegOpportunity.parse({ ...valid, firstYearAccelerationUsd: -1 })).toThrow();
  });

  it('rejects a missing basisNote', () => {
    const { basisNote: _omit, ...noNote } = valid as Record<string, unknown>;
    expect(() => CostSegOpportunity.parse(noNote)).toThrow();
  });
});

// ── EntityStrategyItem ─────────────────────────────────────────────────────────

describe('EntityStrategyItem', () => {
  const valid = {
    id: 'strat-mgmt-co',
    title: 'Management company allocation',
    detail: 'Route shared overhead through the management entity to align expense recognition.',
    kind: 'entity-structure' as const,
    applicabilityNote: 'Qualitative — no dollar figure by design.',
  };

  it('parses a valid entity strategy item', () => {
    expect(EntityStrategyItem.parse(valid).kind).toBe('entity-structure');
  });

  for (const kind of ['entity-structure', 'sec469', 'pipeline']) {
    it(`accepts kind '${kind}'`, () => {
      expect(EntityStrategyItem.parse({ ...valid, kind }).kind).toBe(kind);
    });
  }

  it('rejects an invalid kind', () => {
    expect(() => EntityStrategyItem.parse({ ...valid, kind: 'cost-seg' })).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() => EntityStrategyItem.parse({ ...valid, id: '' })).toThrow();
  });
});

// ── FiledReturnMeta ────────────────────────────────────────────────────────────
// Metadata-only PERMANENTLY (C2 confidentiality boundary): the schema carries NO
// field for return contents — only cataloguing metadata + a storage/link-out note.

describe('FiledReturnMeta', () => {
  const valid = {
    id: 'ret-2024-holdco',
    taxYear: 2024,
    entity: 'Oxford Holdings LLC',
    preparer: 'Regional CPA firm',
    status: 'filed' as const,
    storageNote: 'Contents in SharePoint; this system stores metadata only.',
  };

  it('parses valid filed-return metadata', () => {
    expect(FiledReturnMeta.parse(valid).taxYear).toBe(2024);
  });

  it('accepts a null preparer', () => {
    expect(FiledReturnMeta.parse({ ...valid, preparer: null }).preparer).toBeNull();
  });

  for (const status of ['filed', 'extended', 'amended']) {
    it(`accepts status '${status}'`, () => {
      expect(FiledReturnMeta.parse({ ...valid, status }).status).toBe(status);
    });
  }

  it('rejects an invalid status', () => {
    expect(() => FiledReturnMeta.parse({ ...valid, status: 'draft' })).toThrow();
  });

  it('rejects a non-integer tax year', () => {
    expect(() => FiledReturnMeta.parse({ ...valid, taxYear: 2024.5 })).toThrow();
  });
});

// ── TaxStrategyReport envelope ─────────────────────────────────────────────────

describe('TaxStrategyReport', () => {
  const base = {
    asOf: '2026-07-09',
    basisDataSource: 'placeholder' as const,
    filedReturnsDataSource: 'placeholder' as const,
    droppedFixtureRows: 0,
    scheduleNote: 'Placeholder bonus-depreciation schedule; not tax advice.',
    costSeg: [],
    entityStrategies: [],
    filedReturns: [],
    advisoryOnly: true as const,
  };

  it('round-trips a full report', () => {
    const report = TaxStrategyReport.parse(base);
    expect(report.basisDataSource).toBe('placeholder');
    expect(report.advisoryOnly).toBe(true);
  });

  it('rejects a missing advisoryOnly flag', () => {
    const { advisoryOnly: _omit, ...noFlag } = base as Record<string, unknown>;
    expect(() => TaxStrategyReport.parse(noFlag)).toThrow();
  });

  it('rejects advisoryOnly: false (must be the literal true)', () => {
    expect(() => TaxStrategyReport.parse({ ...base, advisoryOnly: false })).toThrow();
  });

  it('rejects a negative droppedFixtureRows count', () => {
    expect(() => TaxStrategyReport.parse({ ...base, droppedFixtureRows: -1 })).toThrow();
  });

  it('rejects an invalid basisDataSource', () => {
    expect(() => TaxStrategyReport.parse({ ...base, basisDataSource: 'fixture' })).toThrow();
  });
});
