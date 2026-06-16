// server/warehouse/metrics.ts
import { isNoiIncomeClass, isOpex } from '../../src/contracts/warehouse';
import type { PeriodMetrics } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';

// PeriodMetrics is single-sourced in the contract (H6 — PeriodMetricsSchema). Re-export under the
// local name so existing engine imports (`import type { PeriodMetrics } from './metrics'`) keep
// working; the Zod schema is the source of truth for both the engine and the client.
//   Field reference (see PeriodMetricsSchema): grainHint = import grain (year|ytd); basis =
//   accounting basis (cash|accrual|tax|unknown), comparisons must not mix bases; revenue =
//   revenue + recovery + other-income (100%-basis); opex = positive magnitude; capex/ti/leasing
//   are tracked, NOT in NOI; categories = opex by category; revenueCategories = income by
//   category; $/SF null when rentableSf missing/0; oxfordNoi = noi × ownershipPct.
export type { PeriodMetrics };

interface Row { propertyId: string; propertyName: string | null; period: string;
  classification: string; normalizedCategory: string; amount: number;
  rentableSf: number | null; ownershipPct: number; grainHint: string | null; basis: string | null;
  importId: number; periodEnd: string | null; }

/**
 * A (propertyId, period) group can contain rows from MORE THAN ONE active import when a full-year
 * and a same-year YTD coexist (same ledger period 'YYYY', different period_end ⇒ neither supersedes
 * the other). Summing both double-counts NOI and makes basis/grainHint an arbitrary-row pick. Resolve
 * to ONE coherent batch deterministically: full-year beats YTD beats other; then latest period_end;
 * then latest import. Single-batch groups (the common case) pass through unchanged.
 */
export function selectCoherentBatch(group: Row[]): Row[] {
  const byImport = new Map<number, Row[]>();
  for (const r of group) {
    const arr = byImport.get(r.importId) ?? [];
    arr.push(r);
    byImport.set(r.importId, arr);
  }
  if (byImport.size <= 1) return group;
  const grainRank = (g: string | null) => (g === 'year' ? 2 : g === 'ytd' ? 1 : 0);
  // Resolve by a SINGLE TOTAL ORDER (transitive — a pairwise rule that switched between period_end
  // and importId depending on null-ness was intransitive and made the winner depend on row order):
  //   max by [grainRank, endKey, importId], all DESC.
  // endKey: a null period_end = UNKNOWN scope (header-parse miss). It must not be demoted below a
  // dated partial (that silently understated NOI), so null sorts as the MOST-RECENT end ('￿' >
  // any ISO date) — a parse-miss restatement wins its grain; dated ends order by recency; ties on
  // end break by latest import. full-year (higher grain) always beats a same-year YTD regardless.
  const endKey = (e: string | null) => e ?? '￿';
  const batches = [...byImport.values()];
  batches.sort((x, y) => {
    const a = x[0]!, b = y[0]!;
    if (grainRank(a.grainHint) !== grainRank(b.grainHint)) return grainRank(b.grainHint) - grainRank(a.grainHint);
    const ea = endKey(a.periodEnd), eb = endKey(b.periodEnd);
    if (ea !== eb) return ea < eb ? 1 : -1;
    return b.importId - a.importId;
  });
  return batches[0]!;
}

/**
 * The latest period for one property's metrics whose grain is a FULL YEAR (grainHint === 'year').
 * Returns null when the property has no full-year period (e.g. YTD-only coverage). Used by the
 * benchmark/ranking and PM-scorecard paths so level + percentile comparisons happen WITHIN a single
 * (period, grain) cohort and a trailing YTD partial never leaks into a full-year peer comparison
 * (spec §9). Caller passes only one property's PeriodMetrics[]; input is not mutated.
 */
