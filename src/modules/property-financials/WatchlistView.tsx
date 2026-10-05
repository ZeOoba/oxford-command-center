// src/modules/property-financials/WatchlistView.tsx
//
// Expense watchlist tab (reference artifact "WATCH"): Expense review items as full cards with workflow
// controls, filtered by Property and Severity (native labelled selects, keyboard accessible) and
// sorted severity then |annual impact|; then the largest operating-expense account movers across every
// PM asset. A cost decrease is favourable to NOI and reads green, always with its sign.
import { useId, useMemo, useState } from 'react';
import { PF_SEVERITIES, type PfDataset, type PfEntityId } from '@contracts/property-financials';
import { periodLabel } from '@analytics/property-financials/periods';
import { usd } from '@analytics/property-financials/format';
import { InsightCardList } from './InsightWorkflow';
import { WATCHLIST_ALL, WATCHLIST_MOVER_RULES, filterWatchlist, monthRangeLabel, toneClass, topOpexMovers, watchlistPropertyOptions } from './model';

const RE_TAX = 'Real estate & property tax';

export function WatchlistView({ dataset: d, onOpenProperty }: { dataset: PfDataset; onOpenProperty: (entity: PfEntityId) => void }) {
  const [property, setProperty] = useState<string>(WATCHLIST_ALL);
  const [severity, setSeverity] = useState<string>(WATCHLIST_ALL);
  const propId = useId();
  const sevId = useId();
  const options = useMemo(() => watchlistPropertyOptions(d.insights), [d.insights]);
  const items = useMemo(() => filterWatchlist(d.insights, { property, severity }), [d.insights, property, severity]);
  const movers = useMemo(() => topOpexMovers(d), [d]);
  const current = monthRangeLabel(d.meta.periods.YTD26.months);
  const priorYear = d.meta.periods.YTD25.months[d.meta.periods.YTD25.months.length - 1]?.slice(0, 4) ?? '';
  const taxDown = movers.some((m) => m.mover.category === RE_TAX && m.mover.delta < 0);

  return (
    <div>
      <h2>Expense watchlist</h2>
      <div className="pf-note" style={{ marginBottom: 12 }}>
        Items to question, bid out, appeal or audit. Cash-basis timing can explain part of any single-period move, so each item names the comparison it uses.
      </div>
      <div className="pf-filters" role="group" aria-label="Filter expense items">
        <label htmlFor={propId}>Property</label>
        <select id={propId} value={property} onChange={(e) => setProperty(e.target.value)}>
          {options.map((p) => (
            <option key={p} value={p}>
              {p === WATCHLIST_ALL ? 'All properties' : p}
            </option>
          ))}
        </select>
        <label htmlFor={sevId}>Severity</label>
        <select id={sevId} value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value={WATCHLIST_ALL}>All</option>
          {PF_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="pf-note" role="status" aria-live="polite">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      <InsightCardList insights={items} onOpenProperty={onOpenProperty} empty={<p className="pf-note">No items match.</p>} />

      <section className="pf-sec" aria-labelledby="pf-movers-h" style={{ marginTop: 28 }}>
        <h2 id="pf-movers-h">
          Largest account movers, {current} vs {priorYear}
        </h2>
        <div className="pf-note" style={{ marginBottom: 8 }}>
          Operating-expense accounts only, all PM assets, sorted by dollar change. Anything above {usd(WATCHLIST_MOVER_RULES.minAbsDelta)} is shown, up to{' '}
          {WATCHLIST_MOVER_RULES.limit}. A cost decrease is favourable to NOI.
        </div>
        <div className="pf-tbl" data-testid="pf-movers">
          <table>
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Account</th>
                <th scope="col">{periodLabel('YTD25')}</th>
                <th scope="col">{periodLabel('YTD26')}</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {movers.map((m) => (
                <tr key={`${m.entity}|${m.mover.category}|${m.mover.account}`}>
                  <td>{m.label}</td>
                  <td className="pf-wrap">
                    {m.mover.account} <span className="pf-mut">{m.mover.category}</span>
                  </td>
                  <td>{usd(m.mover.prior)}</td>
                  <td>{usd(m.mover.current)}</td>
                  <td className={toneClass(m.mover.delta, true)}>
                    {m.mover.delta > 0 ? '+' : '-'}
                    {usd(Math.abs(m.mover.delta))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {taxDown && (
          <p className="pf-note">Real estate tax lines show large decreases because installments paid later in the year are not yet in the {current.split(' ').pop()} figures.</p>
        )}
      </section>
    </div>
  );
}
