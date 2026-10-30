// src/modules/property-financials/ExplorerView.tsx
//
// Property explorer tab (plan T7; reference artifact "PROPERTY EXPLORER"): a card grid of all 11
// entities (aria-pressed selection, persisted in the URL as ?p=), then for the selected property the
// computed lede, KPI strip, revenue / opex / NOI bars, the opex stack, the monthly rent vs cost
// timeline with rent-step markers, the YoY table with $/SF rows, "What changed and why", the rent
// changes seen in the statements, the lease schedule (only where a lease exists), computed insights,
// the open review items with the shared workflow controls, and the category-by-period detail.
//
// Everything rendered comes from explorer-model.ts (built on the calc lib); this file formats and
// lays out, it does no arithmetic on dataset figures. Annual-only entities show what exists with an
// honest note; FVC carries the confirm-me SF mapping flag; missing months are noted on the page.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PfDataset, PfEntityId } from '@contracts/property-financials';
import type { PfLiveSfBlock } from '@analytics/property-financials/live-sf';
import { NM, pct, usd } from '@analytics/property-financials/format';
import { ChangeChip, NotMeaningful } from './components';
import { InsightCardList } from './InsightWorkflow';
import { PropertyGaps } from './PropertyGaps';
import { PropertyPageLink } from '../property/PropertyPageLink';
import { GroupedBars, StackedBars } from './charts/PeriodBars';
import { StepChart } from './charts/StepChart';
import { TimelineChart } from './charts/TimelineChart';
import { sparklineGeometry } from './charts/geometry';
import { fmtMonth } from './model';
import {
  DEFAULT_EXPLORER_ENTITY,
  EXPLORER_RULES,
  buildExplorer,
  opexStack,
  periodBars,
  propertyCards,
  timelineSeries,
  type CategoryRow,
  type EffectLine,
  type ExplorerKpi,
  type ExplorerModel,
  type PropertyCard,
  type TimelineRange,
  type WhyPair,
} from './explorer-model';

const fmtPerSf = (v: number) => `$${v.toFixed(2)}`;

function Sparkline({ values }: { values: readonly number[] }) {
  const s = sparklineGeometry(values, 96, 30);
  if (!s.path || !s.last) return null;
  return (
    <svg className="pf-spark" width={96} height={30} viewBox="0 0 96 30" aria-hidden focusable="false">
      <path d={s.path} fill="none" stroke="var(--pf-c1)" strokeWidth={2} />
      <circle cx={s.last.x} cy={s.last.y} r={3} fill="var(--pf-c1)" />
    </svg>
  );
}

function Card({ card, pressed, onSelect }: { card: PropertyCard; pressed: boolean; onSelect: (id: PfEntityId) => void }) {
  return (
    <button type="button" className="pf-pcard" aria-pressed={pressed} data-entity={card.id} onClick={() => onSelect(card.id)}>
      <span className="pf-pcard-n">{card.name}</span>
      <span className="pf-pcard-v">{card.noi === null ? NM : usd(card.noi)}</span>
      {card.sf !== null && <span className="pf-pcard-s">{card.sf.toLocaleString('en-US')} SF</span>}
      <span className="pf-pcard-s">
        NOI {card.periodLabel} <ChangeChip result={card.change} />
      </span>
      <Sparkline values={card.spark} />
    </button>
  );
}

function Kpi({ k }: { k: ExplorerKpi }) {
  return (
    <div className="pf-kpi" data-kpi={k.id}>
      <div className="pf-kpi-l">{k.label}</div>
      <div className="pf-kpi-v">{k.value}</div>
      <div className="pf-kpi-d">
        {k.change && (
          <>
            <ChangeChip result={k.change} invert={k.invert} /> {k.versus}
          </>
        )}
        {k.note}
      </div>
    </div>
  );
}

function Panel({ title, sub, children, id }: { title: string; sub?: ReactNode; children: ReactNode; id?: string }) {
  const hid = useId();
  return (
    <section className="pf-panel pf-xpanel" aria-labelledby={hid} data-panel={id}>
      <h3 id={hid}>{title}</h3>
      {sub && <div className="pf-sub">{sub}</div>}
      {children}
    </section>
  );
}

