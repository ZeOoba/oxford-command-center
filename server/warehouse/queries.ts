// server/warehouse/queries.ts — pure read queries over the Phase A warehouse.
// Parameterized SQL only; camel-case mapping by hand (`AS` aliases). No writes here —
// mutations live in actions.ts.
import type { WarehouseDb } from './db';

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
 * NOI by (property, period) over ACTIVE ledger rows only — the same NOI definition the
 * backfill CLI prints (revenue + recovery + other-income − opex; everything else excluded).
 */
export function noiMatrix(db: WarehouseDb): NoiCell[] {
  return db.prepare(`
    SELECT l.property_id AS propertyId, p.name AS propertyName, l.period,
           ROUND(SUM(CASE WHEN l.classification IN ('revenue','recovery','other-income') THEN l.amount
                          WHEN l.classification = 'opex' THEN -l.amount ELSE 0 END), 2) AS noi
    FROM ledger_entries l
    LEFT JOIN property_master p ON p.id = l.property_id
    WHERE l.is_active = 1
    GROUP BY l.property_id, l.period
    ORDER BY l.property_id, l.period
  `).all() as NoiCell[];
}
