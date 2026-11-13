// server/property-financials/tax-timing.ts
//
// YTD real estate tax vs the prior-year YTD, per PM-reported entity, from the PF history block.
// Closes a gap: server/warehouse/anomalies.ts only flags category RISES, so a tax line that falls by half
// (an installment not yet paid or not yet booked, which overstates cash-basis NOI by the gap) never raised
// anything, and any such note in the PF curated insights is hand-written, not computed.
//
// Rules (partial-period discipline from src/analytics/property-financials/periods.ts):
//   - Both YTDs must cover the FULL YTD length (`ytdMonths`, the as-of month: 9 for a Sep-30 dataset), else the
//     entity is n/m. Equal-but-short (8 and 8) is still a partial period, and the two years could be missing
//     different months.
//   - A prior base of zero or missing is n/m (no percent on a zero base).
//   - Annual-only entities are emitted as n/m with a reason (no monthly series, no YTD tax).
//   - A drop needs BOTH the percent and the dollar floor; the same for a rise.
// Cash basis: tax payment timing is lumpy, so every finding is a "verify", never a conclusion.
//
// Read-only. No NOI math. The Insight is advisory (warning/info, never an email).
import type { Insight } from '../../src/analytics/types';
import type { PfDataset } from '../../src/contracts/property-financials';
import { CROSSCHECK_THRESHOLDS } from './crosscheck-config';

const TAX_CATEGORY = 'Real estate & property tax';
const EPS = 1e-9;

export type TaxTimingKind = 'drop' | 'rise' | 'ok' | 'n/m';

export interface TaxTimingRow {
  /** PF entity label (a key of the dataset's history block). */
  entity: string;
  kind: TaxTimingKind;
  year: string;
  priorYear: string;
  ytd: number | null;
  priorYtd: number | null;
  /** ytd - priorYtd (negative = tax fell). */
  delta: number | null;
  pct: number | null;
  months: number | null;
  /** Months in the current YTD with no tax posted where the same calendar month paid last year. */
  quietMonths: string[];
  reason: string | null;
}

type History = Pick<PfDataset, 'history'>['history'];

const usd = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const usdSigned = (n: number) => `${n < 0 ? '-' : ''}${usd(n)}`;

export function taxTimingRows(
  history: History,
  year: string,
  /** Months in a full YTD for this dataset (the as-of month number). */
  ytdMonths: number,
  t: Pick<typeof CROSSCHECK_THRESHOLDS, 'taxDropPct' | 'taxRisePct' | 'taxMinUsd'> = CROSSCHECK_THRESHOLDS,
): TaxTimingRow[] {
  const priorYear = String(Number(year) - 1);
  const rows: TaxTimingRow[] = [];
  for (const entity of Object.keys(history).sort()) {
    const h = history[entity as keyof History];
    if (!h) continue;
    if (!h.monthly) {
      rows.push({
        entity, kind: 'n/m', year, priorYear, ytd: null, priorYtd: null, delta: null, pct: null, months: null, quietMonths: [],
        reason: 'PF holds annual statements only for this entity, so there is no monthly YTD to compare',
      });
      continue;
    }
    const cur = h.ytd[year];
    const pri = h.ytd[priorYear];
    const base: TaxTimingRow = {
      entity, kind: 'n/m', year, priorYear, ytd: null, priorYtd: null, delta: null, pct: null,
      months: null, quietMonths: [], reason: null,
    };
    if (!cur || !pri) {
      rows.push({ ...base, reason: `no ${!cur ? year : priorYear} YTD figures` });
      continue;
    }
    if (cur.n !== ytdMonths || pri.n !== ytdMonths) {
      rows.push({
        ...base,
        reason: `YTD covers ${cur.n} months in ${year} and ${pri.n} in ${priorYear}; a full YTD is ${ytdMonths} months, and a partial period is never compared`,
      });
      continue;
    }
    const ytd = cur.cats[TAX_CATEGORY] ?? 0;
    const priorYtd = pri.cats[TAX_CATEGORY] ?? 0;
    if (!(priorYtd > 0)) {
      rows.push({
        ...base, ytd, priorYtd, months: cur.n,
        reason: `no prior-year tax base to compare against (${priorYear} YTD ${usdSigned(priorYtd)})`,
      });
      continue;
    }
    const delta = ytd - priorYtd;
    const pct = delta / priorYtd;
    let kind: TaxTimingKind = 'ok';
    if (pct <= -t.taxDropPct + EPS && -delta >= t.taxMinUsd - EPS) kind = 'drop';
    else if (pct >= t.taxRisePct - EPS && delta >= t.taxMinUsd - EPS) kind = 'rise';
    rows.push({
      ...base, kind, ytd, priorYtd, delta, pct, months: cur.n,
      quietMonths: kind === 'drop' ? quietMonths(h.months, year, priorYear) : [],
    });
  }
  return rows;
}

