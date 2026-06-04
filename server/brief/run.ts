import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { buildAnalytics } from '../../src/analytics/engine';
import { fmtUsdCompact, fmtPct } from '../../src/analytics/format';
import { extendedInsights } from './alerts';
import { loadState, saveState, diffCriticalAlerts, shouldSendBrief, etNow, type AlertState } from './state';
import { renderBrief, renderAlert, type Email } from './render';
import { sendEmail, type SendResult } from './send';

const DAY_MS = 86_400_000;
const RECIPIENTS = ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'];
const DASHBOARD_URL = process.env.BRIEF_DASHBOARD_URL ?? 'https://ora-command-center.pages.dev';
const HEALTH_PATH = process.env.BRIEF_HEALTH_PATH ?? 'data/brief-health.json';

export interface RunDeps {
  statePath?: string;
  now?: Date;
  send?: (email: Email, to: string[]) => Promise<SendResult>;
}

export async function runBrief(
  snapshot: PortfolioSnapshot,
  deps: RunDeps = {},
): Promise<{ briefSent: boolean; alertsSent: number }> {
  const now = deps.now ?? new Date();
  const send = deps.send ?? ((e: Email, to: string[]) => sendEmail(e, to));
  const state: AlertState = loadState(deps.statePath);

  const insights = extendedInsights(snapshot, state.dealStages);
  const criticalIds = insights.filter((i) => i.severity === 'critical').map((i) => i.id);
  const { toAlert, nextAlerted } = diffCriticalAlerts(criticalIds, state);

  let alertsSent = 0;
  const failures: string[] = [];
  for (const id of toAlert) {
    const ins = insights.find((i) => i.id === id)!;
    const r = await send(renderAlert(ins), RECIPIENTS);
    if (r.ok) alertsSent++;
    else failures.push(`alert ${id}: ${r.error ?? r.via}`);
  }

  const nowEt = etNow(now);
  let briefSent = false;
  if (shouldSendBrief(state, nowEt)) {
    const a = buildAnalytics(snapshot, 'Base');
    const dscrs = snapshot.properties.map((p) => p.dscr).filter((d): d is number => d !== null);
    const dealCounts = countByStage(snapshot);
    const criticalDates = upcomingDates(snapshot, a.criticalDates);

    // Cell type has { value: number | null, prov } — no .display field.
    // Use formatters directly on .value.
    const r = await send(
      renderBrief({
        asOf: snapshot.meta.asOf,
        freshness: snapshot.dataQuality.length ? `${snapshot.dataQuality.length} data-quality flag(s)` : 'no data-quality flags',
        insights,
        criticalDates,
        dealCounts,
        kpis: {
          noi: fmtUsdCompact(a.kpis.noi.value),
          value: fmtUsdCompact(a.kpis.value.value),
          occupancy: fmtPct(a.kpis.occupancy.value),
          cash: fmtUsdCompact(snapshot.cash.totalCash),
          dscrSummary: dscrs.length ? `min ${Math.min(...dscrs).toFixed(2)}x` : '—',
        },
        tasks: snapshot.tasks
          .filter((t) => t.status === 'overdue' || t.status === 'pending')
          .slice(0, 12)
          .map((t) => ({ label: t.label, status: t.status })),
        dashboardUrl: DASHBOARD_URL,
      }),
      RECIPIENTS,
    );

    if (r.ok) {
      briefSent = true;
      state.lastBriefDate = nowEt.date;
      state.dealStages = Object.fromEntries(snapshot.deals.map((d) => [d.id, d.stage]));
    } else {
      failures.push(`brief: ${r.error ?? r.via}`);
    }
  }

  state.alertedCriticalIds = nextAlerted;
  saveState(state, deps.statePath);
  writeHealth({ ranAt: now.toISOString(), briefSent, alertsSent, failures });
  return { briefSent, alertsSent };
}

function countByStage(s: PortfolioSnapshot): { stage: string; count: number }[] {
  const m = new Map<string, number>();
  for (const d of s.deals) m.set(d.stage, (m.get(d.stage) ?? 0) + 1);
  return [...m.entries()].map(([stage, count]) => ({ stage, count }));
}

/** Forward calendar (<=90d): lease dates + loan maturities + deal target-close dates. */
function upcomingDates(
  s: PortfolioSnapshot,
  leaseDates: { date: string; daysToDate: number; kind: string; tenant: string }[],
): { date: string; label: string; days: number }[] {
  const fromLeases = leaseDates
    .filter((c) => c.daysToDate >= 0 && c.daysToDate <= 90)
    .map((c) => ({ date: c.date, label: `${c.kind}: ${c.tenant}`, days: c.daysToDate }));

  const fromLoans = s.loans
    .filter((l) => l.maturity && l.monthsToMaturity !== null && l.monthsToMaturity >= 0 && l.monthsToMaturity <= 3)
    .map((l) => ({
      date: l.maturity as string,
      label: `Loan maturity: ${l.name}`,
      days: Math.round((l.monthsToMaturity ?? 0) * 30),
    }));

  const fromDeals = s.deals
    .filter((d) => d.targetCloseDate)
    .map((d) => ({
      date: d.targetCloseDate as string,
      label: `Target close: ${d.shortName ?? d.name}`,
      days: Math.round(
        (new Date(d.targetCloseDate as string).getTime() - new Date(s.meta.asOf).getTime()) / DAY_MS,
      ),
    }))
    .filter((x) => x.days >= 0 && x.days <= 90);

  return [...fromLeases, ...fromLoans, ...fromDeals].sort((a, b) => a.days - b.days);
}

function writeHealth(h: object): void {
  try {
    mkdirSync(dirname(HEALTH_PATH), { recursive: true });
    writeFileSync(HEALTH_PATH, JSON.stringify(h, null, 2));
  } catch {
    /* non-fatal */
  }
}
