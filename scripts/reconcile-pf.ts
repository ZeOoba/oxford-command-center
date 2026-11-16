// scripts/reconcile-pf.ts — on-demand report over the three Property Financials cross-checks:
//   1. snapshot (workbook model) vs PF tie-out: NOI, square footage, loan-row LTV
//   2. YTD real estate tax vs prior-year YTD
//   3. insurance tracker vs PF ledger (stale tracker, ledger excess)
//
// WARN-ONLY by design: it describes gaps and never gates. Model NOI vs TTM actuals legitimately differ, and
// cash-basis tax/insurance timing is lumpy; a hard fail would be noise until each gap is triaged. It exits 0
// whatever it finds. It exits 1 only when an input cannot be read or the report cannot be computed (a corrupt
// snapshot or an unreadable / invalid PF dataset is not a "gap"); a MISSING PF dataset (mirror, fresh worktree)
// prints a skip notice and exits 0, like reconcile:noi-crosscheck without a warehouse.
// Reads two local files (data/snapshots/portfolio.json, data/property-financials/dataset.json; gitignored, and
// seeded from fixtures/synthetic on a checkout without real data), so it needs no workbook and no warehouse.
// It is deliberately not wired into `npm run gate`: it is a triage report, not a check.
//
// Usage: npm run reconcile:pf   (or: npx tsx scripts/reconcile-pf.ts)
import { readFileSync } from 'node:fs';
import { SNAPSHOT_PATH } from '../server/config';
import { PortfolioSnapshot } from '../src/contracts/index';
import type { PfDataset } from '../src/contracts/property-financials';
import { propertyFinancialsDir } from '../server/property-financials/config';
import { loadPropertyFinancials } from '../server/property-financials/loader';
import { tieOutSnapshotToPf } from '../server/property-financials/snapshot-tieout';
import { taxTimingRows } from '../server/property-financials/tax-timing';
import { insuranceLedgerRows, policyEntityResolver, type LedgerPolicy } from '../server/property-financials/insurance-ledger';

export interface ReportCounts {
  tieOutWarn: number;
  tieOutNm: number;
  taxFindings: number;
  insuranceFindings: number;
}

const usd = (n: number | null) => (n === null ? 'n/a' : `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`);
const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const icon = (warn: boolean) => (warn ? '⚠ WARN ' : '✓ INFO ');

