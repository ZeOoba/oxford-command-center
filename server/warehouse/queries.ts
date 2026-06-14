// server/warehouse/queries.ts — pure read queries over the Phase A warehouse.
// Parameterized SQL only; camel-case mapping by hand (`AS` aliases). No writes here —
// mutations live in actions.ts.
import type { WarehouseDb } from './db';
import { propertyPeriodMetrics } from './metrics';

// NOI income classes come from the contract (single source of truth — never re-list these as SQL
// string literals, which silently drift from NOI_CLASSES). NOI = Σ income classes − opex.

export interface ImportSummary {
  id: number;
  fileName: string;
  propertyId: string | null;
  propertyName: string | null;
  /** Year of period_start (display shorthand), e.g. '2025'. */
  period: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  grain: string | null;
  basis: string;
  sourceSystem: string;
  version: number;
  status: string;
  confidence: number | null;
  importedAt: string;
}

export interface LedgerRowView {
  rawAccount: string;
  glCode: string | null;
  amount: number;
  normalizedCategory: string;
  classification: string;
  isActive: boolean;
}

/** A DQ issue scoped to one import (as returned inside getImportDetail). */
export interface IssueView {
  id: number;
  kind: string;
  detail: string;
  severity: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

/** A warehouse-wide DQ issue, batch-joined to its file + property for display. */
export interface WarehouseIssue extends IssueView {
  importId: number | null;
  fileName: string | null;
  propertyId: string | null;
  propertyName: string | null;
}

export interface ImportDetail extends ImportSummary {
  rows: LedgerRowView[];
  issues: IssueView[];
}

export interface NoiCell {
  propertyId: string;
  propertyName: string | null;
  period: string;
  noi: number;
}

const IMPORT_SELECT = `
  SELECT b.id, b.file_name AS fileName, b.property_id AS propertyId, p.name AS propertyName,
         substr(b.period_start, 1, 4) AS period,
         b.period_start AS periodStart, b.period_end AS periodEnd, b.period_grain AS grain,
         b.basis, b.source_system AS sourceSystem, b.version, b.status, b.confidence,
         b.imported_at AS importedAt
  FROM import_batches b
  LEFT JOIN property_master p ON p.id = b.property_id
`;

export function listImports(db: WarehouseDb): ImportSummary[] {
  return db.prepare(`${IMPORT_SELECT} ORDER BY b.imported_at DESC, b.id DESC`).all() as ImportSummary[];
}

export function getImportDetail(db: WarehouseDb, id: number): ImportDetail | null {
  const batch = db.prepare(`${IMPORT_SELECT} WHERE b.id = ?`).get(id) as ImportSummary | undefined;
  if (!batch) return null;

  const rawRows = db.prepare(`
    SELECT raw_account AS rawAccount, gl_code AS glCode, amount,
           normalized_category AS normalizedCategory, classification, is_active AS isActive
    FROM ledger_entries WHERE import_id = ? ORDER BY id
  `).all(id) as Array<Omit<LedgerRowView, 'isActive'> & { isActive: number }>;

  const issues = db.prepare(`
    SELECT id, kind, detail, severity, status, created_at AS createdAt, resolved_at AS resolvedAt
    FROM data_quality_issues WHERE import_id = ? ORDER BY id
  `).all(id) as IssueView[];

  return { ...batch, rows: rawRows.map((r) => ({ ...r, isActive: r.isActive === 1 })), issues };
}

export function listIssues(db: WarehouseDb, status = 'open'): WarehouseIssue[] {
  return db.prepare(`
    SELECT i.id, i.import_id AS importId, b.file_name AS fileName,
           i.property_id AS propertyId, p.name AS propertyName,
           i.kind, i.detail, i.severity, i.status, i.created_at AS createdAt, i.resolved_at AS resolvedAt
    FROM data_quality_issues i
    LEFT JOIN import_batches b ON b.id = i.import_id
    LEFT JOIN property_master p ON p.id = i.property_id
    WHERE i.status = ?
    ORDER BY i.created_at DESC, i.id DESC
  `).all(status) as WarehouseIssue[];
}

/**
 * NOI by (property, period) — the same 100%-basis NOI definition the backfill CLI prints
 * (revenue + recovery + other-income − opex; everything else excluded).
 *
 * Derived from propertyPeriodMetrics so it inherits selectCoherentBatch: a (property, period)
 * group that holds rows from MORE THAN ONE active import (a full-year period_end 12-31 and a
 * same-year YTD 06-30 share ledger period 'YYYY' but differ on period_end ⇒ neither supersedes
 * the other and both stay active) resolves to ONE coherent batch — the full year — instead of
 * SUMMING both (the ~2x double-count this used to report from a raw GROUP BY over all active
 * rows). NOI basis = PeriodMetrics.noi (100%-basis, revenue − opex), NOT oxfordNoi (ownership-
 * adjusted), so the /noi API + UI consumers are unchanged. ROUND-to-2dp preserves the prior
 * SQL output shape exactly. Ordering is already (propertyId, period) ascending from metrics.
 */
export function noiMatrix(db: WarehouseDb): NoiCell[] {
  return propertyPeriodMetrics(db).map((m) => ({
    propertyId: m.propertyId,
    propertyName: m.propertyName,
    period: m.period,
    noi: Math.round(m.noi * 100) / 100,
  }));
}
