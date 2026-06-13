// server/warehouse/mapping.ts
import { readFileSync } from 'node:fs';
import type { AccountMapping } from '../../src/contracts/warehouse';
import { AccountMappingSchema } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';

export function accountKey(raw: string): string {
  return raw.trim().replace(/^\d[\d.-]*\s+/, '').replace(/\s+/g, ' ').toLowerCase();
}

/** Which side of the income statement a classification lives on. */
export function classificationSide(c: string): 'income' | 'expense' | 'either' {
  switch (c) {
    case 'revenue':
    case 'recovery':
    case 'other-income':
      return 'income';
    case 'opex':
    case 'capex':
    case 'ti':
    case 'leasing':
    case 'debt-service':
      return 'expense';
    default: // 'excluded' and anything unknown
      return 'either';
  }
}

/** Map a source-statement section header to a side, if determinable. */
export function sectionSide(section: string): 'income' | 'expense' | null {
  if (/EXPENSE/i.test(section)) return 'expense';
  if (/INCOME|REVENUE/i.test(section)) return 'income';
  return null;
}

export function seedMappings(db: WarehouseDb, mappings: unknown[]): number {
  const ins = db.prepare(`
    INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind, note)
    VALUES (?, ?, ?, 'seed', ?)
  `);
  // Dedup per (account key, statement side): real charts carry the same name on
  // both sides (e.g. "Gas" as billback income AND utility expense) — both must survive.
  const existing = new Set(
    (db.prepare("SELECT raw_account_key, classification FROM account_mappings WHERE match_kind='seed'").all() as Array<{ raw_account_key: string; classification: string }>)
      .map((r) => r.raw_account_key + '|' + classificationSide(r.classification)),
  );
  let count = 0;
  const tx = db.transaction((rows: AccountMapping[]) => {
    for (const m of rows) {
      const dedupKey = accountKey(m.account) + '|' + classificationSide(m.classification);
      if (existing.has(dedupKey)) continue;
      existing.add(dedupKey);
      ins.run(accountKey(m.account), m.normalized_category, m.classification, m.note ?? null);
      count++;
    }
  });
  tx(mappings.map((m) => AccountMappingSchema.parse(m)));
  return count;
}

export function seedMappingsFromFile(db: WarehouseDb, path: string): number {
  const seed = JSON.parse(readFileSync(path, 'utf8')) as { mappings: unknown[] };
  return seedMappings(db, seed.mappings);
}

export interface ResolvedMapping {
  normalizedCategory: string;
  classification: string;
  matchKind: 'manual' | 'seed' | 'unmapped';
  mappingId: number | null;
}

export function resolveMapping(db: WarehouseDb, rawAccount: string, propertyId?: string, section?: string): ResolvedMapping {
  const key = accountKey(rawAccount);
  const rows = db.prepare(`
    SELECT id, normalized_category, classification, match_kind FROM account_mappings
    WHERE raw_account_key = ? AND (property_id IS NULL OR property_id = ?)
    ORDER BY CASE match_kind WHEN 'manual' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END,
             property_id IS NULL
  `).all(key, propertyId ?? null) as
    Array<{ id: number; normalized_category: string; classification: string; match_kind: string }>;

  const side = section !== undefined ? sectionSide(section) : null;
  let row: (typeof rows)[number] | undefined = rows[0];
  if (side !== null) {
    row = rows.find((r) => {
      const s = classificationSide(r.classification);
      return s === side || s === 'either';
    });
    if (!row) {
      // Never let an income-side line resolve to an expense classification or vice versa.
      return side === 'expense'
        ? { normalizedCategory: 'Unmapped', classification: 'opex', matchKind: 'unmapped', mappingId: null }
        : { normalizedCategory: 'Unmapped', classification: 'other-income', matchKind: 'unmapped', mappingId: null };
    }
  }
  if (!row) {
    return { normalizedCategory: 'Unmapped', classification: 'opex', matchKind: 'unmapped', mappingId: null };
  }
  return {
    normalizedCategory: row.normalized_category,
    classification: row.classification,
    matchKind: row.match_kind === 'manual' ? 'manual' : 'seed',
    mappingId: row.id,
  };
}
