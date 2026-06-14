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

  it('sideHint constrains the dual-side SEED tiebreak but a manual override wins regardless of side', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedMappings(db, [
      { account: 'Gas', code: '5034', normalized_category: 'CAM Recoveries', classification: 'recovery' },
      { account: 'Gas', code: '6675', normalized_category: 'Utilities', classification: 'opex' },
    ]);
    // (1) H3 protection: an expense-side row re-resolved with sideHint='expense' must land on the
    // expense seed (opex), never flip to the income/recovery seed — even though both seeds exist.
    expect(resolveMapping(db, 'Gas', undefined, undefined, 'expense').classification).toBe('opex');
    expect(resolveMapping(db, 'Gas', undefined, undefined, 'income').classification).toBe('recovery');

    // (2) A manual override is an explicit human ruling — it must win over sideHint even when it
    // sits on the OPPOSITE side from the hint. Here Gas gets a manual income/recovery mapping; a
    // re-resolve carrying the row's stale expense sideHint must STILL return the manual mapping,
    // not fall back to the same-side opex seed and silently drop the human's reclassification.
    db.prepare(
      `INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind)
       VALUES ('gas', 'CAM Recoveries', 'recovery', 'manual')`,
    ).run();
    const m = resolveMapping(db, 'Gas', undefined, undefined, 'expense');
    expect(m.matchKind).toBe('manual');
    expect(m.classification).toBe('recovery'); // manual cross-side ruling wins over sideHint='expense'

    // (3) The same-side manual case is unaffected: a manual expense override under expense sideHint wins.
    db.prepare(
      `INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind)
       VALUES ('hvac repair', 'HVAC Capital', 'capex', 'manual')`,
    ).run();
    expect(resolveMapping(db, 'HVAC Repair', undefined, undefined, 'expense').classification).toBe('capex');
  });
});