/** Months of `year` that posted no tax while the same calendar month of `priorYear` did. */
function quietMonths(
  months: { g: readonly string[]; tx: readonly number[] } | null,
  year: string,
  priorYear: string,
): string[] {
  if (!months) return [];
  const idx = new Map(months.g.map((m, i) => [m, i] as const));
  const out: string[] = [];
  for (const [m, i] of idx) {
    if (!m.startsWith(`${year}-`)) continue;
    const prior = idx.get(`${priorYear}-${m.slice(5)}`);
    if (prior === undefined) continue;
    if ((months.tx[i] ?? 0) <= 0 && (months.tx[prior] ?? 0) > 0) out.push(m);
  }
  return out.sort();
}

/**
 * Insights for the findings only (drop -> warning, rise -> info). `toCanonicalId` maps a PF entity label
 * to the property id (mapping.ts ENTITY_TO_CANONICAL); an entity with no canonical id is dropped rather
 * than emitted unattributed. `nameOf` only improves the title.
 */
export function taxTimingInsights(
  rows: readonly TaxTimingRow[],
  toCanonicalId: (entity: string) => string | null,
  nameOf: (entityId: string, entity: string) => string = (_id, entity) => entity,
  ownOf: (entityId: string) => number = () => 1,
): Insight[] {
  const out: Insight[] = [];
  for (const r of rows) {
    if (r.kind !== 'drop' && r.kind !== 'rise') continue;
    const id = toCanonicalId(r.entity);
    if (!id) continue;
    const name = nameOf(id, r.entity);
    // PF is a 100%-basis dataset; the dollars quoted as the NOI effect are the ORA share.
    const own = ownOf(id);
    const shareNote = own !== 1 ? ` (ORA share, ${(own * 100).toFixed(0)}% of the 100%-basis figure)` : '';
    const share = (n: number) => usd(n * own);
    const pct = `${r.pct! > 0 ? '+' : ''}${(r.pct! * 100).toFixed(0)}%`;
    const head = `Real estate tax ${r.year} YTD ${usdSigned(r.ytd!)} vs ${usd(r.priorYtd!)} in ${r.priorYear} (${pct}, ${r.months} months each), cash basis, 100% basis`;
    if (r.kind === 'drop') {
      const quiet = r.quietMonths.length ? ` No tax posted in ${r.quietMonths.join(', ')} where ${r.priorYear} paid.` : '';
      out.push({
        id: `pf-tax-drop-${id}-ytd${r.year}`,
        severity: 'warning',
        category: 'anomaly',
        title: r.ytd! < 0 ? `Tax credit booked YTD — ${name}` : `Tax down ${pct.replace('-', '')} YTD — ${name}`,
        detail:
          r.ytd! < 0
            ? `${head}. YTD tax is NEGATIVE: a refund or credit is booked, which lifts cash-basis NOI by about ${share(r.delta!)} against last year${shareNote}; confirm what it is and do not carry it into a run-rate.`
            : `${head}.${quiet} Possible missing or unbooked installment: if so, cash-basis NOI is flattered by about ${share(r.delta!)}${shareNote}; if the lease passes tax through (NNN) the NOI effect is smaller or nil. Confirm against the county bills before treating TTM as a run-rate.`,
        metric: pct,
        entityType: 'property',
        entityId: id,
        action: { label: 'Verify tax installments', kind: 'review' },
        // A YTD gap is not an annual figure, and the brief prints impactAnnualUsd as "$/yr": the dollars live in the detail.
        impactAnnualUsd: null,
        spine: 'B',
        provenance: 'derived',
      });
    } else {
      out.push({
        id: `pf-tax-rise-${id}-ytd${r.year}`,
        severity: 'info',
        category: 'anomaly',
        title: `Tax up ${pct.replace('+', '')} YTD — ${name}`,
        detail: `${head}. Check for a reassessment and the appeal window; whether the increase reaches NOI depends on whether the lease passes tax through. A one-off prior-year base can overstate the rise, so compare earlier years too.`,
        metric: pct,
        entityType: 'property',
        entityId: id,
        action: { label: 'Check assessment / appeal', kind: 'review' },
        impactAnnualUsd: null,
        spine: 'B',
        provenance: 'derived',
      });
    }
  }
  // Code-point order, not localeCompare: the order must not depend on the host's ICU locale.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
