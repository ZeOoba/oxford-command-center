// tests/unit/warehouse-mapping.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { accountKey, resolveMapping, seedMappings } from '../../server/warehouse/mapping';

const SEED = {
  mappings: [
    { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
    { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
    { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  ],
};

describe('mapping engine', () => {
  it('normalizes account keys (strips code, case, whitespace)', () => {
    expect(accountKey('          5064 Rent')).toBe('rent');
    expect(accountKey('HVAC  Repair ')).toBe('hvac repair');
  });

  it('seeds and resolves; manual overrides beat seed; unmapped falls back conservatively', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedMappings(db, SEED.mappings);
    const rent = resolveMapping(db, '5064 Rent');
    expect(rent.normalizedCategory).toBe('Rental Revenue');
    expect(rent.classification).toBe('revenue');
    expect(rent.matchKind).toBe('seed');

    db.prepare(
      `INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind)
       VALUES ('rent', 'Other Income', 'other-income', 'manual')`,
    ).run();
    expect(resolveMapping(db, 'Rent').classification).toBe('other-income'); // manual wins

    const unknown = resolveMapping(db, 'Totally New Account');
    expect(unknown.normalizedCategory).toBe('Unmapped');
    expect(unknown.classification).toBe('opex'); // assume-expense rule (ratified), flagged
    expect(unknown.matchKind).toBe('unmapped');
  });

  it('resolves side-ambiguous names by section (Gas: income recovery vs expense opex)', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedMappings(db, [
      { account: 'Gas', code: '5034', normalized_category: 'CAM Recoveries', classification: 'recovery' },
      { account: 'Gas', code: '6675', normalized_category: 'Utilities', classification: 'opex' },
    ]);
    expect(resolveMapping(db, 'Gas', undefined, 'INCOME').classification).toBe('recovery');
    expect(resolveMapping(db, '6675 Gas', undefined, 'EXPENSE').classification).toBe('opex');
    // without section: falls back to the first seeded entry (documented behavior)
    expect(['recovery', 'opex']).toContain(resolveMapping(db, 'Gas').classification);
  });

  it('sideHint side-constrains the dual-side SEED tiebreak AND a GLOBAL manual override, but a PROPERTY-SCOPED manual override wins cross-side', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedMappings(db, [
      { account: 'Gas', code: '5034', normalized_category: 'CAM Recoveries', classification: 'recovery' },
      { account: 'Gas', code: '6675', normalized_category: 'Utilities', classification: 'opex' },
    ]);
    // (1) H3 protection: an expense-side row re-resolved with sideHint='expense' must land on the
    // expense seed (opex), never flip to the income/recovery seed — even though both seeds exist.
    expect(resolveMapping(db, 'Gas', undefined, undefined, 'expense').classification).toBe('opex');
    expect(resolveMapping(db, 'Gas', undefined, undefined, 'income').classification).toBe('recovery');

    // (2) A GLOBAL manual override (property_id NULL) is a portfolio-wide default — side-constrained
    // like a seed so it can NEVER silently flip a row to the opposite NOI side across the portfolio.
    // A global manual income/recovery override re-resolved under the row's stale expense sideHint must
    // NOT win; it falls back to the same-side opex SEED, keeping the row on its expense side.
    db.prepare(
      `INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind, property_id)
       VALUES ('gas', 'CAM Recoveries', 'recovery', 'manual', NULL)`,
    ).run();
    const g = resolveMapping(db, 'Gas', undefined, undefined, 'expense');
    expect(g.matchKind).toBe('seed'); // the global manual did NOT win cross-side
    expect(g.classification).toBe('opex'); // stayed on its expense side — NOI sign preserved
    // the same global manual DOES win on the income side, where it agrees with the hint
    expect(resolveMapping(db, 'Gas', undefined, undefined, 'income'))
      .toMatchObject({ matchKind: 'manual', classification: 'recovery' });

    // (3) A PROPERTY-SCOPED manual override is a targeted, deliberate human ruling for THAT property
    // and WINS regardless of side — a reviewer who reclassifies a specific property's expense-ingested
    // Gas as a tenant billback (income/recovery) is honored even under the row's stale expense hint.
    db.prepare(
      `INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind, property_id)
       VALUES ('gas', 'CAM Recoveries', 'recovery', 'manual', 'prop-1')`,
    ).run();
    const s = resolveMapping(db, 'Gas', 'prop-1', undefined, 'expense');
    expect(s.matchKind).toBe('manual');
    expect(s.classification).toBe('recovery'); // scoped manual cross-side ruling wins over sideHint='expense'

    // (4) The same-side manual case is unaffected: a global manual expense override under expense
    // sideHint wins because it AGREES with the row's side.
    db.prepare(
      `INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind)
       VALUES ('hvac repair', 'HVAC Capital', 'capex', 'manual')`,
    ).run();
    expect(resolveMapping(db, 'HVAC Repair', undefined, undefined, 'expense').classification).toBe('capex');
  });
});
