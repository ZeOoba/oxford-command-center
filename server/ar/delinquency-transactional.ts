// server/ar/delinquency-transactional.ts
//
// Format C parser: the "DB Caption" transactional export (29000 Info Lane, CRC). One row PER CHARGE
// rather than per tenant, so aging is computed here from each charge's Date against the report's
// as-of date — the same reason ar-aging.ts refuses bucket-less formats rather than guessing.
//
// Subtotal rows (blank Property, repeated Lease) are skipped: they restate the tenant's total and
// would double every balance if summed alongside the detail rows.

import type ExcelJS from 'exceljs';
import type { ArAgingRow } from './ar-aging';

const COL = { property: 1, lease: 3, date: 7, owed: 9 } as const;
const DAY_MS = 86_400_000;

function text(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getRow(row).getCell(col).value;
  return v === null || v === undefined ? '' : String(v).trim();
}

function num(v: ExcelJS.CellValue): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const p = Number.parseFloat(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(p) ? p : 0;
  }
  return 0;
}

function asDate(v: ExcelJS.CellValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = new Date(v);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function detectDelinquencyTransactional(ws: ExcelJS.Worksheet): boolean {
  return text(ws, 1, 1).toLowerCase().startsWith('db caption:');
}

/** Bucket a charge by age in days. An UNDATED charge is treated as oldest — an unknown age must
 *  never be reported as current, which would understate a genuinely aged balance. */
function bucketOf(charge: Date | null, asOf: Date): 'd30' | 'd60' | 'd90' | 'd90plus' {
  if (charge === null) return 'd90plus';
  const days = Math.floor((asOf.getTime() - charge.getTime()) / DAY_MS);
  if (days <= 30) return 'd30';
  if (days <= 60) return 'd60';
  if (days <= 90) return 'd90';
  return 'd90plus';
}

export function parseDelinquencyTransactional(ws: ExcelJS.Worksheet, asOf: Date): ArAgingRow[] {
  const byTenant = new Map<string, ArAgingRow>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const property = text(ws, r, COL.property);
    const lease = text(ws, r, COL.lease);
    // Detail rows carry BOTH. A blank property with a lease is a per-tenant subtotal.
    if (property === '' || lease === '') continue;
    // Merged-cell artifact (same hazard as rent-manager-delinquency.ts, verified against this real
    // file): a banner row (property header, per-tenant name header) merges its text across columns A
    // through at least the Lease column, so ExcelJS's per-cell `.value` echoes the SAME string into
    // every merged column — not a real, distinct (property, lease) pair. A genuine detail row's
    // property is always a short building code ('29000inf') distinct from the tenant name in Lease,
    // so this cannot false-positive on real data.
    if (property === lease) continue;

    const owed = num(ws.getRow(r).getCell(COL.owed).value);
    if (owed === 0) continue;

    let row = byTenant.get(lease);
    if (row === undefined) {
      row = { tenant: lease, property, d30: 0, d60: 0, d90: 0, d90plus: 0 };
      byTenant.set(lease, row);
    }
    row[bucketOf(asDate(ws.getRow(r).getCell(COL.date).value), asOf)] += owed;
  }

  // Clamp per bucket AFTER summation so an in-period credit can offset a charge, but a net credit
  // never reports as negative past-due. Drop tenants netting to nothing — a zero is not a delinquency.
  const out: ArAgingRow[] = [];
  for (const row of byTenant.values()) {
    row.d30 = Math.max(0, row.d30);
    row.d60 = Math.max(0, row.d60);
    row.d90 = Math.max(0, row.d90);
    row.d90plus = Math.max(0, row.d90plus);
    if (row.d30 + row.d60 + row.d90 + row.d90plus > 0) out.push(row);
  }
  return out;
}
