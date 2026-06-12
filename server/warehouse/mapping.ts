// server/warehouse/mapping.ts
import { readFileSync } from 'node:fs';
import type { AccountMapping } from '../../src/contracts/warehouse';
import { AccountMappingSchema } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';

export function accountKey(raw: string): string {
  return raw.trim().replace(/^\d[\d.-]*\s+/, '').replace(/\s+/g, ' ').toLowerCase();
}

export function seedMappings(db: WarehouseDb, mappings: unknown[]): number {
  const ins = db.prepare(`
    INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind, note)
    VALUES (?, ?, ?, 'seed', ?)
  `);
  const existing = new Set(
    (db.prepare("SELECT raw_account_key FROM account_mappings WHERE match_kind='seed'").all() as Array<{ raw_account_key: string }>)
      .map((r) => r.raw_account_key),
  );
  let count = 0;
  const tx = db.transaction((rows: AccountMapping[]) => {
    for (const m of rows) {
      const key = accountKey(m.account);
      if (existing.has(key)) continue;
      existing.add(key);
      ins.run(key, m.normalized_category, m.classification, m.note ?? null);
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

export function resolveMapping(db: WarehouseDb, rawAccount: string, propertyId?: string): ResolvedMapping {
  const key = accountKey(rawAccount);
  const row = db.prepare(`
    SELECT id, normalized_category, classification, match_kind FROM account_mappings
    WHERE raw_account_key = ? AND (property_id IS NULL OR property_id = ?)
    ORDER BY CASE match_kind WHEN 'manual' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END,
             property_id IS NULL
    LIMIT 1
  `).get(key, propertyId ?? null) as
    | { id: number; normalized_category: string; classification: string; match_kind: string }
    | undefined;
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
