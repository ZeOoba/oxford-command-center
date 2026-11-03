// src/modules/property/PropertyPage.tsx
//
// Canonical property page (roadmap 2.2): /property/:id. One place per property for the header
// KPIs, trends, the rollover ladder with its rent-gap column, and the property's open alerts.
// Two spines, never mixed (ruling 2026-10-30): workbook figures from the snapshot, monthly trends
// from the Property Financials P&L ledger — every card says which, with an as-of stamp.
// Outlook (Track 4) and levers (Track 5) slot in above/below the trends when those engines exist.
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useSnapshot } from '@/data/queries';
import { useAlertView } from '@/data/alerts';
import { useUi } from '@/brain/ui-context';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { AsOfChip } from '@/primitives/AsOfChip';
import { AreaChart } from '@/charts/AreaChart';
import { SeriesLegend } from '@/charts/SeriesLegend';
import { provenanceKinds } from '@/charts/series-provenance';
import { pointProvenance } from '../portfolio/scenario-spread';
import { fmtDate, fmtMultiple, fmtPct, fmtSf, fmtUsd, fmtUsdCompact, propertyLtvLabel } from '@analytics/index';
import { isInvestmentProperty, landlordCostsNotSourced } from '@analytics/property-basis';
import { useLeaseForecast } from '../leasing/hooks';
import { BUCKET_LABEL, monthEndIso, propertyAlerts, rolloverLadder, type LadderRow } from './property-page-model';
import { usePropertyLedger, usePropertyOccupancy } from './hooks';

/** Monthly charts show the latest 24 recorded ledger months. */
const TREND_MONTHS = 24;
const LEDGER = 'P&L ledger';
/** The ledger is each entity's own P&L — 100% of the property, never the Oxford share. */
const LEDGER_SOURCE = 'P&L ledger · entity 100%';
const NNN_NOTE = 'NNN, not absolute: landlord-paid roof, structure and paving costs are not sourced yet, so this NOI is overstated by them.';

const SEV_TONE = { critical: 'red', warning: 'amber', info: 'blue' } as const;

function Section({ title, trailing, children }: { title: ReactNode; trailing?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} trailing={trailing} />
      <div className="p-3">{children}</div>
    </Card>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
      {children}
    </p>
  );
}

function MarketCell({ row }: { row: LadderRow }) {
  const m = row.market;
  if (m.kind === 'not-sourced') return <span style={{ color: 'var(--text-tertiary)' }}>not yet sourced</span>;
  const indicative = m.kind === 'indicative';
  return (
    <span style={{ color: indicative ? 'var(--text-tertiary)' : 'var(--text-primary)' }} title={indicative ? 'Lease-market asking feed — indicative, not a manual market rent' : 'Manual market rent'}>
      {m.psf !== null ? `$${m.psf.toFixed(2)}` : '—'}
      {m.gapAnnualUsd !== null && <> · {fmtUsdCompact(m.gapAnnualUsd)}/yr</>}
      {indicative && <> · indicative</>}
    </span>
  );
}

