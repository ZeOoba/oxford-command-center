import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PortfolioSnapshot, MacroSnapshot } from '../../src/contracts/index';
import { buildAnalytics } from '../../src/analytics/engine';
import { fmtUsdCompact, fmtPct } from '../../src/analytics/format';
import { evaluateConditions, extractDgs5MarketRate } from '../../src/analytics/conditions';
import { loadState, saveState, diffCriticalAlerts, shouldSendBrief, etNow, type AlertState } from './state';
import { renderBrief, renderAlert, type Email } from './render';
import { sendEmail, type SendResult } from './send';
import { openWarehouseReadOnly } from '../warehouse/db';
import { insuranceConditions, insuranceWarehouseDriftConditions, fetchCurrentInsuranceRows } from '../warehouse/insurance-conditions';
import { DAY_MS } from '../warehouse/time-constants';
import { referenceDate, WORKBOOK_AS_OF } from '../config';

/** Workbook DATA month as "Mon YYYY" (e.g. "Jun 2026"), for the brief header freshness label. */
function workbookDataMonth(): string {
  const d = new Date(WORKBOOK_AS_OF);
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
}
// Routing canon: all automated outputs → ggoldberg only. The cc-Eric exception belongs to
// the ora-am-brief ONLY and does not extend to this brief (Gabriel-ratified 2026-07-09).
const ALERT_RECIPIENTS = ['ggoldberg@oxfordra.net'];
const BRIEF_RECIPIENTS = ['ggoldberg@oxfordra.net'];
const DASHBOARD_URL = process.env.BRIEF_DASHBOARD_URL ?? 'https://ora-command-center.pages.dev';
const HEALTH_PATH = process.env.BRIEF_HEALTH_PATH ?? 'data/brief-health.json';

export interface RunDeps {
  statePath?: string;
  now?: Date;
  send?: (email: Email, to: string[]) => Promise<SendResult>;
  /**
   * Optional macro provider. When supplied, the brief pipeline extracts the live DGS10 rate
   * and threads it into evaluateConditions as cachedMarketRate, making the refi-spread signal
   * use the current rate rather than the 0.065 fallback. Fail-open: any error is swallowed
   * and the fallback is used. (M3)
   */
  macroProvider?: () => Promise<MacroSnapshot | null>;
}

