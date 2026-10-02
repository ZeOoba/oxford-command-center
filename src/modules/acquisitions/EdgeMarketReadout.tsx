// src/modules/acquisitions/EdgeMarketReadout.tsx
//
// Deal-level Oxford Edge readout (spec §8.4) for the DealDrawer "Edge Market" card. Its own file so
// the drawer (shell bundle) imports only this component plus the pure edge-hooks helpers, never the
// board or queue. Resolution is client-side against markets already fetched: no deal identity is
// sent to /api/warehouse/edge/* (spec §5.4). Confidential deals get a readout too — internal UI,
// public-source market data. Stale data always shows the STALE badge next to the numbers.
import type { Deal } from '@contracts/index';
import { SERIES_UNITS } from '@contracts/edge';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { useUi } from '@/brain/ui-context';
import { isWarehouseUnavailable } from '../intel/hooks';
import { EDGE_READOUT_SERIES, EDGE_UNMATCHED_TEXT, edgeCellDisplay, edgeUnmatchedHeadline, resolveEdgeMarket, useEdgeMarkets } from './edge-hooks';

const TERTIARY = { color: 'var(--text-tertiary)' } as const;

export function EdgeMarketReadout({ deal, onNavigate }: { deal: Pick<Deal, 'market' | 'location'>; onNavigate?: () => void }) {
  const ui = useUi();
  const { data, isLoading, error } = useEdgeMarkets();

  if (isLoading) return <Skeleton className="h-16" />;
  if (isWarehouseUnavailable(error)) {
    return <p className="text-2xs" style={TERTIARY}>Edge is local-only — start the Brain Server on the workstation.</p>;
  }
  if (error || !data) {
    return <p className="text-2xs" style={TERTIARY}>Edge market data could not be loaded. Open Acquisitions › Edge for detail.</p>;
  }
  if (data.availability !== 'ok') {
    return <p className="text-2xs" style={TERTIARY}>{`Edge dataset ${data.availability} — open Acquisitions › Edge for detail.`}</p>;
  }

  const viewInEdge = (
    <button
      type="button"
      onClick={() => {
        ui.openTab('pipeline', 'edge');
        onNavigate?.();
      }}
      className="text-2xs font-semibold"
      style={{ color: 'var(--text-accent)' }}
    >
      View in Edge
    </button>
  );

  const res = resolveEdgeMarket(deal, data.markets);
  if (res.kind === 'unmatched') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{edgeUnmatchedHeadline(res.reason)}</span>
        <span className="text-2xs" style={TERTIARY}>{EDGE_UNMATCHED_TEXT[res.reason]}</span>
        <div>{viewInEdge}</div>
      </div>
    );
  }

  const { market } = res;
  const fresh = data.freshness;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{`${market.name}, ${market.state}`}</span>
        {fresh && (
          <span className="flex items-center gap-1.5">
            {fresh.stale ? <Badge tone="amber">STALE</Badge> : <Badge tone="neutral">{`As of ${fresh.asOf}`}</Badge>}
            {fresh.stale && <span className="num text-2xs" style={TERTIARY}>{`as of ${fresh.asOf}`}</span>}
          </span>
        )}
      </div>
      {EDGE_READOUT_SERIES.map(({ field, label }) => {
        const d = edgeCellDisplay(market.series[field], SERIES_UNITS[field], data.years, field);
        return (
          <div
            key={field}
            className="flex items-center justify-between gap-3 py-1"
            style={{ borderTop: '1px solid color-mix(in oklab, var(--border-subtle) 60%, transparent)' }}
          >
            <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>{label}</span>
            <span
              className="num text-right text-xs"
              title={d.title ?? undefined}
              style={
                d.dotted
                  ? { color: 'var(--text-primary)', borderBottom: '1px dotted var(--text-tertiary)' }
                  : { color: d.observed ? 'var(--text-primary)' : 'var(--text-tertiary)' }
              }
            >
              {d.text}
            </span>
          </div>
        );
      })}
      <div className="pt-1">{viewInEdge}</div>
    </div>
  );
}
