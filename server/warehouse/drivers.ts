// server/warehouse/drivers.ts
// ΔNOI driver decomposition by normalized category. Each category's NOI impact is
// NOI-signed: revenue-side categories are positive, opex categories negative, and
// capex/ti/leasing/excluded are kept OUT of NOI entirely. The per-category deltas
// sum EXACTLY to ΔNOI (totalDelta is the running sum of the same deltas, so the
// invariant holds by construction, not by floating-point coincidence).
import type { PeriodMetrics } from './metrics';
// NoiDriver + NoiDecomposition are single-sourced in the contract (H6); re-export under their
// local names so existing engine imports keep working. The /analytics/drivers route wraps the
// NoiDecomposition with propertyId/from/to (DriversResponseSchema).
import type { NoiDriver, NoiDecomposition } from '../../src/contracts/warehouse';

export type { NoiDriver, NoiDecomposition };

/**
 * Signed NOI-impact map for one period: revenueCategories as positive contributions,
 * opex categories as negative. Mirrors the canon NOI = Σrevenue − Σopex (active rows).
 * capex/ti/leasing/excluded are intentionally omitted — they are not in NOI.
 */
export function noiImpactByCategory(metrics: PeriodMetrics): Record<string, number> {
  const impact: Record<string, number> = {};
  for (const [cat, amount] of Object.entries(metrics.revenueCategories)) {
    impact[cat] = (impact[cat] ?? 0) + amount;
  }
  for (const [cat, amount] of Object.entries(metrics.categories)) {
    impact[cat] = (impact[cat] ?? 0) - amount;
  }
  return impact;
}

/**
 * Decompose ΔNOI between two signed impact maps (a = earlier, b = later).
 * Union of keys; delta = (b[k] ?? 0) − (a[k] ?? 0). totalDelta is the running sum
 * of those same deltas so Σdelta === totalDelta exactly. contributionPct = delta /
 * totalDelta, null when |totalDelta| / sumAbsDelta ≤ 0.05 (low-signal ratio). Drivers ranked by |delta| desc, then category name.
 */
export function decomposeNoiChange(
  a: Record<string, number>,
  b: Record<string, number>,
): NoiDecomposition {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  let totalDelta = 0;
  const raw: Array<{ category: string; delta: number }> = [];
  for (const category of keys) {
    const delta = (b[category] ?? 0) - (a[category] ?? 0);
    totalDelta += delta;
    raw.push({ category, delta });
  }
  const sumAbsDelta = raw.reduce((s, r) => s + Math.abs(r.delta), 0);
  const meaningful = sumAbsDelta > 0 && Math.abs(totalDelta) / sumAbsDelta > 0.05;
  const drivers: NoiDriver[] = raw
    .map((r) => ({
      category: r.category,
      delta: r.delta,
      contributionPct: meaningful ? r.delta / totalDelta : null,
    }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.category.localeCompare(y.category));
  return { totalDelta, drivers };
}