export function latestFullYearPeriod(metricsForOneProperty: PeriodMetrics[]): string | null {
  let latest: string | null = null;
  for (const m of metricsForOneProperty) {
    if (m.grainHint !== 'year') continue;
    if (latest === null || m.period.localeCompare(latest) > 0) latest = m.period;
  }
  return latest;
}

/** A comparable real-estate operating entity has positive rentable SF. A SF-less entity (e.g. 1851 S
 *  Club — a 25% rooftop-solar PPA royalty: rentableSf null, no building owned) has no comparable
 *  operating-expense profile and must be excluded from all cohort/percentile/benchmark aggregations.
 *  Single source of truth: imported by scores.ts (efficiency cohorts) and benchmarks.ts (display cohorts). */
export function isOperatingRealEstate(m: PeriodMetrics): boolean {
  return typeof m.rentableSf === 'number' && Number.isFinite(m.rentableSf) && m.rentableSf > 0;
}

export function propertyPeriodMetrics(db: WarehouseDb): PeriodMetrics[] {
  const rows = db.prepare(`
    SELECT l.property_id AS propertyId, p.name AS propertyName, l.period,
           l.classification, l.normalized_category AS normalizedCategory, l.amount,
           p.rentable_sf AS rentableSf, COALESCE(p.ownership_pct, 1) AS ownershipPct,
           b.period_grain AS grainHint,
           b.basis AS basis,
           l.import_id AS importId,
           b.period_end AS periodEnd
    FROM ledger_entries l
    LEFT JOIN property_master p ON p.id = l.property_id
    LEFT JOIN import_batches b ON b.id = l.import_id
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
  for (const groupRows of groups.values()) {
    const g = selectCoherentBatch(groupRows);
    const head = g[0]!;
    let revenue = 0, opex = 0, capex = 0, ti = 0, leasing = 0;
    const categories: Record<string, number> = {};
    const revenueCategories: Record<string, number> = {};
    for (const r of g) {
      // NOI membership (income vs opex) comes from the contract (isNoiIncomeClass / isOpex) so it can
      // never drift from queries.ts / NOI_CLASSES. capex/ti/leasing are tracked but never in NOI.
      const cls = r.classification;
      if (isNoiIncomeClass(cls)) {
        revenue += r.amount;
        revenueCategories[r.normalizedCategory] = (revenueCategories[r.normalizedCategory] ?? 0) + r.amount;
      } else if (isOpex(cls)) {
        opex += r.amount;
        categories[r.normalizedCategory] = (categories[r.normalizedCategory] ?? 0) + r.amount;
      } else if (cls === 'capex') {
        capex += r.amount;
      } else if (cls === 'ti') {
        ti += r.amount;
      } else if (cls === 'leasing') {
        leasing += r.amount;
      }
      // else: excluded / debt-service — not in NOI, tracked nowhere here
    }
    const noi = revenue - opex;
    const sf = head.rentableSf;
    out.push({
      propertyId: head.propertyId, propertyName: head.propertyName, period: head.period,
      grainHint: head.grainHint, basis: head.basis ?? 'unknown', rentableSf: sf, ownershipPct: head.ownershipPct,
      revenue, opex, noi,
      noiMargin: revenue !== 0 ? noi / revenue : null,
      expenseRatio: revenue !== 0 ? opex / revenue : null,
      capex, ti, leasing, categories, revenueCategories,
      revenuePerSf: perSf(revenue, sf), noiPerSf: perSf(noi, sf), expensePerSf: perSf(opex, sf),
      taxesPerSf: 'Taxes' in categories ? perSf(categories['Taxes']!, sf) : null,
      insurancePerSf: 'Insurance' in categories ? perSf(categories['Insurance']!, sf) : null,
      repairsPerSf: 'Repairs & Maintenance' in categories ? perSf(categories['Repairs & Maintenance']!, sf) : null,
      oxfordNoi: noi * head.ownershipPct,
    });
  }
  return out.sort((a, b) => a.propertyId.localeCompare(b.propertyId) || a.period.localeCompare(b.period));
}
