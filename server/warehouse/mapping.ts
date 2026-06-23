// server/warehouse/mapping.ts
import { readFileSync } from 'node:fs';
import type { AccountMapping } from '../../src/contracts/warehouse';
import { AccountMappingSchema, isNoiIncomeClass } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';

// ── Period-scoped seed entry (H4 extension) ───────────────────────────────
// AccountMappingSchema (warehouse.ts) defines the base seed shape used for the
// global mapping seed file. Period-scoped entries (e.g. the FVC 2025 easement)
// additionally carry property_id + period. We extend locally here rather than
// adding optional fields to the shared contract (keeping the base contract thin).
interface AccountMappingWithScope extends AccountMapping {
  property_id?: string;
  period?: string;
}

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
    INSERT OR IGNORE INTO account_mappings
      (raw_account_key, normalized_category, classification, match_kind, property_id, period, note)
    VALUES (?, ?, ?, 'seed', ?, ?, ?)
  `);
  // Dedup key: (account key, statement side, property_id, period) so that:
  //   • the same account seeded as both income recovery AND expense opex survives (dual-side rule)
  //   • a period-scoped exclusion (property+period not null) is distinct from the global seed row
  //     for the same account key — both must be inserted independently
  const existing = new Set(
    (db.prepare("SELECT raw_account_key, classification, property_id, period FROM account_mappings WHERE match_kind='seed'").all() as Array<{ raw_account_key: string; classification: string; property_id: string | null; period: string | null }>)
      .map((r) => `${r.raw_account_key}|${classificationSide(r.classification)}|${r.property_id ?? ''}|${r.period ?? ''}`),
  );
  let count = 0;
  const tx = db.transaction((rows: AccountMappingWithScope[]) => {
    for (const m of rows) {
      const propId = m.property_id ?? null;
      const period = m.period ?? null;
      const dedupKey = `${accountKey(m.account)}|${classificationSide(m.classification)}|${propId ?? ''}|${period ?? ''}`;
      if (existing.has(dedupKey)) continue;
      existing.add(dedupKey);
      ins.run(accountKey(m.account), m.normalized_category, m.classification, propId, period, m.note ?? null);
      count++;
    }
  });
  // Parse the base AccountMapping shape; property_id + period are optional extras — strip through
  tx(mappings.map((m) => {
    const base = AccountMappingSchema.parse(m);
    const extra = m as { property_id?: unknown; period?: unknown };
    return {
      ...base,
      property_id: typeof extra.property_id === 'string' ? extra.property_id : undefined,
      period: typeof extra.period === 'string' ? extra.period : undefined,
    } satisfies AccountMappingWithScope;
  }));
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
   *  flipping its NOI sign. 'either' is treated as no constraint. A PROPERTY-SCOPED manual override
   *  is EXEMPT from this guard (a reviewer's explicit, targeted cross-side reclassification wins
   *  regardless of the hint); a GLOBAL manual override is side-constrained like a seed (see below). */
  sideHint?: 'income' | 'expense' | 'either',
  /** Period string (e.g. '2025'). When provided, rows with a non-null period column must match
   *  exactly; rows with period IS NULL always match (they are unscoped). This enables period-scoped
   *  one-time exclusions (H4: FVC 2025 cell-tower easement) without affecting any other period. */
  period?: string,
): ResolvedMapping {
  const key = accountKey(rawAccount);
  const rows = db.prepare(`
    SELECT id, normalized_category, classification, match_kind, property_id, period FROM account_mappings
    WHERE raw_account_key = ?
      AND (property_id IS NULL OR property_id = ?)
      AND (period IS NULL OR period = ?)
    ORDER BY CASE match_kind WHEN 'manual' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END,
             property_id IS NULL,
             period IS NULL
  `).all(key, propertyId ?? null, period ?? null) as
    Array<{ id: number; normalized_category: string; classification: string; match_kind: string; property_id: string | null; period: string | null }>;

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
    // A PROPERTY-SCOPED manual override (property_id matches the queried property) is a targeted,
    // deliberate human ruling — a reviewer reclassifying THAT property's account (e.g. an expense-
    // ingested Gas declared a tenant billback) — and approve's contract is to honor it cross-side.
    // A GLOBAL manual override (property_id null) is a portfolio-wide DEFAULT: it is side-constrained
    // like a seed so it can never silently flip a row to the opposite income/expense side across the
    // whole portfolio (the dual-side NOI-sign guard — H3 + finding 4; keeps approve consistent with
    // addMappingOverride's in-place re-derive). rows are sorted manual-first then scoped-before-global
    // (property_id IS NULL ASC), so a scoped manual, if any, is rows[0].
    if (rows[0]?.match_kind === 'manual' && rows[0].property_id !== null) {
      row = rows[0];
    } else {
      row = rows.find((r) => {
        if (r.match_kind === 'manual' && r.property_id !== null) return true; // scoped manual always qualifies
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
