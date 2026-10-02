// src/modules/acquisitions/EdgeRankingBoard.tsx
//
// Oxford Edge market board (spec §8.3). Every market is a row; there is NO rank column and no
// composite: ordering comes only from the sort control over observed series values, so the board
// cannot be read as a score (spec §2 non-goals). Sort key/direction, set filter, buy-box pin and the
// picker columns are props lifted into AcquisitionsModule, so they survive a tab round-trip without
// FORCE_MOUNT_PANEL.
//
// DataTable's own header sort is deliberately unused (no column sets sortValue): it cannot express
// the pinned two-group order and does not report its internal sort for lifting. DataTable has no
// expandable rows, so a row click opens the detail panel directly beneath the table; its headers are
// plain strings, so header tooltips are replaced by the always-visible "Column definitions" list.
import { useId, useState } from 'react';
import { EDGE_OBSERVED_STATUSES, SERIES_UNITS, type EdgeMarket, type EdgeMarketsResponse, type EdgeSeriesKey } from '@contracts/edge';
import { Card, CardHeader } from '@/primitives/Card';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge } from '@/primitives/Badge';
import { SegmentedControl } from '@/primitives/SegmentedControl';
import { Sparkline } from '@/charts/Sparkline';
import {
  EDGE_BOARD_COLUMNS, EDGE_PICKER_SERIES, edgeCellDisplay, edgeSeriesHeader, edgeStatusLabel, filterEdgeMarkets,
  formatEdgeValue, isBuyBox, sortEdgeMarkets,
  type EdgeBoardSortKey, type EdgeBoardState, type EdgeSetFilter,
} from './edge-hooks';

const TRAJECTORY_LABEL: Record<NonNullable<EdgeMarket['trajectory']>, string> = {
  a_growing: 'Growing',
  b_stable: 'Stable',
  c_reversing: 'Reversing',
};

const CONTROL_STYLE = {
  fontSize: '0.75rem',
  padding: '0.25rem 0.5rem',
  border: '1px solid var(--border-subtle)',
  borderRadius: '0.25rem',
  background: 'var(--surface-raised)',
  color: 'var(--text-primary)',
} as const;

const MUTED = { color: 'var(--text-tertiary)' } as const;

// Mirrors the sync-button convention in AcquisitionsModule; :focus-visible is global (tokens/theme.css).
const DETAILS_BUTTON_STYLE = {
  ...CONTROL_STYLE,
  fontFamily: 'var(--font-mono)',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  cursor: 'pointer',
} as const;

/** Visible Est./Nowcast marker; wording comes from edgeStatusLabel (via edgeCellDisplay) so it stays single-sourced. */
function StatusMarker({ label }: { label: string | null }) {
  if (!label) return null;
  return <span className="text-2xs" style={{ ...MUTED, marginLeft: '0.25rem' }}>{label}</span>;
}

interface Props {
  data: EdgeMarketsResponse;
  board: EdgeBoardState;
  onBoardChange: (next: EdgeBoardState) => void;
}

function EdgeValue({ market, field, years }: { market: EdgeMarket; field: EdgeSeriesKey; years: readonly number[] }) {
  const d = edgeCellDisplay(market.series[field], SERIES_UNITS[field], years, field);
  const style = d.dotted ? { borderBottom: '1px dotted var(--text-tertiary)' } : d.observed ? undefined : MUTED;
  return (
    <span>
      <span title={d.title ?? undefined} style={style}>
        {d.text}
      </span>
      {d.dotted && <StatusMarker label={d.title} />}
    </span>
  );
}

/** Sparkline takes number[] only, so unpublished years are dropped rather than drawn as gaps. */
function observedValues(market: EdgeMarket, field: EdgeSeriesKey): number[] {
  return market.series[field].values.filter((v): v is number => v !== null);
}

