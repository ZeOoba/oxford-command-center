// src/modules/property-financials/ScorecardView.tsx
//
// Scorecard table tab (reference artifact "PROPERTIES"): one sortable row per entity with NOI FY24 /
// FY25 / TTM, margin, base-rent run-rate YoY, opex ratio, management fee, recovery and review-item
// count; an expandable detail row with category-by-period figures, account movers, lease facts, open
// items and a base-rent sparkline. Partial periods and undefined ratios render n/m with the calc
// library's reason; there is never a YoY on a partial year.
import { Fragment, useId, useMemo, useState } from 'react';
import {
  ANNUAL_PERIODS,
  OPEX_CATEGORIES,
  PF_MONTHLY_ENTITY_IDS,
  type PfAccountMover,
  type PfDataset,
  type PfEntityId,
  type PfPeriodFigures,
  type StandardPeriodId,
} from '@contracts/property-financials';
import { partialReason, periodLabel, type MetricResult } from '@analytics/property-financials/periods';
import { DASH, pct, pctLevel, usd } from '@analytics/property-financials/format';
import { linePath, linearScale } from '@/charts/kit/geometry';
import { MetricCell, NotMeaningful, SeverityPill } from './components';
import { PropertyGaps } from './PropertyGaps';
import { cubeMonths, fmtMonth, insightsForEntity, leaseForEntity, moverComparisonPartial, scorecardRows, sortInsights, toneClass, type ScorecardRow } from './model';

interface Column {
  readonly key: string;
  readonly label: string;
  /** Ratio columns: the metric name; the header and each cell's title add the period. */
  readonly name?: string;
  readonly pick: (r: ScorecardRow) => MetricResult | number;
  readonly format: (v: number) => string;
  readonly tone?: (v: number) => string;
}

const level0 = (v: number) => pctLevel(v);
const level1 = (v: number) => pctLevel(v, 1);

/**
 * Ratio columns are TTM for monthly assets and FY2025 for annual-only ones (the Explorer's tiles use
 * the latest full year): the header names TTM, each cell's title names its own period and an
 * annual-only cell shows its period beside the value.
 */
const HEADER_RATIO_PERIOD = periodLabel('TTM26');

const COLUMNS: readonly Column[] = [
  { key: 'noiFy24', label: `NOI ${periodLabel('FY2024')}`, pick: (r) => r.noiFy24, format: (v) => usd(v) },
  { key: 'noiFy25', label: `NOI ${periodLabel('FY2025')}`, pick: (r) => r.noiFy25, format: (v) => usd(v) },
  { key: 'noiTtm', label: `NOI ${periodLabel('TTM26')}`, pick: (r) => r.noiTtm, format: (v) => usd(v) },
  { key: 'margin', name: 'NOI margin', label: `NOI margin, ${HEADER_RATIO_PERIOD}`, pick: (r) => r.margin, format: level0 },
  { key: 'runRateYoy', label: 'Base rent run-rate YoY', pick: (r) => r.runRateYoy, format: (v) => pct(v), tone: (v) => toneClass(v) },
  { key: 'opexRatio', name: 'Opex / revenue', label: `Opex / revenue, ${HEADER_RATIO_PERIOD}`, pick: (r) => r.opexRatio, format: level0 },
  { key: 'mgmtFee', name: 'Mgmt fee', label: `Mgmt fee, ${HEADER_RATIO_PERIOD}`, pick: (r) => r.mgmtFee, format: level1 },
  { key: 'recovery', name: 'Recovery', label: `Recovery, ${HEADER_RATIO_PERIOD}`, pick: (r) => r.recovery, format: level0 },
  { key: 'flags', label: 'Flags', pick: (r) => r.flags, format: (v) => (v ? String(v) : '') },
];

const valueOf = (x: MetricResult | number): number | null => (typeof x === 'number' ? x : x.value);

