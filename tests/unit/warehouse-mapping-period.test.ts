// tests/unit/warehouse-mapping-period.test.ts
// H4: Period-scoped account-mapping exclusion — FVC 2025 cell-tower easement
//
// RED before migration 019 + resolveMapping period param + seed entry.
// Tests are deliberately kept narrow: only the 4 safety boundaries that
// matter for a period-scoped exclusion rule.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { resolveMapping, seedMappings } from '../../server/warehouse/mapping';

const GL_KEY = 'Sale Cell Tower Easement';
const FVC_PROP = 'sepich-portfolio-columbus-oh-8-props';
const OTHER_PROP = 'gahanna-industrial';
const PERIOD_2025 = '2025';
const PERIOD_2026 = '2026';

function makeDb() {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-h4-')), 'f.sqlite'));
}

describe('H4 — period-scoped easement exclusion', () => {
  it('FVC 2025 cell-tower easement resolves to excluded', () => {
    const db = makeDb();
    // Seed the period-scoped exclusion entry
    seedMappings(db, [
      {
        account: GL_KEY,
        normalized_category: 'One-Time Easement Sale',
        classification: 'excluded',
        property_id: FVC_PROP,
        period: PERIOD_2025,
        note: 'H4: $500k perpetual cell-tower easement sale — one-time, never in run-rate NOI',
      },
    ]);
    const m = resolveMapping(db, GL_KEY, FVC_PROP, undefined, undefined, PERIOD_2025);
    expect(m.classification).toBe('excluded');
    expect(m.matchKind).not.toBe('unmapped');
  });

  it('FVC 2025 with a different GL account does NOT get excluded', () => {
    const db = makeDb();
    seedMappings(db, [
      {
        account: GL_KEY,
        normalized_category: 'One-Time Easement Sale',
        classification: 'excluded',
        property_id: FVC_PROP,
        period: PERIOD_2025,
        note: 'H4',
      },
    ]);
    // 'Rent' has no scoped entry — falls through to unmapped
    const m = resolveMapping(db, 'Rent Revenue', FVC_PROP, undefined, undefined, PERIOD_2025);
    expect(m.classification).not.toBe('excluded');
  });

  it('FVC 2026 same GL account does NOT get excluded (future-period safety)', () => {
    const db = makeDb();
    seedMappings(db, [
      {
        account: GL_KEY,
        normalized_category: 'One-Time Easement Sale',
        classification: 'excluded',
        property_id: FVC_PROP,
        period: PERIOD_2025,
        note: 'H4',
      },
    ]);
    // Querying 2026 must NOT match the 2025-scoped row
    const m = resolveMapping(db, GL_KEY, FVC_PROP, undefined, undefined, PERIOD_2026);
    // Without a fallback, this should be unmapped — never 'excluded' from the 2025 scoped row
    expect(m.classification).not.toBe('excluded');
  });

  it('different property 2025 same GL key does NOT get excluded (property-scope safety)', () => {
    const db = makeDb();
    seedMappings(db, [
      {
        account: GL_KEY,
        normalized_category: 'One-Time Easement Sale',
        classification: 'excluded',
        property_id: FVC_PROP,
        period: PERIOD_2025,
        note: 'H4',
      },
    ]);
    // Different property — must not match the FVC-scoped row
    const m = resolveMapping(db, GL_KEY, OTHER_PROP, undefined, undefined, PERIOD_2025);
    expect(m.classification).not.toBe('excluded');
  });
});
