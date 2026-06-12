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
});