export function ScorecardView({ dataset: d, onOpenProperty }: { dataset: PfDataset; onOpenProperty: (entity: PfEntityId) => void }) {
  const rows = useMemo(() => scorecardRows(d), [d]);
  const [sort, setSort] = useState<{ key: string; asc: boolean } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const baseId = useId();

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = COLUMNS.find((c) => c.key === sort.key)!;
    return [...rows].sort((a, b) => {
      const x = valueOf(col.pick(a));
      const y = valueOf(col.pick(b));
      if (x === null) return y === null ? 0 : 1;
      if (y === null) return -1;
      return sort.asc ? x - y : y - x;
    });
  }, [rows, sort]);

  const toggleSort = (key: string) => setSort((s) => (s && s.key === key ? { key, asc: !s.asc } : { key, asc: false }));
  const toggleRow = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div>
      <h2>Property scorecard</h2>
      <div className="pf-note" style={{ marginBottom: 12 }}>
        Select a row for category detail, account-level movers and lease terms. Select a column heading to sort. NOI is normalized: recurring operating cost only,
        excluding capital, owner distributions, debt and entity tax.
      </div>
      <div className="pf-tbl pf-score">
        <table>
          <thead>
            <tr>
              <th scope="col">Property</th>
              {COLUMNS.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} scope="col" aria-sort={active ? (sort!.asc ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" className="pf-sort" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      {active ? (sort!.asc ? ' ↑' : ' ↓') : ''}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const isOpen = open.has(r.id);
              const detId = `${baseId}-${r.id.replace(/[^A-Za-z0-9]/g, '')}`;
              return (
                <Fragment key={r.id}>
                  <tr className="pf-row" data-entity={r.id} onClick={() => toggleRow(r.id)}>
                    <td>
                      <button
                        type="button"
                        className="pf-toggle"
                        aria-expanded={isOpen}
                        aria-controls={detId}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRow(r.id);
                        }}
                      >
                        <span className="pf-caret" aria-hidden>
                          {isOpen ? '−' : '+'}
                        </span>
                        <span className="pf-pn">
                          {r.label}
                          <small>{r.sourceNote}</small>
                        </span>
                      </button>
                    </td>
                    {COLUMNS.map((c) => {
                      const x = c.pick(r);
                      const per = c.name ? periodLabel(r.ratioPeriod) : null;
                      return (
                        <td key={c.key} data-col={c.key} title={c.name ? `${c.name}, ${per}` : undefined}>
                          {typeof x === 'number' ? c.format(x) : <MetricCell result={x} format={c.format} className={c.tone} />}
                          {per && per !== HEADER_RATIO_PERIOD ? (
                            <>
                              {' '}
                              <small className="pf-mut">{per}</small>
                            </>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                  <tr className="pf-det" id={detId} hidden={!isOpen}>
                    <td colSpan={COLUMNS.length + 1}>{isOpen && <PropertyDetail dataset={d} id={r.id} onOpenProperty={onOpenProperty} />}</td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Detail row
// -------------------------------------------------------------------------------------------------

const PERIOD_ROWS: ReadonlyArray<{ label: string; pick: (f: PfPeriodFigures) => number; bold?: boolean }> = [
  { label: 'Base rent', pick: (f) => f.base_rent },
  { label: 'Reimbursements', pick: (f) => f.reimbursements },
  { label: 'Vacancy / waivers / bad debt', pick: (f) => f.vacancy_waivers },
  { label: 'Other income', pick: (f) => f.other_income },
  { label: 'Revenue', pick: (f) => f.revenue, bold: true },
  ...OPEX_CATEGORIES.map((c) => ({ label: c, pick: (f: PfPeriodFigures) => f.opex_by[c] })),
  { label: 'Operating expense', pick: (f) => f.opex, bold: true },
  { label: 'NOI (normalized)', pick: (f) => f.noi, bold: true },
  { label: 'Capital items (below NOI)', pick: (f) => f.capex },
];

const ANNUAL_ROWS: ReadonlyArray<{ label: string; pick: (f: PfPeriodFigures) => number }> = [
  { label: 'Base rent', pick: (f) => f.base_rent },
  { label: 'Energy income', pick: (f) => f.energy_income },
  { label: 'Other income', pick: (f) => f.other_income },
  { label: 'Revenue', pick: (f) => f.revenue },
  { label: 'Operating expense', pick: (f) => f.opex },
  { label: 'NOI (normalized)', pick: (f) => f.noi },
];

/** Column order of the monthly category table (as the artifact prints it). */
const MONTHLY_DETAIL_PERIODS = ['FY2024', 'FY2025', 'TTM25', 'TTM26', 'YTD25', 'YTD26'] as const satisfies readonly StandardPeriodId[];

function CategoryTable({ dataset: d, id }: { dataset: PfDataset; id: PfEntityId }) {
  const p = d.properties[id];
  if (p.kind === 'monthly') {
    return (
      <table>
        <thead>
          <tr>
            <th scope="col">USD</th>
            {MONTHLY_DETAIL_PERIODS.map((per) => (
              <th scope="col" key={per}>
                {periodLabel(per)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERIOD_ROWS.map((row) => (
            <tr key={row.label}>
              <td>{row.bold ? <b>{row.label}</b> : row.label}</td>
              {MONTHLY_DETAIL_PERIODS.map((per) => {
                const f = p.periods[per];
                const reason = partialReason(per, f.n_months);
                if (reason) return <td key={per}>{<NotMeaningful reason={reason} />}</td>;
                const text = usd(row.pick(f));
                return <td key={per}>{row.bold ? <b>{text}</b> : text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <>
      <table>
        <thead>
          <tr>
            <th scope="col">USD</th>
            {ANNUAL_PERIODS.map((per) => (
              <th scope="col" key={per} title={partialReason(per, p.periods[per].n_months) ?? undefined}>
                {periodLabel(per)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ANNUAL_ROWS.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              {ANNUAL_PERIODS.map((per) => {
                const f = p.periods[per];
                const v = row.pick(f);
                const reason = partialReason(per, f.n_months);
                // A partial annual statement is displayed (muted, reason on hover) but never compared.
                return (
                  <td key={per} className={reason ? 'pf-mut' : undefined} title={reason ?? undefined}>
                    {v ? usd(v) : DASH}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pf-note">
        Interest expense:{' '}
        {Object.entries(p.nonop.interest_expense)
          .map(([y, v]) => `${y} ${usd(v)}`)
          .join(', ')}
        . Interest income 2026 YTD: {usd(p.nonop.interest_income_2026ytd)}. Entity income tax:{' '}
        {Object.entries(p.nonop.entity_income_tax)
          .map(([y, v]) => `${y} ${usd(v)}`)
          .join(', ')}
        . All below normalized NOI.
      </p>
    </>
  );
}

function BaseRentSpark({ dataset: d, id }: { dataset: PfDataset; id: (typeof PF_MONTHLY_ENTITY_IDS)[number] }) {
  const months = cubeMonths(d, PF_MONTHLY_ENTITY_IDS);
  const cube = d.monthly[id];
  const vals = months.map((m) => cube[m]?.base_rent ?? null);
  const present = vals.filter((v): v is number => v !== null);
  if (present.length === 0) return <div className="pf-note">No monthly base rent on file.</div>;
  const peak = Math.max(...present);
  const W = 300;
  const H = 70;
  const x = linearScale([0, Math.max(1, months.length - 1)], [4, W - 4]);
  const y = linearScale([0, peak > 0 ? peak : 1], [H - 6, 6]);
  let li = vals.length - 1;
  while (li > 0 && vals[li] === null) li--;
  const lastV = vals[li];
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 340, height: 'auto', display: 'block' }} aria-hidden>
        <path d={linePath(vals, x, y)} fill="none" stroke="var(--pf-s1)" strokeWidth={2} />
        {lastV !== null && lastV !== undefined && (
          <circle cx={x(li)} cy={y(lastV)} r={3.5} fill="var(--pf-s1)">
            <title>{`${fmtMonth(months[li]!)}: ${usd(lastV, 'f')}`}</title>
          </circle>
        )}
      </svg>
      <div className="pf-note">
        Monthly base rent, {fmtMonth(months[0]!)} to {fmtMonth(months[months.length - 1]!)}. Peak {usd(peak)}
        {lastV !== null && lastV !== undefined ? `; latest ${usd(lastV)} (${fmtMonth(months[li]!)})` : ''}.
      </div>
    </>
  );
}

function MoverTable({ title, movers, partial }: { title: string; movers: readonly PfAccountMover[]; partial: string | null }) {
  if (partial !== null) {
    return (
      <p className="pf-note" style={{ marginTop: 10 }} data-testid="pf-movers-nm">
        {title}: n/m ({partial}); a year-over-year account comparison needs both periods complete.
      </p>
    );
  }
  if (movers.length === 0) return null;
  return (
    <>
      <h4 className="pf-h4" style={{ marginTop: 10 }}>
        {title}
      </h4>
      <table>
        <tbody>
          {movers.slice(0, 6).map((m) => (
            <tr key={`${m.category}|${m.account}`}>
              <td style={{ whiteSpace: 'normal' }}>
                {m.account}
                <br />
                <span className="pf-mut">{m.category}</span>
              </td>
              <td>
                {usd(m.prior)} → {usd(m.current)}
              </td>
              <td className={toneClass(m.delta, true)}>
                {m.delta > 0 ? '+' : '-'}
                {usd(Math.abs(m.delta))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function PropertyDetail({ dataset: d, id, onOpenProperty }: { dataset: PfDataset; id: PfEntityId; onOpenProperty: (entity: PfEntityId) => void }) {
  const p = d.properties[id];
  const lease = leaseForEntity(d.leases, id);
  const items = sortInsights(insightsForEntity(d.insights, id));
  const ytdLabel = `${periodLabel('YTD26')} vs ${periodLabel('YTD25')}`;
  return (
    <div data-testid={`pf-detail-${id}`}>
      <div style={{ marginBottom: 10 }}>
        <button type="button" className="pf-btn" onClick={() => onOpenProperty(id)}>
          Open full property view
        </button>
      </div>
      <div className="pf-tbl" style={{ border: 0 }}>
        <CategoryTable dataset={d} id={id} />
      </div>
      {p.kind === 'monthly' && p.missing_months_since_2024.length > 0 && (
        <p className="pf-note">Missing monthly exports: {p.missing_months_since_2024.map(fmtMonth).join(', ')}. Periods marked n/m need all months.</p>
      )}
      <PropertyGaps dataset={d} id={id} />
      <div className="pf-mini" style={{ marginTop: 18 }}>
        <div>
          <h4 className="pf-h4">Base rent trend</h4>
          {p.kind === 'monthly' ? <BaseRentSpark dataset={d} id={p.id} /> : <div className="pf-note">No monthly detail for this entity.</div>}
          {lease && (
            <>
              <h4 className="pf-h4" style={{ marginTop: 14 }}>
                Lease
              </h4>
              <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                {lease.tenant}
                {lease.sf ? ` · ${lease.sf.toLocaleString('en-US')} SF` : ''}
                <br />
                {lease.term}
                {lease.escalator && (
                  <>
                    <br />
                    Escalator: {lease.escalator}
                  </>
                )}
                <br />
                <span className="pf-mut">Source: {lease.confidence}</span>
              </div>
            </>
          )}
          {items.length > 0 && (
            <>
              <h4 className="pf-h4" style={{ marginTop: 14 }}>
                Open items
              </h4>
              {items.map((i) => (
                <div key={i.id} style={{ margin: '6px 0', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <SeverityPill severity={i.severity} /> <span>{i.title}</span>
                </div>
              ))}
            </>
          )}
        </div>
        <div>
          {p.kind === 'monthly' ? (
            <>
              <MoverTable title={`Largest account movers, ${ytdLabel}`} movers={d.account_movers[p.id].YTD26_vs_YTD25} partial={moverComparisonPartial(d, p.id, 'YTD26_vs_YTD25')} />
              <MoverTable title={`Largest account movers, ${periodLabel('FY2025')} vs ${periodLabel('FY2024')}`} movers={d.account_movers[p.id].FY2025_vs_FY2024} partial={moverComparisonPartial(d, p.id, 'FY2025_vs_FY2024')} />
            </>
          ) : (
            <div className="pf-note">Account movers need monthly exports; entity statements are annual only.</div>
          )}
        </div>
      </div>
    </div>
  );
}
