import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PortfolioSnapshot, MacroSnapshot, Property } from '../../src/contracts/index';
import { buildAnalytics } from '../../src/analytics/engine';
import { fmtUsdCompact, fmtPct } from '../../src/analytics/format';
import { evaluateConditions, extractDgs5MarketRate } from '../../src/analytics/conditions';
import { loadStateChecked, saveState, diffCriticalAlerts, shouldSendBrief, etNow, type AlertState } from './state';
import { renderBrief, renderAlert, type Email } from './render';
import { sendEmail, type SendResult } from './send';
import { openWarehouseReadOnly } from '../warehouse/db';
import { insuranceConditions, insuranceWarehouseDriftConditions, fetchCurrentInsuranceRows } from '../warehouse/insurance-conditions';
import { DAY_MS } from '../warehouse/time-constants';
import { dscrIncompleteRows, GOVERNOR_INPUT_FIELDS, GOVERNOR_INPUT_LABEL } from '../../src/analytics/governor-inputs';
import { portfolioNoiText } from '../ai/debt-basis-copy';
import { isInvestmentProperty } from '../../src/analytics/property-basis';
import { pfCrosscheckInsights } from '../property-financials/crosscheck-insights';
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
// Resolved per write (not at import) so a test or caller can redirect it after the module loads.
const healthPath = (): string => process.env.BRIEF_HEALTH_PATH ?? 'data/brief-health.json';

/** Daily-brief DSCR line: the lowest workbook DSCR, plus the rows whose blank NOI / Debt Service leave
 *  the DSCR picture incomplete (audit 2026-11-12 HIGH #2: a nulled 0x cell must not vanish silently). */
export function briefDscrSummary(properties: readonly Property[]): string {
  const dscrs = properties.map((p) => p.dscr).filter((d): d is number => d !== null);
  const base = dscrs.length ? `min ${Math.min(...dscrs).toFixed(2)}x` : '—';
  const gaps = dscrIncompleteRows(properties.filter(isInvestmentProperty));
  if (gaps.length === 0) return base;
  const fields = GOVERNOR_INPUT_FIELDS.filter((f) => gaps.some((r) => r.fields.includes(f))).map((f) => GOVERNOR_INPUT_LABEL[f]).join('/');
  return `${base} · incomplete: blank ${fields} on ${gaps.length} row${gaps.length === 1 ? '' : 's'}`;
}

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
  const { state, recovered: stateRecovered }: { state: AlertState; recovered: boolean } = loadStateChecked(deps.statePath);
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

  // ── Property Financials cross-checks (tax timing, insurance tracker vs ledger) ─────────────────────
  // Fail-open and fail-loud inside pfCrosscheckInsights: a stale/unreadable dataset yields one warning,
  // never findings. All warning/info, so nothing here reaches the per-critical alert email below.
  insights.push(...(await pfCrosscheckInsights(snapshot, now)));

  const criticalIds = insights.filter((i) => i.severity === 'critical').map((i) => i.id);
  const { toAlert, nextAlerted, nextClearStreaks } = diffCriticalAlerts(criticalIds, state);

  let alertsSent = 0;
  const failures: string[] = [];
  // Ids whose send FAILED must not be persisted as alerted, or they are never retried.
  const failedToSend = new Set<string>();
  // The alert state file was corrupt and had to be reset: every open critical looks "new", and
  // emailing all of them would be a duplicate storm. Record them as alerted WITHOUT sending, and
  // surface the event in the health record so it is visible. A critical that genuinely appears in a
  // later run is still alerted normally.
  if (stateRecovered) {
    // Persist the recovery NOW. The corrupt file was already moved aside, so if anything below throws
    // (analytics, render, a crash) before the normal save at the end of the run, the next run would find
    // no file, look like a first run, and email every open critical: the storm this guards against.
    saveState({ ...state, alertedCriticalIds: nextAlerted, clearStreaks: nextClearStreaks }, deps.statePath);
    if (toAlert.length > 0) {
      failures.push(`alert state file was corrupt and reset; suppressed ${toAlert.length} duplicate critical alert email(s) this run (a *.corrupt-* copy was kept next to the state file)`);
    }
  }
  for (const id of stateRecovered ? [] : toAlert) {
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
    const dealCounts = countByStage(snapshot);
    const criticalDates = upcomingDates(snapshot, a.criticalDates, refDate);

    // Cell type has { value: number | null, prov } — no .display field.
    // Use formatters directly on .value.
    // Ratified 2026-09-23: the value KPI is investment-only; the residence is reported beside it as
    // other holdings so the emailed figure reconciles to the workbook's Portfolio Total.
    const otherHoldings = a.kpis.otherHoldingsCount.value
      ? ` · +${fmtUsdCompact(a.kpis.otherHoldingsValue.value)} other holdings (residence)`
      : '';
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
          noi: portfolioNoiText(a.kpis),
          value: fmtUsdCompact(a.kpis.value.value) + otherHoldings,
          occupancy: fmtPct(a.kpis.occupancy.value),
          cash: fmtUsdCompact(snapshot.cash.totalCash),
          dscrSummary: briefDscrSummary(snapshot.properties),
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
    mkdirSync(dirname(healthPath()), { recursive: true });
    writeFileSync(healthPath(), JSON.stringify(h, null, 2));
  } catch {
    /* non-fatal */
  }
}
