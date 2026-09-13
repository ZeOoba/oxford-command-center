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

// `owed` (Current Owed) carries every CHARGE row's amount; `prepay` (Pre-payments Owed) carries
// every CREDIT row's amount, with the OTHER column at 0 on that row (verified against the real
// 29000 Info Lane export, 2026-08-17). Summing both per row is required -- reading `owed` alone
// silently drops every credit before the offset logic below ever runs.
const COL = { property: 1, lease: 3, date: 7, owed: 9, prepay: 14 } as const;
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

    const owed = num(ws.getRow(r).getCell(COL.owed).value) + num(ws.getRow(r).getCell(COL.prepay).value);
    if (owed === 0) continue;

    let row = byTenant.get(lease);
    if (row === undefined) {
      row = { tenant: lease, property, d30: 0, d60: 0, d90: 0, d90plus: 0 };
      byTenant.set(lease, row);
    }
    row[bucketOf(asDate(ws.getRow(r).getCell(COL.date).value), asOf)] += owed;
  }

  // Net credits against the OLDEST outstanding buckets first (standard AR application order) AFTER
  // summation, then drop tenants netting to nothing — a zero is not a delinquency. A credit is
  // almost always dated near the as-of date (-> a young bucket) while the charge it offsets is old
  // (-> an old bucket); clamping each bucket independently to >=0 discarded the credit entirely and
  // left the old charge overstated by the full credit amount. Pooling first and applying oldest-first
  // matches how a tenant's payment actually reduces their oldest outstanding balance.
  const BUCKETS_OLDEST_FIRST = ['d90plus', 'd90', 'd60', 'd30'] as const;
  const out: ArAgingRow[] = [];
  for (const row of byTenant.values()) {
    let creditPool = 0;
    for (const b of BUCKETS_OLDEST_FIRST) {
      if (row[b] < 0) {
        creditPool += -row[b];
        row[b] = 0;
      }
    }
    for (const b of BUCKETS_OLDEST_FIRST) {
      if (creditPool <= 0) break;
      const applied = Math.min(row[b], creditPool);
      row[b] -= applied;
      creditPool -= applied;
    }
    // Round to cents (2026-08-17 refute-pass fix): repeated float subtraction across the pool/apply
    // loops above can leave a bucket at a sub-cent positive residue (e.g. 3.55e-15) instead of exact
    // 0 for an ordinary cent-denominated fully-paid tenant, which the keep-filter below would then
    // treat as a genuine delinquency -- a phantom $0.00 row for a tenant who owes nothing.
    row.d30 = Math.round(row.d30 * 100) / 100;
    row.d60 = Math.round(row.d60 * 100) / 100;
    row.d90 = Math.round(row.d90 * 100) / 100;
    row.d90plus = Math.round(row.d90plus * 100) / 100;
    if (row.d30 + row.d60 + row.d90 + row.d90plus > 0) out.push(row);
  }
  return out;
}