function EdgeMarketDetail({ id, market, data, onClose }: { id: string; market: EdgeMarket; data: EdgeMarketsResponse; onClose: () => void }) {
  return (
    <div
      id={id}
      role="region"
      aria-label={`${market.name} detail`}
      className="mx-3 mb-3 rounded-[var(--radius-md)] p-3"
      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
          {`${market.name}, ${market.state} · CBSA ${market.cbsa}`}
        </h3>
        <button type="button" onClick={onClose} style={CONTROL_STYLE}>Close</button>
      </div>
      {market.subs.length === 0 ? (
        <p className="text-2xs" style={MUTED}>CoStar publishes no submarket breakdown for this metro.</p>
      ) : (
        <table className="ora-table mb-3 w-full text-xs">
          <thead>
            <tr>
              <th className="text-left">Submarket</th>
              <th className="text-right">Flex vacancy</th>
              <th className="text-right">Rent growth</th>
              <th className="text-right">Inventory</th>
            </tr>
          </thead>
          <tbody>
            {market.subs.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="num text-right">{formatEdgeValue(s.vac, 'pct_level')}</td>
                <td className="num text-right">{formatEdgeValue(s.rentGrowth, 'pct_yoy')}</td>
                <td className="num text-right">{formatEdgeValue(s.invKsf, 'ksf')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="ora-table w-full text-xs">
        <thead>
          <tr>
            <th className="text-left">Series</th>
            {data.years.map((y) => <th key={y} className="text-right">{y}</th>)}
          </tr>
        </thead>
        <tbody>
          {EDGE_BOARD_COLUMNS.map(({ field, header }) => (
            <tr key={field}>
              <td>{header}</td>
              {data.years.map((y, i) => {
                const value = market.series[field].values[i] ?? null;
                const status = market.series[field].status[i] ?? 'null';
                const label = edgeStatusLabel(status);
                // Gate on the observed statuses: a non-null value under guide_only/null never renders as a number.
                const observed = value !== null && EDGE_OBSERVED_STATUSES.includes(status);
                const text = observed ? (formatEdgeValue(value, SERIES_UNITS[field]) ?? '—') : (label.text ?? 'Not published');
                return (
                  <td
                    key={y}
                    className="num text-right"
                    title={label.title ?? undefined}
                    style={observed && label.dotted ? { borderBottom: '1px dotted var(--text-tertiary)' } : observed ? undefined : MUTED}
                  >
                    {text}
                    {observed && label.dotted && <StatusMarker label={label.title} />}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EdgeRankingBoard({ data, board, onBoardChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailId = useId();
  const patch = (next: Partial<EdgeBoardState>) => onBoardChange({ ...board, ...next });

  const setOptions: ReadonlyArray<{ value: EdgeSetFilter; label: string }> = [
    { value: 'buybox', label: `Buy-box (${filterEdgeMarkets(data.markets, 'buybox').length})` },
    { value: 'all', label: `All (${data.markets.length})` },
    { value: 'auto', label: `Auto (${filterEdgeMarkets(data.markets, 'auto').length})` },
  ];
  const seriesColumns: ReadonlyArray<{ field: EdgeSeriesKey; header: string }> = [
    ...EDGE_BOARD_COLUMNS,
    ...board.extraColumns.map((field) => ({ field, header: edgeSeriesHeader(field, data.fieldMeta) })),
  ];
  const rows = sortEdgeMarkets(filterEdgeMarkets(data.markets, board.set), board, data.years);

  const toggleExtra = (field: EdgeSeriesKey) => {
    const removing = board.extraColumns.includes(field);
    patch({
      extraColumns: removing ? board.extraColumns.filter((f) => f !== field) : [...board.extraColumns, field],
      sortKey: removing && board.sortKey === field ? 'trades' : board.sortKey,
    });
  };

  const toggleSelected = (id: string) => setSelectedId((cur) => (cur === id ? null : id));
  const changeSet = (set: EdgeSetFilter) => {
    // A market hidden by the new filter must not keep its detail panel open.
    if (selectedId !== null && !filterEdgeMarkets(data.markets, set).some((m) => m.id === selectedId)) setSelectedId(null);
    patch({ set });
  };

  const columns: Column<EdgeMarket>[] = [
    {
      key: 'market',
      header: 'Market',
      render: (m) => (
        <div className="flex items-center gap-1.5">
          <span style={{ fontWeight: 600 }}>{`${m.name}, ${m.state}`}</span>
          {isBuyBox(m) ? <Badge tone="gold">Buy-box</Badge> : <Badge tone="neutral">Auto</Badge>}
          {m.trajectory && <span className="text-2xs" style={MUTED}>{TRAJECTORY_LABEL[m.trajectory]}</span>}
          <button
            type="button"
            aria-label={`Show details for ${m.name}, ${m.state}`}
            aria-expanded={selectedId === m.id}
            aria-controls={detailId}
            onClick={(e) => { e.stopPropagation(); toggleSelected(m.id); }}
            style={DETAILS_BUTTON_STYLE}
          >
            Details
          </button>
        </div>
      ),
    },
    ...seriesColumns.map(
      ({ field, header }): Column<EdgeMarket> => ({
        key: field,
        header,
        align: 'right',
        render: (m) =>
          field === 'trades' ? (
            <span className="inline-flex items-center gap-2">
              <EdgeValue market={m} field={field} years={data.years} />
              <Sparkline data={observedValues(m, 'trades')} width={56} height={18} />
            </span>
          ) : (
            <EdgeValue market={m} field={field} years={data.years} />
          ),
      }),
    ),
  ];

  // Derived from the visible rows too, so the panel can never show a market the table is not showing.
  const selected = selectedId !== null ? (rows.find((m) => m.id === selectedId) ?? null) : null;

  return (
    <Card>
      <CardHeader title="Market board" trailing={<Badge tone="neutral">Sorted by observed values · no composite rank</Badge>} />
      <div className="flex flex-wrap items-center gap-3 px-3 pt-3">
        <SegmentedControl aria-label="Market set" options={setOptions} value={board.set} onChange={changeSet} />
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={board.pinBuyBox} disabled={board.set !== 'all'} onChange={(e) => patch({ pinBuyBox: e.target.checked })} />
          Pin buy-box
        </label>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          Sort by
          <select
            aria-label="Sort board by"
            value={board.sortKey}
            onChange={(e) => patch({ sortKey: e.target.value as EdgeBoardSortKey })}
            style={CONTROL_STYLE}
          >
            <option value="name">Market</option>
            {seriesColumns.map((c) => <option key={c.field} value={c.field}>{c.header}</option>)}
          </select>
        </label>
        <button
          type="button"
          aria-label={`Sort direction: ${board.sortDir === 'asc' ? 'ascending' : 'descending'} — activate to toggle`}
          onClick={() => patch({ sortDir: board.sortDir === 'asc' ? 'desc' : 'asc' })}
          style={CONTROL_STYLE}
        >
          {board.sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
        </button>
      </div>
      <fieldset className="px-3 pt-2">
        <legend className="text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>Add series columns</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {EDGE_PICKER_SERIES.map((field) => (
            <label key={field} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={board.extraColumns.includes(field)} onChange={() => toggleExtra(field)} />
              {edgeSeriesHeader(field, data.fieldMeta)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="p-3">
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(m) => m.id}
          onRowClick={(m) => toggleSelected(m.id)}
          minWidth={900}
        />
      </div>
      {selected && <EdgeMarketDetail id={detailId} market={selected} data={data} onClose={() => setSelectedId(null)} />}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 px-3 pb-2 text-2xs md:grid-cols-2" style={MUTED}>
        {EDGE_BOARD_COLUMNS.map(({ field, header }) => (
          <div key={field} className="flex gap-1.5">
            <dt style={{ fontWeight: 600 }}>{header}</dt>
            <dd>{data.fieldMeta[field]?.trueLabel ?? 'Unlabelled series'}</dd>
          </div>
        ))}
      </dl>
      <p className="px-3 pb-3 text-2xs" style={MUTED}>
        Rent / vacancy / pipeline are CoStar Industrial Flex slice — not a ≤50K SF cut. Multi-state CBSAs list their primary state only.
      </p>
    </Card>
  );
}
