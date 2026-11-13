import { useMemo } from 'react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { useUi } from '@/brain/ui-context';
import { fmtUsdCompact, fmtPct, fmtSf, fmtMultiple, fmtNum, propertyLtvLabel, investmentLtv } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge } from '@/primitives/Badge';
import { BarList } from '@/charts/BarList';
import { investmentPropertiesSublabel } from '@/modules/overview/other-holdings';
import { landlordCostsNotSourced } from '@analytics/property-basis';
import { BLANK_IN_WORKBOOK, hasBlankGovernorInput } from '@analytics/governor-inputs';
import type { Property } from '@contracts/index';
import { PropertyPageLink } from '@/modules/property/PropertyPageLink';
import { Sparkline } from '@/charts/Sparkline';
import { usePfDataset } from '@/modules/property-financials/hooks';
import { useTrendsHistory } from './trends-history';
import { fmtPp, ledgerSparkFor, recordedOccDelta, type LedgerSpark, type RecordedOccDelta } from './table-trends';
import { BasisSublabel } from '@/primitives/BasisChip';
import { landlordCostCaveat } from '@/modules/overview/landlord-cost-caveat';
import { LandlordCostChip } from '@/modules/overview/LandlordCostChip';

export function PortfolioModule() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const { analytics } = useAnalytics();
  const ui = useUi();
  const pf = usePfDataset();
  const history = useTrendsHistory();

  // Roadmap 2.4 trend cells, one map per basis so a row never mixes them with its workbook columns.
  const sparks = useMemo(() => {
    const out = new Map<string, LedgerSpark>();
    const d = pf.data?.dataset;
    if (!d || !data) return out;
    for (const p of data.snapshot.properties) {
      const s = ledgerSparkFor(d.monthly as Parameters<typeof ledgerSparkFor>[0], pf.data?.liveSf?.entries, p.id);
      if (s) out.set(p.id, s);
    }
    return out;
  }, [pf.data, data]);
  const occDeltas = useMemo(() => {
    const out = new Map<string, RecordedOccDelta>();
    const recorded = history.isError ? [] : history.data?.points ?? [];
    if (!data) return out;
    for (const p of data.snapshot.properties) {
      const dlt = recordedOccDelta(recorded, p.id);
      if (dlt) out.set(p.id, dlt);
    }
    return out;
  }, [history.isError, history.data, data]);

  const cols = useMemo((): Column<Property>[] => [
    {
      key: 'name',
      header: 'Property',
      render: (p) => (
        <div>
          <div style={{ fontWeight: 600 }}>{p.name}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {p.market} · <PropertyPageLink propertyId={p.id}>Page →</PropertyPageLink>
          </div>
        </div>
      ),
      sortValue: (p) => p.name,
    },
    { key: 'type', header: 'Type', render: (p) => <Badge tone="neutral">{p.type}</Badge>, sortValue: (p) => p.type },
    { key: 'sf', header: 'SF', align: 'right', render: (p) => fmtNum(p.sf), sortValue: (p) => p.sf },
    { key: 'occ', header: 'Occ', align: 'right', render: (p) => fmtPct(p.occPct), sortValue: (p) => p.occPct },
    {
      key: 'occDelta',
      header: 'Occ Δ · recorded',
      align: 'right',
      render: (p) => {
        const dlt = occDeltas.get(p.id);
        if (!dlt) return <span title="Fewer than two recorded monthly snapshots — no change shown" style={{ color: 'var(--text-tertiary)' }}>—</span>;
        return (
          <span title={`Lease-SF occupancy, recorded snapshots ${dlt.from} to ${dlt.to}`}>
            <span className="num">{fmtPp(dlt.deltaPp)}</span>
            <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}> · {dlt.spanMonths} mo</span>
          </span>
        );
      },
      sortValue: (p) => occDeltas.get(p.id)?.deltaPp ?? null,
    },
    {
      key: 'noi',
      // Basis named beside its ledger neighbour ("NOI 12m · ledger"): two NOIs, two bases, never compared.
      header: 'NOI · workbook',
      align: 'right',
      render: (p) =>
        // Audit 2026-11-12 HIGH #2: a blank workbook NOI is unknown, never "$0".
        hasBlankGovernorInput(p, 'noi') ? (
          BLANK_IN_WORKBOOK
        ) : landlordCostsNotSourced(p) ? (
          <span title="NNN, not absolute: landlord-paid roof, structure and paving costs are not sourced yet, so this NOI is overstated by them.">
            {fmtUsdCompact(p.noi)} <Badge tone="amber">LL costs not sourced</Badge>
          </span>
        ) : (
          fmtUsdCompact(p.noi)
        ),
      sortValue: (p) => p.noi,
    },
    {
      key: 'noi12',
      header: 'NOI 12m · ledger',
      render: (p) => {
        const s = sparks.get(p.id);
        if (!s) return <span title="No 12 consecutive P&L-ledger months for this property" style={{ color: 'var(--text-tertiary)' }}>—</span>;
        return (
          <div className="flex items-center gap-2" title={`P&L ledger, entity 100%, 12 months to ${s.through}: ${fmtUsdCompact(s.t12)}`}>
            <Sparkline data={s.months.map((m) => m.noi)} label={`${p.name} monthly NOI, P&L ledger entity 100%, 12 months to ${s.through}`} valueFormat={fmtUsdCompact} width={72} height={22} />
            <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{fmtUsdCompact(s.t12)}</span>
          </div>
        );
      },
      sortValue: (p) => sparks.get(p.id)?.t12 ?? null,
    },
    { key: 'cap', header: 'Cap', align: 'right', render: (p) => fmtPct(p.capRate), sortValue: (p) => p.capRate ?? 0 },
    { key: 'dscr', header: 'DSCR', align: 'right', render: (p) => (p.dscr !== null ? fmtMultiple(p.dscr) : '—'), sortValue: (p) => p.dscr ?? 0 },
    { key: 'ltv', header: 'LTV', align: 'right', render: (p) => propertyLtvLabel(p), sortValue: (p) => investmentLtv(p) ?? 0 },
    { key: 'value', header: 'Value', align: 'right', render: (p) => fmtUsdCompact(p.oxfordValue), sortValue: (p) => p.oxfordValue },
    {
      key: 'lender',
      header: 'Lender',
      render: (p) => p.lender ?? <span style={{ color: 'var(--text-tertiary)' }}>—</span>,
      sortValue: (p) => p.lender ?? '',
    },
  ], [sparks, occDeltas]);

  if (gate) return gate;
  if (!data || !analytics) return null;
  const props = data.snapshot.properties;
  const k = analytics.kpis;
  // Separate tiles here (on Overview the cap rate sits in the NOI tile's sublabel), so each figure
  // carries its own caveat: a reader of either tile alone still sees it.
  const llCaveat = landlordCostCaveat(props, { measure: 'this NOI' });
  const llCapCaveat = landlordCostCaveat(props, { measure: 'this weighted cap rate' });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {/* Same sublabel as the Overview KPI strip. Since 2026-10-30 the residence never reaches the
            snapshot (excluded at parse), so the other-holdings clause is empty on live data. */}
        <KpiStat label="Portfolio Value" value={k.value.value} format={fmtUsdCompact} prov={k.value.prov} sublabel={investmentPropertiesSublabel(k)} />
        <KpiStat
          label="Net Operating Income"
          value={k.noi.value}
          format={fmtUsdCompact}
          prov={k.noi.prov}
          sublabel={<BasisSublabel basis="workbook">Oxford share</BasisSublabel>}
          caveat={llCaveat ? <LandlordCostChip caveat={llCaveat} /> : undefined}
          accentColor="var(--color-pos)"
        />
        <KpiStat label="Portfolio SF" value={k.totalSf.value} format={fmtSf} prov={k.totalSf.prov} accentColor="var(--color-info)" />
        <KpiStat label="Weighted Cap Rate" value={k.weightedCapRate.value === null ? null : k.weightedCapRate.value * 100} format={(n) => (n === null ? '—' : `${n.toFixed(2)}%`)} prov={k.weightedCapRate.prov} sublabel={<BasisSublabel basis="workbook" />} caveat={llCapCaveat ? <LandlordCostChip caveat={llCapCaveat} /> : undefined} accentColor="var(--color-accent2)" />
      </div>

      <p className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        {fmtNum(k.propertyCount.value)} investment assets · the Sepich Portfolio bundles 8 buildings as one row · SF and value are Oxford-share; NOI 12m is the P&L ledger at entity 100%, and Occ Δ uses recorded monthly snapshots only.
      </p>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Property Detail — All Assets" trailing={<Badge tone="gold">{props.length} properties</Badge>} />
          <DataTable
            columns={cols}
            rows={props}
            getRowId={(p) => p.id}
            onRowClick={(p) => ui.openEntity({ type: 'property', id: p.id })}
            initialSort={{ key: 'value', dir: 'desc' }}
          />
        </Card>
        <Card>
          <CardHeader title="Value by Market" />
          <div className="p-3">
            <BarList
              items={analytics.marketByValue.map((m) => ({ label: m.market, value: m.value, display: fmtUsdCompact(m.value) }))}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
