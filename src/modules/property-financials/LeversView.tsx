// src/modules/property-financials/LeversView.tsx
//
// Rent & NOI levers tab (reference artifact "LEVERS"): the value-of-a-point sensitivity table (calc
// lib LEVERS config → computeLevers), the revenue and recovery review items as full cards with
// workflow controls, and the base-rent run-rate by property. Every figure comes from the calc lib /
// model.ts; nothing here is hardcoded firm data.
import { useMemo } from 'react';
import { PF_MONTHLY_ENTITY_IDS, type PfDataset, type PfEntityId } from '@contracts/property-financials';
import { computeLevers } from '@analytics/property-financials/levers';
import { pct, usd } from '@analytics/property-financials/format';
import { MetricCell } from './components';
import { InsightCardList } from './InsightWorkflow';
import { RUN_RATE_YEARS, countWord, leverInsights, runRateRows, toneClass } from './model';

const fullUsd = (v: number) => usd(v, 'f');

export function LeversView({ dataset: d, onOpenProperty }: { dataset: PfDataset; onOpenProperty: (entity: PfEntityId) => void }) {
  const levers = useMemo(() => computeLevers(d), [d]);
  const items = useMemo(() => leverInsights(d.insights), [d.insights]);
  const runRate = useMemo(() => runRateRows(d), [d]);
  return (
    <div>
      <h2>Rent and NOI levers</h2>
      <p className="pf-lede pf-lede-sm">
        Value of a point. Each line is a sensitivity on trailing-twelve-month figures for the {countWord(PF_MONTHLY_ENTITY_IDS.length)} PM-reported assets, so you can
        price a decision before you make it.
      </p>
      <div className="pf-tbl pf-sens" data-testid="pf-levers">
        <table>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Lever</th>
              <th scope="col">Annual value</th>
              <th scope="col">Basis</th>
            </tr>
          </thead>
          <tbody>
            {levers.map((l) => (
              <tr key={l.id} data-lever={l.id}>
                <td>{l.category}</td>
                <td>{l.label}</td>
                <td>
                  <b>
                    <MetricCell result={l.value} format={fullUsd} />
                  </b>
                </td>
                <td className="pf-mut pf-wrap">{l.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pf-note">Sensitivities are arithmetic, not forecasts. [SPECULATIVE] where the achievable percentage depends on bids.</p>

      <section className="pf-sec" aria-labelledby="pf-lev-items" style={{ marginTop: 28 }}>
        <h2 id="pf-lev-items">Revenue and recovery items</h2>
        <InsightCardList insights={items} onOpenProperty={onOpenProperty} empty={<p className="pf-note">No revenue or recovery items in this dataset.</p>} />
      </section>

      <section className="pf-sec" aria-labelledby="pf-lev-rr">
        <h2 id="pf-lev-rr">Base rent run-rate by property</h2>
        <div className="pf-note" style={{ marginBottom: 8 }}>
          Average of July-September base rent, annualized. This removes the timing noise in single months.
        </div>
        <div className="pf-tbl" data-testid="pf-runrate">
          <table>
            <thead>
              <tr>
                <th scope="col">Property</th>
                {RUN_RATE_YEARS.map((y) => (
                  <th scope="col" key={y}>
                    Q3 {y}
                  </th>
                ))}
                <th scope="col">2025 vs 2024</th>
                <th scope="col">2026 vs 2025</th>
              </tr>
            </thead>
            <tbody>
              {runRate.map((r) => (
                <tr key={r.id}>
                  <td>{r.label}</td>
                  {RUN_RATE_YEARS.map((y) => (
                    <td key={y}>
                      <MetricCell result={r.q3[y]} format={(v) => usd(v)} />
                    </td>
                  ))}
                  <td>
                    <MetricCell result={r.yoy2025} format={(v) => pct(v)} className={(v) => toneClass(v)} />
                  </td>
                  <td>
                    <MetricCell result={r.yoy2026} format={(v) => pct(v)} className={(v) => toneClass(v)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