function YoyTable({ m }: { m: ExplorerModel }) {
  const t = m.yoy;
  return (
    <>
      <div className="pf-tbl" data-testid="pf-yoy">
        <table>
          <thead>
            <tr>
              <th scope="col">USD</th>
              {t.columns.map((c) => (
                <th scope="col" key={c.key}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r) => (
              <tr key={r.label}>
                <td>
                  <b>{r.label}</b>
                </td>
                {r.cells.map((cell, i) => (
                  <td key={t.columns[i]!.key} className={t.columns[i]!.partial ? 'pf-mut' : undefined}>
                    {usd(cell.value, 'f')}
                    <br />
                    <small>
                      <ChangeChip result={cell.change} invert={r.invert} />
                    </small>
                  </td>
                ))}
              </tr>
            ))}
            {t.perSf.map((r) => (
              <tr key={r.label}>
                <td>
                  <b>{r.label}</b>
                </td>
                {r.cells.map((cell, i) => (
                  <td key={t.columns[i]!.key} className={t.columns[i]!.partial ? 'pf-mut' : undefined}>
                    {cell.value.value === null ? <NotMeaningful reason={cell.value.reason} /> : fmtPerSf(cell.value.value)}
                    {cell.note && (
                      <>
                        <br />
                        <small className="pf-mut">{cell.note}</small>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.sfNote && <p className="pf-note">{t.sfNote}</p>}
    </>
  );
}

function CategoryTable({ m }: { m: ExplorerModel }) {
  const t = m.categories;
  const row = (r: CategoryRow, bold = false) => (
    <tr key={r.label}>
      <td>{bold ? <b>{r.label}</b> : r.label}</td>
      {r.cells.map((cell, i) => (
        <td key={t.columns[i]!.key} className={t.columns[i]!.partial ? 'pf-mut' : undefined}>
          {usd(cell.value, 'f')}
          {cell.change && (
            <>
              <br />
              <small>
                <ChangeChip result={cell.change} invert={r.invert} />
              </small>
            </>
          )}
        </td>
      ))}
    </tr>
  );
  const section = (label: string) => (
    <tr className="pf-tsec">
      <td colSpan={t.columns.length + 1}>
        <b>{label}</b>
      </td>
    </tr>
  );
  return (
    <div className="pf-tbl" data-testid="pf-categories">
      <table>
        <thead>
          <tr>
            <th scope="col">USD</th>
            {t.columns.map((c) => (
              <th scope="col" key={c.key}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section('Revenue')}
          {t.revenue.map((r) => row(r))}
          {section('Operating expense')}
          {t.opex.map((r) => row(r))}
          {t.totals.map((r) => row(r, true))}
        </tbody>
      </table>
    </div>
  );
}

/** Effect-on-NOI bars: length = share of the largest effect; helps = solid slot 1 + ▲, hurts = hatched slot 2 + ▼. */
function EffectBars({ pair }: { pair: WhyPair }) {
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const sign = (e: EffectLine) => `${e.helps ? '+' : '-'}${usd(Math.abs(e.impact), 'k')}`;
  return (
    <div className="pf-effects" onPointerLeave={() => setActive(null)}>
      <h4 className="pf-h4">
        Effect on NOI by line, {pair.currentLabel} vs {pair.priorLabel}
      </h4>
      <div className="pf-bars" aria-describedby={tableId}>
        {pair.effects.map((e, i) => (
          <div
            key={e.name}
            className="pf-brow"
            data-effect={e.helps ? 'helps' : 'hurts'}
            tabIndex={0}
            aria-label={`${e.name}: ${e.helps ? 'helps' : 'hurts'} NOI, ${sign(e)}`}
            onPointerEnter={() => setActive(i)}
            onPointerDown={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <span className="pf-bl">{e.name}</span>
            <span className="pf-bt">
              <i className={e.helps ? 'pf-helps' : 'pf-hurts'} style={{ width: `${e.width * 100}%` }} />
            </span>
            <span className={`pf-bv ${e.helps ? 'pf-pos' : 'pf-neg'}`}>
              {e.helps ? '▲' : '▼'} {sign(e)}
            </span>
            {active === i && (
              <div className="pf-tip pf-tip-row" role="status">
                <b>{e.tip[0]}</b>
                {e.tip.slice(1).map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {pair.effects.length === 0 && <p className="pf-note">No line moved NOI by {usd(EXPLORER_RULES.why.effectMinDollars)} or more.</p>}
      <div className="pf-legend">
        <span>
          <i className="pf-helps" aria-hidden style={{ height: 10, width: 14 }} />▲ Helps NOI
        </span>
        <span>
          <i className="pf-hurts" aria-hidden style={{ height: 10, width: 14 }} />▼ Hurts NOI
        </span>
      </div>
      <details className="pf-tablefb" id={tableId}>
        <summary>Data table</summary>
        <div className="pf-tbl">
          <table>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">{pair.priorLabel}</th>
                <th scope="col">{pair.currentLabel}</th>
                <th scope="col">Effect on NOI</th>
              </tr>
            </thead>
            <tbody>
              {pair.effects.map((e) => (
                <tr key={e.name}>
                  <td>{e.name}</td>
                  <td>{usd(e.prior, 'f')}</td>
                  <td>{usd(e.current, 'f')}</td>
                  <td>
                    {e.helps ? 'Helps' : 'Hurts'} {sign(e)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function WhyPanel({ m, emptyNote }: { m: ExplorerModel; emptyNote: string }) {
  const [key, setKey] = useState(m.why.pairs[0]?.key ?? '');
  const pair = m.why.pairs.find((p) => p.key === key) ?? m.why.pairs[0];
  const selId = useId();
  if (!pair) return <p className="pf-note">Not enough comparable periods yet for a driver analysis.</p>;
  return (
    <div data-testid="pf-why">
      <div className="pf-filters">
        <label htmlFor={selId}>Comparison</label>
        <select id={selId} value={pair.key} onChange={(e) => setKey(e.target.value)}>
          {m.why.pairs.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <EffectBars pair={pair} />
      <h4 className="pf-h4" style={{ marginTop: 20 }}>
        Largest account movements
      </h4>
      {pair.drivers.length === 0 && <p className="pf-note">{emptyNote}</p>}
      {pair.drivers.map((dr, i) => (
        <div className="pf-drv" key={`${dr.account}-${i}`} data-driver={dr.helps ? 'helps' : 'hurts'}>
          <div className="pf-drv-h">
            <span className={`pf-pill ${dr.helps ? 'pf-helps-pill' : 'pf-hurts-pill'}`}>{dr.helps ? '▲ Helps NOI' : '▼ Hurts NOI'}</span>
            <b>{dr.account}</b>
            <span className="pf-mut">
              {dr.category} · {dr.kind}
            </span>
            <span className="pf-nat" data-nature={dr.natureLabel.toLowerCase()}>
              {dr.natureLabel}
            </span>
            <span className="pf-mut pf-small">{dr.natureTag}</span>
          </div>
          <div className="pf-drv-n">
            {usd(dr.prior, 'f')} → {usd(dr.current, 'f')}{' '}
            <b className={dr.helps ? 'pf-pos' : 'pf-neg'}>
              {dr.delta > 0 ? '+' : '-'}
              {usd(Math.abs(dr.delta), 'f')}
              {dr.change.value !== null ? ` (${pct(dr.change.value)})` : ''}
            </b>
          </div>
          <p>{dr.text}</p>
        </div>
      ))}
    </div>
  );
}

function LeasePanelView({ m }: { m: ExplorerModel }) {
  const L = m.lease;
  if (!L) return null;
  return (
    <Panel title="Lease schedule and next rent step" sub={L.subtitle} id="lease">
      <div className="pf-two">
        <StepChart rows={L.rows} today={L.today} ariaLabel={`Scheduled monthly rent by lease step, ${L.lease.tenant}`} />
        <div>
          {L.current && L.currentAnnual !== null && (
            <p style={{ margin: '0 0 8px' }} data-testid="pf-lease-current">
              <b>Current rent</b> {usd(L.currentAnnual, 'f')} a year
              {L.currentPerSf.value !== null ? `, ${fmtPerSf(L.currentPerSf.value)} per SF` : ''}.
            </p>
          )}
          {L.next && (
            <p style={{ margin: '0 0 10px' }} data-testid="pf-lease-next">
              <b>Next step</b> {L.next.from} to {usd(L.next.value, 'f')} per month, +{usd(L.next.annualDelta, 'f')} annualized
              {L.next.change.value !== null ? ` (${pct(L.next.change.value)})` : ''}.
            </p>
          )}
          <div className="pf-tbl">
            <table>
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Monthly</th>
                  <th scope="col">Step</th>
                  <th scope="col">Annual</th>
                </tr>
              </thead>
              <tbody>
                {L.rows.map((r) => (
                  <tr key={r.from} className={r.current ? 'pf-current' : undefined} aria-current={r.current ? 'true' : undefined}>
                    <td>{r.from}</td>
                    <td>{r.to}</td>
                    <td>{usd(r.value, 'f')}</td>
                    <td>{r.change ? <ChangeChip result={r.change} /> : '–'}</td>
                    <td>{usd(r.annual, 'f')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {L.nnnNote && (
            <p className="pf-note" style={{ marginTop: 8 }}>
              {L.nnnNote}
            </p>
          )}
          <p className="pf-note">{L.sourceNote}</p>
        </div>
      </div>
    </Panel>
  );
}

function RentEvents({ m }: { m: ExplorerModel }) {
  return (
    <Panel
      title="Rent changes visible in the statements"
      sub="Net change in monthly base rent that persisted for at least three months. At multi-tenant assets each step nets lease starts, expirations and escalations."
      id="events"
    >
      {m.events.length > 0 ? (
        <div className="pf-tbl" data-testid="pf-events">
          <table>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Monthly rent before</th>
                <th scope="col">Monthly rent after</th>
                <th scope="col">Change</th>
                <th scope="col">Annualized</th>
              </tr>
            </thead>
            <tbody>
              {m.events.map((e) => (
                <tr key={e.month}>
                  <td>{e.label}</td>
                  <td>{usd(e.before, 'f')}</td>
                  <td>{usd(e.after, 'f')}</td>
                  <td>
                    <ChangeChip result={e.change} />
                  </td>
                  <td className={e.dir === 'up' ? 'pf-pos' : 'pf-neg'}>
                    {e.dir === 'up' ? '+' : '-'}
                    {usd(Math.abs(e.annualized), 'f')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="pf-note">{m.eventsNote}</p>
      )}
    </Panel>
  );
}

function Detail({ d, m, onOpenProperty }: { d: PfDataset; m: ExplorerModel; onOpenProperty: (entity: PfEntityId) => void }) {
  const [range, setRange] = useState<TimelineRange>('all');
  const timeline = useMemo(() => timelineSeries(d, m.id, range), [d, m.id, range]);
  const bars = useMemo(() => periodBars(m.groups), [m.groups]);
  const stack = useMemo(() => opexStack(m.groups), [m.groups]);
  const sinceLabel = `Since ${fmtMonth(d.meta.periods.FY2024.months[0] ?? '')}`;
  return (
    <>
      {m.fvcFlag && (
        <div className="pf-flag" role="note" data-testid="pf-fvc-flag">
          <span className="pf-flag-l">Confirm</span>
          <span>
            <b>Square footage mapping is inferred.</b> {m.fvcFlag.text}
          </span>
        </div>
      )}
      {m.missingMonthsNote && (
        <p className="pf-note pf-gap" data-testid="pf-missing-months">
          {m.missingMonthsNote}
        </p>
      )}
      {m.annualOnlyNote && (
        <p className="pf-note pf-gap" data-testid="pf-annual-only">
          {m.annualOnlyNote}
        </p>
      )}
      {/* The FVC square-footage inference is already in the Confirm flag above. */}
      <PropertyGaps dataset={d} id={m.id} omitMapping />
      <p className="pf-lede pf-xlede" data-testid="pf-explorer-lede">
        {m.lede}
      </p>
      {m.kpis.length > 0 && (
        <div className="pf-kpis" data-testid="pf-explorer-kpis">
          {m.kpis.map((k) => (
            <Kpi key={k.id} k={k} />
          ))}
        </div>
      )}
      <div className="pf-grid2 pf-grid2-even">
        <Panel title="Revenue, operating expense and NOI by year" sub="Hover or tap a bar for the value and the change from the prior comparable period.">
          <GroupedBars data={bars} ariaLabel={`Revenue, operating expense and NOI by period, ${m.label}`} />
        </Panel>
        <Panel title="Where operating expense goes" sub="Stacked by category. Hover or tap a segment for its share and change.">
          <StackedBars data={stack} ariaLabel={`Operating expense by category and period, ${m.label}`} />
        </Panel>
      </div>
      <Panel
        title="Monthly base rent and operating cost"
        sub={m.monthly ? '3-month trailing average, full monthly history. Triangles mark net base-rent steps detected in the data.' : undefined}
        id="timeline"
      >
        {timeline ? (
          <>
            <div className="pf-seg" role="group" aria-label="Timeline range">
              <button type="button" aria-pressed={range === 'all'} onClick={() => setRange('all')}>
                All history
              </button>
              <button type="button" aria-pressed={range === 'since'} onClick={() => setRange('since')}>
                {sinceLabel}
              </button>
            </div>
            <TimelineChart series={timeline} ariaLabel={`Monthly base rent and operating expense for ${m.label}, 3-month trailing average`} />
          </>
        ) : (
          <p className="pf-note">Entity statements are annual only, so no monthly series exists.</p>
        )}
      </Panel>
      <Panel title="Year-over-year change" sub="Each cell shows the dollar value and the change from the prior comparable period. Partial periods are n/m: never compared year over year." id="yoy">
        <YoyTable m={m} />
      </Panel>
      <Panel
        title="What changed and why"
        sub="Account-level drivers behind each period-over-period change. Nature tags are derived from monthly timing; items marked [INFERRED] are hypotheses to verify with invoices."
        id="why"
      >
        <WhyPanel m={m} emptyNote={m.why.emptyDriversNote} />
      </Panel>
      <RentEvents m={m} />
      <LeasePanelView m={m} />
      <Panel title="Insights for this property" sub="Computed from the data above. Tagged [INFERRED] where the data supports a hypothesis but not proof." id="insights">
        <div data-testid="pf-explorer-insights">
          {m.insights.map((i) => (
            <div className="pf-ins" key={i.heading}>
              <b>{i.heading}</b>
              <span>{i.text}</span>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Open items from the portfolio review" id="open-items">
        <InsightCardList insights={m.openItems} onOpenProperty={onOpenProperty} empty={<p className="pf-note">No open items for this property in the portfolio review.</p>} />
      </Panel>
      <Panel title="Category detail by period" sub="Dollar values by period; the small figure is the change from the prior comparable period." id="categories">
        <CategoryTable m={m} />
      </Panel>
    </>
  );
}

export interface ExplorerViewProps {
  readonly dataset: PfDataset;
  /** The raw live SF block (already applied to `dataset`); read only to name a disagreeing occupancy. */
  readonly liveSf?: PfLiveSfBlock | null;
  /** From ?p=; null = the default selection. */
  readonly selected: PfEntityId | null;
  readonly onSelect: (entity: PfEntityId) => void;
  readonly onOpenProperty: (entity: PfEntityId) => void;
}

export function ExplorerView({ dataset: d, liveSf = null, selected, onSelect, onOpenProperty }: ExplorerViewProps) {
  const id = selected ?? DEFAULT_EXPLORER_ENTITY;
  const cards = useMemo(() => propertyCards(d), [d]);
  const m = useMemo(() => buildExplorer(d, id, EXPLORER_RULES, liveSf), [d, id, liveSf]);
  const detailRef = useRef<HTMLDivElement>(null);
  const picked = useRef(false);
  useEffect(() => {
    // Bring the detail into view after a card click (not on first render / deep link).
    if (!picked.current) return;
    picked.current = false;
    const el = detailRef.current;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const top = el.getBoundingClientRect().top;
    // Artifact parity: bring the detail into view, unless its top is already comfortably on screen.
    if (top < 0 || top > window.innerHeight * 0.6) el.scrollIntoView({ block: 'start' });
  }, [id]);
  const select = (e: PfEntityId) => {
    picked.current = true;
    onSelect(e);
  };
  return (
    <div data-testid="pf-explorer">
      <h2>Property explorer</h2>
      <p className="pf-note" style={{ marginBottom: 12 }}>
        Select a property. Every figure is built from the monthly or annual statements, back to the earliest data available. Cash basis; partial periods are marked and excluded from
        year-over-year math.
      </p>
      <div className="pf-pgrid" role="group" aria-label="Properties">
        {cards.map((c) => (
          <Card key={c.id} card={c} pressed={c.id === id} onSelect={select} />
        ))}
      </div>
      <div ref={detailRef} className="pf-xdetail" data-entity={id}>
        {liveSf?.entries[id]?.canonicalId && (
          <p className="pf-note" data-testid="pf-explorer-page-link">
            <PropertyPageLink propertyId={liveSf.entries[id]!.canonicalId!} />
          </p>
        )}
        <Detail key={id} d={d} m={m} onOpenProperty={onOpenProperty} />
      </div>
    </div>
  );
}
