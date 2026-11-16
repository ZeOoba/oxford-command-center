// server/property-financials/crosscheck-insights.ts
//
// Brief-facing wrapper for the PF cross-checks that produce Insights (tax timing, insurance tracker vs
// ledger). The snapshot tie-out is a report (scripts/reconcile-pf.ts), not an alert, so it is not here.
//
// FAIL-OPEN and FAIL-LOUD, the same contract as the warehouse insurance conditions in server/brief/run.ts:
//   - dataset 'missing' (mirror, fresh worktree): skipped with a console warning, no insight (the
//     existsSync-guarded warehouse path behaves the same);
//   - dataset unreadable / invalid / stale / loader throws: ONE warning insight naming the reason, and NO
//     findings. Findings computed from an old or unparseable dataset would read as current fact.
// All emitted insights are warning/info, so none reaches the per-critical alert email path.
import type { Insight } from '../../src/analytics/types';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { insuranceLedgerInsights, insuranceLedgerRows, policyEntityResolver, type LedgerPolicy } from './insurance-ledger';
import { loadPropertyFinancials, type PfLoadResult } from './loader';
import { propertyFinancialsDir } from './config';
import { ENTITY_TO_CANONICAL } from './mapping';
import { taxTimingInsights, taxTimingRows } from './tax-timing';

export const PF_CROSSCHECKS_UNAVAILABLE_ID = 'brief-pf-crosschecks-unavailable';
export const PF_TAX_UNAVAILABLE_ID = 'brief-pf-tax-timing-unavailable';
export const PF_INSURANCE_UNAVAILABLE_ID = 'brief-pf-insurance-ledger-unavailable';

type Loader = (dir: string, now: Date) => Promise<PfLoadResult>;

const unavailable = (reason: string, id = PF_CROSSCHECKS_UNAVAILABLE_ID, what = 'the tax-timing and insurance tracker-vs-ledger checks'): Insight => ({
  id,
  severity: 'warning',
  category: 'data',
  title: id === PF_CROSSCHECKS_UNAVAILABLE_ID ? 'Property Financials cross-checks unavailable this run' : 'A Property Financials cross-check failed this run',
  detail: `${id === PF_CROSSCHECKS_UNAVAILABLE_ID ? 'The PF dataset could not be used for' : 'The PF dataset loaded, but'} ${what} (${reason}). ${id === PF_CROSSCHECKS_UNAVAILABLE_ID ? 'Those alerts were' : 'That check was'} not evaluated this run.`,
  impactAnnualUsd: null,
  spine: 'B',
  provenance: 'absent',
});

export async function pfCrosscheckInsights(
  snapshot: Pick<PortfolioSnapshot, 'properties' | 'insurance'>,
  now: Date,
  dir: string = propertyFinancialsDir(),
  load: Loader = loadPropertyFinancials,
): Promise<Insight[]> {
  try {
    const res = await load(dir, now);
    if (res.availability === 'missing') {
      console.warn('brief: PF cross-checks skipped — no Property Financials dataset on this machine');
      return [];
    }
    if (res.availability !== 'ok' || !res.dataset || !res.meta) {
      return [unavailable(res.readError ?? `dataset ${res.availability}`)];
    }
    // The loader serves its last-good copy when a later refresh fails and records that in readError. The brief
    // would then be alerting on data it knows it could not refresh, so it is treated like an unreadable one.
    if (res.readError) {
      return [unavailable(`the dataset could not be refreshed: ${res.readError}`)];
    }
    if (res.meta.staleness === 'stale') {
      return [unavailable(res.meta.stalenessReason ?? 'dataset is stale')];
    }

    const ds = res.dataset;
    const toCanonical = (entity: string): string | null => ENTITY_TO_CANONICAL[entity]?.id ?? null;
    const names = new Map(snapshot.properties.map((p) => [p.id, p.name] as const));
    const nameOf = (id: string, entity: string): string => names.get(id) ?? entity;
    // PF is a 100%-basis dataset: alert dollars are the ORA share (oxfordOwnPct from the snapshot).
    const owns = new Map(snapshot.properties.map((p) => [p.id, p.oxfordOwnPct ?? 1] as const));
    const ownOf = (id: string): number => owns.get(id) ?? 1;

    const year = ds.meta.as_of.slice(0, 4);
    const ytdMonths = Number(ds.meta.as_of.slice(5, 7));
    // Each check is contained on its own: one bad row in the insurance tracker must not silence the tax check.
    const out: Insight[] = [];
    try {
      out.push(...taxTimingInsights(taxTimingRows(ds.history, year, ytdMonths), toCanonical, nameOf, ownOf));
    } catch (err) {
      out.push(unavailable(err instanceof Error ? err.message : String(err), PF_TAX_UNAVAILABLE_ID, 'the tax-timing check'));
    }
    try {
      out.push(
        ...insuranceLedgerInsights(
          insuranceLedgerRows(snapshot.insurance as unknown as LedgerPolicy[], ds.monthly, policyEntityResolver()),
          toCanonical,
          nameOf,
          ownOf,
        ),
      );
    } catch (err) {
      out.push(unavailable(err instanceof Error ? err.message : String(err), PF_INSURANCE_UNAVAILABLE_ID, 'the insurance tracker-vs-ledger check'));
    }
    // Code-point order, not localeCompare: the order must not depend on the host's ICU locale.
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`brief: PF cross-checks unavailable — ${reason}`);
    return [unavailable(reason)];
  }
}
