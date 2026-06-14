// server/warehouse/mapping.ts
import { readFileSync } from 'node:fs';
import type { AccountMapping } from '../../src/contracts/warehouse';
import { AccountMappingSchema, isNoiIncomeClass } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';

export function accountKey(raw: string): string {
  return raw.trim().replace(/^\d[\d.-]*\s+/, '').replace(/\s+/g, ' ').toLowerCase();
}

/** Which side of the income statement a classification lives on. */
export function classificationSide(c: string): 'income' | 'expense' | 'either' {
  // Income side is exactly the NOI income classes — sourced from the contract so this can't drift
  // from NOI_INCOME_CLASSES if an income member is ever added/removed. The expense side carries
  // non-NOI classes (capex/ti/leasing/debt-service) too, so it stays an explicit list.
  if (isNoiIncomeClass(c)) return 'income';
  switch (c) {
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

export function resolveMapping(
  db: WarehouseDb,
  rawAccount: string,
  propertyId?: string,
  section?: string,
  /** Explicit income/expense side to constrain re-resolution to (overrides `section`). Pass the
   *  side of a row's EXISTING classification on re-resolve so a dual-side SEED account (e.g. "Gas" as
   *  both billback recovery AND utility opex) can only re-resolve within its original side — never
   *  flipping its NOI sign. 'either' is treated as no constraint. A match_kind='manual' override is
   *  EXEMPT from this guard (a reviewer's explicit cross-side reclassification wins regardless of
   *  the hint); the side filter binds only seed/learned rows. */
  sideHint?: 'income' | 'expense' | 'either',
): ResolvedMapping {
  const key = accountKey(rawAccount);
  const rows = db.prepare(`
    SELECT id, normalized_category, classification, match_kind FROM account_mappings
    WHERE raw_account_key = ? AND (property_id IS NULL OR property_id = ?)
    ORDER BY CASE match_kind WHEN 'manual' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END,
             property_id IS NULL
  `).all(key, propertyId ?? null) as
    Array<{ id: number; normalized_category: string; classification: string; match_kind: string }>;

  // sideHint (the row's existing classification side, on re-resolve) takes precedence over a
  // section header; 'either' means no constraint. Falls back to section-derived side for ingest.
  const side =
    sideHint !== undefined && sideHint !== 'either'
      ? sideHint
      : section !== undefined
        ? sectionSide(section)
        : null;
  let row: (typeof rows)[number] | undefined = rows[0];
  if (side !== null) {
    // A manual override is an explicit human ruling — a reviewer who reclassifies an account
    // (e.g. an expense-ingested Gas declared a tenant billback) is making a DELIBERATE cross-side
    // correction, and approve's contract is to honor it. So a manual mapping wins regardless of
    // side; the side filter binds ONLY the seed/learned tiebreak (rows already sorted manual-first,
    // so a manual row, if any, is rows[0]). This preserves the H3 dual-side seed guard (the
    // Gas/Electric/Water/bad-debt seed rows carry no manual mapping → the side filter still pins
    // an expense row to its expense seed and never flips it to the income/recovery seed) while
    // restoring approve's documented ability to apply legitimate cross-side manual overrides.
    if (rows[0]?.match_kind === 'manual') {
      row = rows[0];
    } else {
      row = rows.find((r) => {
        if (r.match_kind === 'manual') return true; // a manual row always qualifies
        const s = classificationSide(r.classification);
        return s === side || s === 'either';
      });
    }
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
