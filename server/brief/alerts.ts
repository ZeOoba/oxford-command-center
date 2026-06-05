import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { Insight } from '../../src/analytics/types';
import { evaluateConditions } from '../../src/analytics/conditions';

const DAY_MS = 86_400_000;
function daysUntil(iso: string, asOf: string): number {
  return Math.round((new Date(iso).getTime() - new Date(asOf).getTime()) / DAY_MS);
}

/** Base insights plus brief-only extensions. priorStages: dealId -> stage at last brief. */
export function extendedInsights(s: PortfolioSnapshot, priorStages: Record<string, string>): Insight[] {
  const out: Insight[] = [...evaluateConditions(s)];
  const asOf = s.meta.asOf;

  // DSCR covenant watch — distress signal only (high LTV is often by design, excluded).
  for (const p of s.properties) {
    if (p.dscr !== null && p.dscr < 1.25) {
      out.push({
        id: `dscr-${p.id}`, severity: 'warning', category: 'debt',
        title: `DSCR below 1.25 — ${p.name}`,
        detail: `Debt-service coverage is ${p.dscr.toFixed(2)}x (covenant watch). Review the loan.`,
        metric: `${p.dscr.toFixed(2)}x`, entityType: 'property', entityId: p.id,
      });
    }
  }

  // 91–180 day lease heads-up (info tier; the <=90d warning lives in evaluateConditions).
  for (const l of s.leases) {
    if (l.monthsToExpiry !== null && l.monthsToExpiry > 3 && l.monthsToExpiry <= 6) {
      out.push({
        id: `lease180-${l.id}`, severity: 'info', category: 'lease',
        title: `Lease expiring in <6 months — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} expires ${l.leaseEnd ?? ''}. Begin renewal planning.`,
        entityType: 'lease', entityId: l.id,
      });
    }
  }

  // LOI/PSA deadline within 14 days for deals in the LOI/PSA stage.
  for (const d of s.deals) {
    if (d.stage === 'LOI/PSA' && d.targetCloseDate) {
      const days = daysUntil(d.targetCloseDate, asOf);
      if (days >= 0 && days <= 14) {
        out.push({
          id: `loi-${d.id}`, severity: 'warning', category: 'deal',
          title: `LOI/PSA deadline — ${d.shortName ?? d.name}`,
          detail: `Target close ${d.targetCloseDate} (${days}d). ${d.nextAction ?? 'Confirm next step.'}`,
          metric: `${days}d`, entityType: 'deal', entityId: d.id,
        });
      }
    }
  }

  // Deal-stage movement since last brief. Empty priorStages = first run → baseline, no noise.
  if (Object.keys(priorStages).length > 0) {
    for (const d of s.deals) {
      const from = priorStages[d.id];
      if (from !== undefined && from !== d.stage) {
        out.push({
          id: `move-${d.id}`, severity: 'info', category: 'deal',
          title: `Deal advanced — ${d.shortName ?? d.name}`,
          detail: `${from} → ${d.stage}. ${d.nextAction ?? ''}`.trim(),
          entityType: 'deal', entityId: d.id,
        });
      }
    }
  }

  const rank: Record<Insight['severity'], number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