export async function runBrief(
  snapshot: PortfolioSnapshot,
  deps: RunDeps = {},
): Promise<{ briefSent: boolean; alertsSent: number }> {
  const now = deps.now ?? new Date();
  const send = deps.send ?? ((e: Email, to: string[]) => sendEmail(e, to));
  const state: AlertState = loadState(deps.statePath);
  const nowEt = etNow(now);
  // Day-count / "As of" reference = the RUN date (ET send date; REPORT_DATE-pinnable), NOT
  // snapshot.meta.asOf — the frozen workbook data date pinned the body dateline and every
  // "expires/matures in Nd" at 2026-06-01 (frozen-dateline defect; the 2026-07-09 incident
  // fixed the subject only). The workbook data date still governs data-month selection in parse.
  const refDate = referenceDate(nowEt.date);

  // M3: Resolve effective market rate from the macro snapshot (no live HTTP inside evaluateConditions).
  // Fail-open: if macroProvider is absent or throws, cachedMarketRate is undefined → 0.065 fallback.
  let cachedMarketRate: number | undefined;
  if (deps.macroProvider) {
    try {
      const macro = await deps.macroProvider().catch(() => null);
      if (macro) cachedMarketRate = extractDgs5MarketRate(macro) ?? undefined;
    } catch {
      // Fail-open: macro unavailable → use the 0.065 fallback rate in evaluateConditions.
    }
  }

  const insights = evaluateConditions(snapshot, {
    priorStages: state.dealStages,
    cachedMarketRate,
    referenceDate: refDate,
  });

  // ── Warehouse-backed insurance conditions (Phase 5) ───────────────────────
  // Guarded: any warehouse-open or read failure silently skips insurance alerts
  // so the brief never fails because the warehouse is absent on a mirror.
  // Read-only open (2026-09-21 sweep): this path only reads, and openWarehouse applied pending
  // migrations to the live warehouse as a side effect. A stale schema now throws into the fail-open
  // catch below (insurance alerts skipped) instead of being migrated by the brief; the dev server on
  // main is the sanctioned migrator. The existsSync guard is kept: it skips cleanly on fresh
  // worktrees/mirrors where no warehouse exists at all.
  // The DB is opened locally and closed in the finally block.
  try {
    const warehousePath =
      process.env['WAREHOUSE_DB'] ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
    if (existsSync(warehousePath)) {
      const wdb = openWarehouseReadOnly(warehousePath);
      try {
        // Fetched ONCE and shared with both conditions below (2026-08-21 fix) — they used to
        // each run their own full property_insurance_policies scan + collapseToCurrentTerm pass
        // over nearly the same rows on every runBrief call.
        const currentInsuranceRows = fetchCurrentInsuranceRows(wdb);
        const insInsights = insuranceConditions(wdb, snapshot, refDate, currentInsuranceRows);
        // Merge BEFORE criticalIds filter so insurance-expiry criticals flow into alert path.
        insights.push(...insInsights);
        // Warehouse-vs-live-workbook cross-check (insurance-warehouse-drift). Reads the SAME
        // wdb handle and runs on the SAME cadence/trigger as insuranceConditions above — both
        // execute every runBrief call, which is what ora-cc-snapshot-refresh's weekly Monday
        // 06:15 ET regeneration of data/snapshots/portfolio.json ultimately feeds. Merged into
        // the same `insights` array (all severity 'warning', so it rides the existing brief
        // digest / Notion Ops Hub path rather than the immediate per-critical alert email) —
        // no new notification channel.
        insights.push(...insuranceWarehouseDriftConditions(wdb, snapshot, refDate, currentInsuranceRows));
      } finally {
        wdb.close();
      }
    }
  } catch (err) {
    // Fail-open: warehouse unavailable (mirror, fresh worktree, stale schema, etc.) → skip the
    // insurance alerts, but NOT silently. Since the read-only open (2026-09-21) a warehouse that is
    // behind the schema throws here instead of being migrated by the brief, and a bare catch would
    // let insurance-expiry criticals age out through the clear-streaks with no evidence. A warning
    // insight rides the existing digest / Ops Hub path (no new channel, no alert email).
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`brief: insurance conditions unavailable — ${reason}`);
    insights.push({
      id: 'brief-insurance-conditions-unavailable',
      severity: 'warning',
      category: 'data',
      title: 'Insurance alerts unavailable this run',
      detail: `The warehouse could not be read for insurance conditions (${reason}). Expiry and drift alerts were not evaluated this run.`,
      impactAnnualUsd: null,
      spine: 'B',
      provenance: 'absent',
    });
  }

  const criticalIds = insights.filter((i) => i.severity === 'critical').map((i) => i.id);
  const { toAlert, nextAlerted, nextClearStreaks } = diffCriticalAlerts(criticalIds, state);

  let alertsSent = 0;
  const failures: string[] = [];
  // Ids whose send FAILED must not be persisted as alerted, or they are never retried.
  const failedToSend = new Set<string>();
  for (const id of toAlert) {
    const ins = insights.find((i) => i.id === id)!;
    const r = await send(renderAlert(ins), ALERT_RECIPIENTS);
    if (r.ok) alertsSent++;
    else {
      failures.push(`alert ${id}: ${r.error ?? r.via}`);
      failedToSend.add(id);
    }
  }

  let briefSent = false;
  if (shouldSendBrief(state, nowEt)) {
    const a = buildAnalytics(snapshot, 'Base', refDate);
    const dscrs = snapshot.properties.map((p) => p.dscr).filter((d): d is number => d !== null);
    const dealCounts = countByStage(snapshot);
    const criticalDates = upcomingDates(snapshot, a.criticalDates, refDate);

    // Cell type has { value: number | null, prov } — no .display field.
    // Use formatters directly on .value.
    const r = await send(
      renderBrief({
        asOf: refDate,
        briefDate: nowEt.date,
        dataMonth: workbookDataMonth(),
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
      BRIEF_RECIPIENTS,
    );

    if (r.ok) {
      briefSent = true;
      state.lastBriefDate = nowEt.date;
      state.dealStages = Object.fromEntries(snapshot.deals.map((d) => [d.id, d.stage]));
    } else {
      failures.push(`brief: ${r.error ?? r.via}`);
    }
  }

  // Drop ids whose alert never actually went out, so the next run re-attempts them. Recording
  // a failed send as "alerted" silently loses it forever — and the confirm-clear retention
  // added alongside this removed the accidental flap-out-and-back retry that used to mask it.
  // Erring toward a duplicate email is correct here; erring toward silence is not.
  state.alertedCriticalIds = nextAlerted.filter((id) => !failedToSend.has(id));
  state.clearStreaks = nextClearStreaks;
  saveState(state, deps.statePath);
  writeHealth({ ranAt: now.toISOString(), briefSent, alertsSent, failures });
  return { briefSent, alertsSent };
}

function countByStage(s: PortfolioSnapshot): { stage: string; count: number }[] {
  const m = new Map<string, number>();
  for (const d of s.deals) m.set(d.stage, (m.get(d.stage) ?? 0) + 1);
  return [...m.entries()].map(([stage, count]) => ({ stage, count }));
}

/** Forward calendar (<=90d): lease dates + loan maturities + deal target-close dates.
 *  `refDate` is the run-date day-count reference for every row, including loan maturities
 *  (computed from the maturity DATE, not the frozen workbook monthsToMaturity column). */
function upcomingDates(
  s: PortfolioSnapshot,
  leaseDates: { date: string; daysToDate: number; kind: string; tenant: string }[],
  refDate: string,
): { date: string; label: string; days: number }[] {
  const fromLeases = leaseDates
    .filter((c) => c.daysToDate >= 0 && c.daysToDate <= 90)
    .map((c) => ({ date: c.date, label: `${c.kind}: ${c.tenant}`, days: c.daysToDate }));

  // Countdown off the run date from the maturity DATE (run-date-relative, consistent with lease
  // expiry) — NOT the frozen workbook monthsToMaturity column, which pinned the "Nd" to the data
  // date. Demand loans (no maturity date) are excluded.
  const fromLoans = s.loans
    .filter((l) => l.maturity && !l.isDemand)
    .map((l) => ({
      date: l.maturity as string,
      label: `Loan maturity: ${l.name}`,
      days: Math.round((new Date(l.maturity as string).getTime() - new Date(refDate).getTime()) / DAY_MS),
    }))
    .filter((x) => x.days >= 0 && x.days <= 90);

  const fromDeals = s.deals
    .filter((d) => d.targetCloseDate)
    .map((d) => ({
      date: d.targetCloseDate as string,
      label: `Target close: ${d.shortName ?? d.name}`,
      days: Math.round(
        (new Date(d.targetCloseDate as string).getTime() - new Date(refDate).getTime()) / DAY_MS,
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
