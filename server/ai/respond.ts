import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { AiAskResponse } from '../../src/brain/ai/types';
import { buildAnalytics } from '../../src/analytics/engine';
import { fmtUsdCompact, fmtPct, fmtYears, fmtNum } from '../../src/analytics/format';
import { referenceDate } from '../config';

/**
 * ── AI SEAM ───────────────────────────────────────────────────────────────────
 * Deterministic, data-grounded responder. This is the single function to swap for
 * a live Claude call: feed `question` + a compact serialization of `snapshot` to
 * the Anthropic SDK (server-side, prompt-cached) and return { answer, sources }.
 * The client/UI never changes — it only knows the AiAskResponse contract.
 */
export function respond(question: string, s: PortfolioSnapshot): AiAskResponse {
  const q = question.toLowerCase().trim();
  // Run-date basis for WALT, rollover, criticalDates, revenueAtRisk, and alert day-counts.
  const a = buildAnalytics(s, 'Base', referenceDate());
  const k = a.kpis;
  const sources = new Set<string>();
  const out: string[] = [];

  const has = (...terms: string[]) => terms.some((t) => q.includes(t));

  if (!q) {
    return { answer: 'Ask me about the portfolio — risk, leases, debt, cash, tenants, or a summary.', sources: [], model: 'stub' };
  }

  if (has('risk', 'at risk', 'worry', 'attention', 'alert')) {
    sources.add('Insights engine');
    const crit = a.insights.filter((i) => i.severity === 'critical');
    const warn = a.insights.filter((i) => i.severity === 'warning');
    out.push(`There are ${a.insights.length} active alerts — ${crit.length} critical, ${warn.length} warnings.`);
    a.insights.slice(0, 5).forEach((i) => out.push(`• ${i.title} — ${i.detail}`));
    out.push(`Revenue exposed in the next 90 days: ${fmtUsdCompact(a.revenueAtRisk.within90dRent)} across expiring leases.`);
  } else if (has('balloon', 'maturit', 'refinanc')) {
    sources.add('Loan Index');
    const balloons = s.loans.filter((l) => l.balloon);
    out.push(balloons.length ? `${balloons.length} balloon(s) on the book:` : 'No balloon payments flagged.');
    balloons.forEach((l) => out.push(`• ${l.name} — ${fmtUsdCompact(l.absBalance)} due ${l.maturity ?? 'demand'} (${l.monthsToMaturity ?? '?'} mo).`));
    out.push(`Weighted avg borrower rate: ${a.debt.weightedAvgRate !== null ? fmtPct(a.debt.weightedAvgRate, 2) : '—'}; annual debt service ${fmtUsdCompact(a.debt.annualDebtService)}.`);
  } else if (has('lease', 'expir', 'renew', 'rollover', 'walt')) {
    sources.add('Master Tenant Rent Roll');
    out.push(`WALT is ${fmtYears(k.walt.value)} (rent-weighted). ${s.leases.length} leases, ${fmtUsdCompact(s.leases.reduce((x, l) => x + l.annualRent, 0))} annualized rent.`);
    out.push(`Expiring within 90 days: ${fmtUsdCompact(a.revenueAtRisk.within90dRent)}. Holding over (expired): ${fmtUsdCompact(a.revenueAtRisk.expiredRent)}.`);
    a.rollover.forEach((b) => out.push(`• ${b.period}: ${b.count} leases, ${fmtUsdCompact(b.expiringRent)} expiring.`));
  } else if (has('tenant', 'concentrat', 'hhi')) {
    sources.add('Master Tenant Rent Roll');
    out.push(`Tenant HHI is ${fmtNum(a.tenantHHI)} (revenue concentration). Top tenants:`);
    a.topTenants.slice(0, 5).forEach((t) => out.push(`• ${t.company} — ${fmtUsdCompact(t.annualRent)}/yr (${fmtPct(t.share)}).`));
  } else if (has('cash', 'liquid', 'treasur')) {
    sources.add('Cash Balances');
    out.push(`Total cash across ${s.cash.activeEntities} entities is ${fmtUsdCompact(s.cash.totalCash)}.`);
    out.push(`Largest concentration: ${s.cash.largestEntity} at ${fmtPct(s.cash.concentrationTopPct)} of total.`);
  } else if (has('debt', 'loan', 'leverage', 'ltv')) {
    sources.add('Loan Index');
    out.push(`External debt ${fmtUsdCompact(a.debt.externalDebt)} at ${a.debt.weightedAvgRate !== null ? fmtPct(a.debt.weightedAvgRate, 2) : '—'} weighted. Portfolio LTV ${fmtPct(k.ltv.value)}.`);
    out.push(`Capital deployed as lender: ${fmtUsdCompact(a.debt.lenderDeployed)}; internal accrual ${fmtUsdCompact(a.debt.internalOutstanding)}.`);
  } else {
    sources.add('Property NOI');
    out.push(`Portfolio snapshot (as of ${s.meta.asOf}):`);
    out.push(`• ${fmtNum(k.propertyCount.value)} investment properties, ${fmtNum(k.tenantCount.value)} tenants, ${fmtNum(k.totalSf.value)} SF.`);
    // Ratified 2026-09-23: investment value excludes the residence, which is REPORTED beside it as other
    // holdings (never silently dropped — the workbook's own Portfolio Total includes it).
    const other = k.otherHoldingsCount.value ? ` · +${fmtUsdCompact(k.otherHoldingsValue.value)} other holdings (residence)` : '';
    out.push(`• Value ${fmtUsdCompact(k.value.value)} (Oxford share)${other}, NOI ${fmtUsdCompact(k.noi.value)}, weighted cap ${fmtPct(k.weightedCapRate.value)}.`);
    out.push(`• Debt ${fmtUsdCompact(k.totalDebt.value)} (LTV ${fmtPct(k.ltv.value)}), cash ${fmtUsdCompact(k.totalCash.value)}, WALT ${fmtYears(k.walt.value)}.`);
    out.push(`• ${a.insights.length} active alerts.`);
  }

  out.push('\n— Deterministic preview from live data. Wire the Claude model behind /api/ai for full natural-language reasoning.');
  return { answer: out.join('\n'), sources: [...sources], model: 'stub' };
}
