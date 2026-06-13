// server/warehouse/metrics.ts
import type { WarehouseDb } from './db';

export interface PeriodMetrics {
  propertyId: string;
  propertyName: string | null;
  period: string;            // 'YYYY'
  grainHint: string | null;  // from the import (year|ytd) — for comparability
  rentableSf: number | null;
  ownershipPct: number;
  revenue: number;           // revenue + recovery + other-income (gross income, 100%-basis)
  opex: number;              // operating expenses (positive magnitude)
  noi: number;
  noiMargin: number | null;  // noi / revenue
  expenseRatio: number | null; // opex / revenue
  capex: number; ti: number; leasing: number; // tracked, NOT in NOI
  categories: Record<string, number>; // opex by normalized_category
  revenueCategories: Record<string, number>; // revenue+recovery+other-income by normalized_category (positive)
  // $/SF (100%-basis; null when rentableSf missing/0)
  revenuePerSf: number | null; noiPerSf: number | null; expensePerSf: number | null;
  taxesPerSf: number | null; insurancePerSf: number | null; repairsPerSf: number | null;
  // ownership overlay
  oxfordNoi: number;         // noi × ownershipPct
}

interface Row { propertyId: string; propertyName: string | null; period: string;
  classification: string; normalizedCategory: string; amount: number;
  rentableSf: number | null; ownershipPct: number; grainHint: string | null; }

export function propertyPeriodMetrics(db: WarehouseDb): PeriodMetrics[] {
  const rows = db.prepare(`
    SELECT l.property_id AS propertyId, p.name AS propertyName, l.period,
           l.classification, l.normalized_category AS normalizedCategory, l.amount,
           p.rentable_sf AS rentableSf, COALESCE(p.ownership_pct, 1) AS ownershipPct,
           (SELECT b.period_grain FROM import_batches b WHERE b.id = l.import_id) AS grainHint
    FROM ledger_entries l LEFT JOIN property_master p ON p.id = l.property_id
    WHERE l.is_active = 1
    ORDER BY l.property_id, l.period
  `).all() as Row[];

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.propertyId}|${r.period}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const perSf = (v: number, sf: number | null) => (sf && sf > 0 ? v / sf : null);
  const out: PeriodMetrics[] = [];
  for (const g of groups.values()) {
    const head = g[0]!;
    let revenue = 0, opex = 0, capex = 0, ti = 0, leasing = 0;
    const categories: Record<string, number> = {};
    const revenueCategories: Record<string, number> = {};
    for (const r of g) {
      switch (r.classification) {
        case 'revenue': case 'recovery': case 'other-income':
          revenue += r.amount;
          revenueCategories[r.normalizedCategory] = (revenueCategories[r.normalizedCategory] ?? 0) + r.amount;
          break;
        case 'opex': opex += r.amount; categories[r.normalizedCategory] = (categories[r.normalizedCategory] ?? 0) + r.amount; break;
        case 'capex': capex += r.amount; break;
        case 'ti': ti += r.amount; break;
        case 'leasing': leasing += r.amount; break;
        default: break; // excluded / debt-service
      }
    }
    const noi = revenue - opex;
    const sf = head.rentableSf;
    out.push({
      propertyId: head.propertyId, propertyName: head.propertyName, period: head.period,
      grainHint: head.grainHint, rentableSf: sf, ownershipPct: head.ownershipPct,
      revenue, opex, noi,
      noiMargin: revenue !== 0 ? noi / revenue : null,
      expenseRatio: revenue !== 0 ? opex / revenue : null,
      capex, ti, leasing, categories, revenueCategories,
      revenuePerSf: perSf(revenue, sf), noiPerSf: perSf(noi, sf), expensePerSf: perSf(opex, sf),
      taxesPerSf: perSf(categories['Taxes'] ?? 0, sf),
      insurancePerSf: perSf(categories['Insurance'] ?? 0, sf),
      repairsPerSf: perSf(categories['Repairs & Maintenance'] ?? 0, sf),
      oxfordNoi: noi * head.ownershipPct,
    });
  }
  return out.sort((a, b) => a.propertyId.localeCompare(b.propertyId) || a.period.localeCompare(b.period));
}