export function buildReport(snapshot: PortfolioSnapshot, ds: PfDataset): { lines: string[]; counts: ReportCounts } {
  const lines: string[] = [];
  const counts: ReportCounts = { tieOutWarn: 0, tieOutNm: 0, taxFindings: 0, insuranceFindings: 0 };

  lines.push('── SNAPSHOT (workbook model) ↔ PF TIE-OUT ───────────────────────────────');
  for (const r of tieOutSnapshotToPf(snapshot, ds)) {
    if (r.severity === 'warn') counts.tieOutWarn++;
    if (r.status === 'n/m') counts.tieOutNm++;
    const label = `${r.check.padEnd(3)} ${r.name.slice(0, 40).padEnd(40)}`;
    const vals =
      r.status === 'n/m'
        ? 'n/m'
        : r.check === 'ltv'
          ? `property ${pct(r.snapshotValue)} · loan row ${pct(r.pfValue)}`
          : r.check === 'sf'
            ? `snapshot ${r.snapshotValue?.toLocaleString('en-US')} · PF ${r.pfValue?.toLocaleString('en-US')}`
            : `snapshot ${usd(r.snapshotValue)} · PF ${usd(r.pfValue)} (${pct(r.deltaPct)})`;
    lines.push(`${icon(r.severity === 'warn')} ${label} ${vals} · ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
  }

  lines.push('── TAX TIMING: YTD real estate tax vs prior-year YTD (PF 100% basis) ────');
  const year = ds.meta.as_of.slice(0, 4);
  for (const r of taxTimingRows(ds.history, year, Number(ds.meta.as_of.slice(5, 7)))) {
    const finding = r.kind === 'drop' || r.kind === 'rise';
    if (finding) counts.taxFindings++;
    const vals = r.kind === 'n/m' ? 'n/m' : `${usd(r.ytd)} vs ${usd(r.priorYtd)} (${pct(r.pct)}, ${r.months} mo) · ${r.kind}`;
    const quiet = r.quietMonths.length ? ` — no tax posted ${r.quietMonths.join(', ')}` : '';
    // A drop is the warning (possible missing installment); a rise is informational, as in the brief.
    lines.push(`${icon(r.kind === 'drop')} ${r.entity.padEnd(18)} ${vals}${r.reason ? ` — ${r.reason}` : ''}${quiet}`);
  }

  lines.push('── INSURANCE: tracker vs PF ledger (PF 100% basis) ──────────────────────');
  for (const r of insuranceLedgerRows(snapshot.insurance as unknown as LedgerPolicy[], ds.monthly, policyEntityResolver())) {
    const finding = r.kind === 'stale-tracker' || r.kind === 'excess-ledger';
    if (finding) counts.insuranceFindings++;
    let vals: string = r.kind;
    if (r.kind === 'stale-tracker') vals = `stale-tracker (${r.evidence}): lapsed ${r.lapsedExpires}, ${usd(r.posted)} posted ${r.postedMonths.join(', ')}`;
    if (r.kind === 'excess-ledger') {
      vals = r.staggeredTerms
        ? `excess-ledger (needs review, staggered policy terms): ${r.ratio!.toFixed(2)}x`
        : `excess-ledger: T12 ${usd(r.ledgerT12)} vs tracker ${usd(r.trackerPremium)} (${r.ratio!.toFixed(2)}x)`;
    }
    // A stale tracker is informational (companion to the existing lapse alert). Excess is the warning, except at a
    // staggered-term location: there it is info for review with no dollar figures, as in the brief's insight.
    lines.push(`${icon(r.kind === 'excess-ledger' && !r.staggeredTerms)} ${r.entity.padEnd(18)} ${vals}${r.reason ? ` — ${r.reason}` : ''}`);
  }

  lines.push('──────────────────────────────────────────────────────────────────────');
  lines.push(
    `tie-out: ${counts.tieOutWarn} warning(s), ${counts.tieOutNm} n/m · tax timing: ${counts.taxFindings} finding(s) · insurance: ${counts.insuranceFindings} finding(s)`,
  );
  lines.push('warn-only: this report describes gaps and never gates. Cash-basis timing is lumpy; confirm against bills and binders.');
  return { lines, counts };
}

async function main(): Promise<void> {
  const snapshot = PortfolioSnapshot.parse(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')));
  const res = await loadPropertyFinancials(propertyFinancialsDir(), new Date());
  if (res.availability === 'missing') {
    console.warn(`reconcile:pf — skipped: no PF dataset at ${propertyFinancialsDir()}`);
    return;
  }
  if (res.availability !== 'ok' || !res.dataset) {
    // Unreadable or invalid is NOT a gap to report: the report cannot be produced, so say so and fail.
    console.error(`reconcile:pf — PF dataset ${res.availability}${res.readError ? ` (${res.readError})` : res.issues?.length ? ` (${String(res.issues[0])})` : ''} at ${propertyFinancialsDir()}`);
    process.exit(1);
  }
  if (res.meta?.staleness === 'stale') {
    console.warn(`reconcile:pf — WARNING: PF dataset is stale (${res.meta.stalenessReason}); findings below describe old data.`);
  }
  console.log(`→ snapshot as of ${snapshot.meta.asOf} · PF dataset ${res.dataset.meta.version} as of ${res.dataset.meta.as_of}`);
  for (const l of buildReport(snapshot, res.dataset).lines) console.log(l);
}

if (process.argv[1] && /reconcile-pf\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err) => {
    console.error(`reconcile:pf — failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