function Ladder({ rows }: { rows: LadderRow[] }) {
  if (rows.length === 0) return <Muted>No leases on the rent roll for this property.</Muted>;
  let lastBucket: string | null = null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-2xs" data-testid="rollover-ladder">
        <thead>
          <tr style={{ color: 'var(--text-tertiary)' }} className="text-left">
            <th scope="col" className="py-1 pr-3">Tenant</th>
            <th scope="col" className="py-1 pr-3">Unit</th>
            <th scope="col" className="py-1 pr-3 text-right">SF</th>
            <th scope="col" className="py-1 pr-3 text-right">Annual rent</th>
            <th scope="col" className="py-1 pr-3 text-right">$/SF</th>
            <th scope="col" className="py-1 pr-3">Ends</th>
            <th scope="col" className="py-1">Market $/SF · gap</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((r) => {
            const out: ReactNode[] = [];
            if (r.bucket !== lastBucket) {
              lastBucket = r.bucket;
              out.push(
                <tr key={`b-${r.bucket}`}>
                  <th scope="rowgroup" colSpan={7} className="pt-3 pb-1 text-left font-semibold" style={{ color: r.bucket === 'past' ? 'var(--text-neg)' : 'var(--text-secondary)' }}>
                    {BUCKET_LABEL[r.bucket]}
                  </th>
                </tr>,
              );
            }
            out.push(
              <tr key={r.leaseId} className="num" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <td className="py-1 pr-3" style={{ color: 'var(--text-primary)' }}>{r.tenant}</td>
                <td className="py-1 pr-3">{r.unit ?? '—'}</td>
                <td className="py-1 pr-3 text-right">{fmtSf(r.sf)}</td>
                <td className="py-1 pr-3 text-right">{fmtUsd(r.annualRent)}</td>
                <td className="py-1 pr-3 text-right">{r.rentPsf !== null ? `$${r.rentPsf.toFixed(2)}` : '—'}</td>
                <td className="py-1 pr-3">{fmtDate(r.leaseEnd)}</td>
                <td className="py-1"><MarketCell row={r} /></td>
              </tr>,
            );
            return out;
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PropertyPage() {
  const gate = useSnapshotGate();
  const { data } = useSnapshot();
  const params = useParams();
  const location = useLocation();
  const ui = useUi();
  const forecast = useLeaseForecast();
  const alertView = useAlertView();
  // react-router has already decoded the splat.
  const id = (params['*'] ?? '').split('/')[0] ?? '';

  const snapshot = data?.snapshot;
  // The residence is excluded from every surface (ruling 2026-10-30) — its id resolves to "not found".
  const property = snapshot?.properties.find((p) => p.id === id && isInvestmentProperty(p)) ?? null;
  const ledger = usePropertyLedger(id);
  const occupancy = usePropertyOccupancy(snapshot, property);

  if (gate) return gate;
  if (!snapshot) return null;
  if (!property) {
    return (
      <Section title="Property not found">
        <Muted>
          No portfolio property has the id “{id}”. <Link to={`/portfolio${location.search}`} style={{ color: 'var(--accent)' }}>Back to Portfolio</Link>
        </Muted>
      </Section>
    );
  }

  const p = property;
  const leases = snapshot.leases.filter((l) => l.propertyId === p.id);
  const ladder = rolloverLadder(snapshot.leases, p.id, forecast.data?.marketGaps ?? []);
  const alerts = propertyAlerts(alertView.items, p.id, new Set(leases.map((l) => l.id)));
  const nnn = landlordCostsNotSourced(p);
  const lastT12 = ledger?.t12[ledger.t12.length - 1] ?? null;
  const recent = ledger?.months.slice(-TREND_MONTHS) ?? [];
  const lastLedgerMonth = ledger?.months[ledger.months.length - 1]?.month ?? null;
  const ledgerChip = lastLedgerMonth ? <AsOfChip asOf={monthEndIso(lastLedgerMonth)} source={LEDGER_SOURCE} /> : null;
  const workbookChip = <AsOfChip asOf={snapshot.meta.asOf} source="Master Workbook" />;

  const ledgerSub = !ledger
    ? 'not in the P&L ledger'
    : lastT12
      ? `entity 100% · T12 to ${lastT12.month}`
      : ledger.months.length === 0
        ? 'annual statements only'
        : 'no 12 consecutive ledger months';

  return (
    <div className="flex flex-col gap-4" data-testid="property-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            <Link to={`/portfolio${location.search}`} style={{ color: 'var(--accent)' }}>Portfolio</Link> › Property
          </div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{p.name}</h1>
          <div className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
            {p.market} · {p.type} · {fmtSf(p.sf)} · {p.tenantCount} tenants
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {workbookChip}
          <button type="button" onClick={() => ui.openEntity({ type: 'property', id: p.id })} className="text-2xs font-semibold" style={{ color: 'var(--accent)' }}>
            Details drawer
          </button>
          {ledger && (
            <Link to={`/property-financials?view=explorer&p=${encodeURIComponent(ledger.entity)}`} className="text-2xs font-semibold" style={{ color: 'var(--accent)' }}>
              P&L explorer
            </Link>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiStat
          label={p.oxfordOwnPct < 1 ? `NOI · workbook, Oxford ${fmtPct(p.oxfordOwnPct, 0)}` : 'NOI · workbook'}
          value={p.noi}
          format={fmtUsdCompact}
          sublabel={nnn ? <span title={NNN_NOTE}><Badge tone="amber">NNN · LL costs not sourced</Badge></span> : 'Oxford share, annualized'}
        />
        <KpiStat label="NOI · ledger T12" value={lastT12?.value ?? null} format={fmtUsdCompact} sublabel={ledgerSub} spark={ledger?.t12.map((t) => t.value)} />
        <KpiStat label="Occupancy · workbook" value={p.occPct} format={(n) => fmtPct(n)} />
        <KpiStat label="DSCR · workbook" value={p.dscr} format={(n) => (n === null ? '—' : fmtMultiple(n))} />
        <KpiStat label="LTV · workbook" value={p.ltv} format={() => propertyLtvLabel(p)} />
        <KpiStat label="Rent / SF · workbook" value={p.rentPerSf} format={(n) => (n === null ? '—' : `$${n.toFixed(2)}`)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title={`NOI · ${LEDGER}, monthly`} trailing={ledgerChip}>
          {recent.length > 1 ? (
            <AreaChart
              data={recent.map((m) => ({ date: `${m.month}-01`, value: m.noi }))}
              valueFormat={fmtUsdCompact}
              height={200}
              ariaLabel={`${p.name} monthly NOI, P&L ledger basis`}
            />
          ) : (
            <Muted>{ledger ? 'No monthly ledger detail for this property (annual statements only).' : 'This property is not in the P&L ledger set yet.'}</Muted>
          )}
        </Section>
        <Section title={`Operating expense · ${LEDGER}, monthly`} trailing={ledgerChip}>
          {recent.length > 1 ? (
            <AreaChart
              data={recent.map((m) => ({ date: `${m.month}-01`, value: m.opex }))}
              valueFormat={fmtUsdCompact}
              height={200}
              color="var(--color-neg)"
              ariaLabel={`${p.name} monthly operating expense, P&L ledger basis`}
            />
          ) : (
            <Muted>No monthly operating expense in the P&L ledger for this property.</Muted>
          )}
        </Section>
        <Section title={`Base rent / SF · ${LEDGER}, annualized`} trailing={ledgerChip}>
          {recent.length > 1 && ledger?.sf ? (
            <AreaChart
              data={recent.map((m) => ({ date: `${m.month}-01`, value: (m.baseRent * 12) / ledger.sf! }))}
              valueFormat={(n) => `$${n.toFixed(2)}`}
              height={200}
              color="var(--accent)"
              ariaLabel={`${p.name} base rent per SF annualized, P&L ledger basis`}
            />
          ) : (
            <Muted>Needs monthly ledger rent and a square footage for this entity.</Muted>
          )}
        </Section>
        <Section
          title="Occupancy · lease-SF basis"
          trailing={
            <span className="inline-flex items-center gap-2">
              <AsOfChip asOf={snapshot.meta.asOf} source="Rent roll" />
              {occupancy && <Badge tone="neutral">{occupancy.recordedMonths} recorded / {occupancy.points.length - occupancy.recordedMonths} reconstructed mo</Badge>}
            </span>
          }
        >
          {occupancy && occupancy.points.length > 1 ? (
            <div className="flex flex-col gap-2">
              <AreaChart
                data={occupancy.points.map((m) => ({ date: `${m.month}-01`, value: (1 - m.vacancyPct) * 100 }))}
                valueFormat={(n) => `${n.toFixed(0)}%`}
                height={200}
                color="var(--color-info)"
                provenance={pointProvenance(occupancy.points)}
                ariaLabel={`${p.name} occupancy by month, lease-SF basis (recorded months where available, else reconstructed from current leases)`}
              />
              <SeriesLegend kinds={provenanceKinds(pointProvenance(occupancy.points))} color="var(--color-info)" />
            </div>
          ) : (
            <Muted>No lease-SF occupancy series for this property.</Muted>
          )}
        </Section>
      </div>

      <Section title="Lease rollover" trailing={<span className="inline-flex items-center gap-2"><AsOfChip asOf={snapshot.meta.asOf} source="Rent roll" /><Badge tone="neutral">{ladder.length} leases</Badge></span>}>
        <Ladder rows={ladder} />
        <p className="pt-2 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Market rent: manual entry where set; otherwise the lease-market asking feed, marked indicative and never used in NOI; otherwise not yet sourced.
        </p>
      </Section>

      <Section title="Open alerts" trailing={<Badge tone="neutral">{alerts.length}</Badge>}>
        {alerts.length === 0 ? (
          <Muted>No open alerts on this property or its leases.</Muted>
        ) : (
          <ul className="flex flex-col gap-2">
            {alerts.map(({ insight: a }) => (
              <li key={a.id} className="flex items-start justify-between gap-3 text-2xs">
                <span className="min-w-0">
                  <Badge tone={SEV_TONE[a.severity]}>{a.severity}</Badge>{' '}
                  <span style={{ color: 'var(--text-primary)' }}>{a.title}</span>
                  <span className="block truncate" style={{ color: 'var(--text-tertiary)' }}>{a.detail}</span>
                </span>
                <span className="num shrink-0" style={{ color: 'var(--text-secondary)' }}>
                  {a.impactAnnualUsd !== null ? `${fmtUsdCompact(a.impactAnnualUsd)}/yr` : 'not quantified'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
