// src/modules/acquisitions/EdgeView.tsx
//
// Acquisitions › Edge tab body (spec §8.2). Top to bottom: freshness banner, KPI strip, market board,
// data health, manual-pull queue. Lazy-mounted (no FORCE_MOUNT_PANEL): it fetches markets.json via
// the Brain Server and the pull queue from the warehouse. Each non-ok availability state replaces the
// board, health and queue bodies; the pull queue degrades on its own (503) while board + health stay.
import { fmtNum } from '@analytics/index';
import { SERIES_UNITS, type EdgeCoverageRow, type EdgeMarketsResponse, type EdgeUnit } from '@contracts/edge';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { isWarehouseUnavailable } from '../intel/hooks';
import { EdgeRankingBoard } from './EdgeRankingBoard';
import { EdgePullQueue } from './EdgePullQueue';
import { EDGE_PULL_SERIES, filterEdgeMarkets, useEdgeMarkets, useEdgePullQueue, type EdgeBoardState } from './edge-hooks';

const HEADING = { fontFamily: 'var(--font-display)', fontSize: '1.125rem', color: 'var(--text-primary)' } as const;
const NOTE = { color: 'var(--text-tertiary)', fontSize: '0.875rem' } as const;
const AMBER_BOX = {
  background: 'var(--color-warn-soft)',
  border: '1px solid var(--color-warn)',
  borderRadius: '0.375rem',
  padding: '0.625rem 0.875rem',
  fontSize: '0.8125rem',
  color: 'var(--text-warn)',
} as const;

const STATUS_LEGEND = 'actual · estimated · nowcast · guide only · not published';

const UNIT_LABEL: Record<EdgeUnit, string> = {
  pct_yoy: '% YoY',
  pct_level: '% level',
  ksf: 'kSF',
  per_10k: 'per 10k pop',
  usd: '$',
  persons: 'net persons',
  signal: 'signal (no unit)',
};

/** Where asOf came from: the meta.pulled date or the file mtime date; null when neither matches. */
function asOfSource(f: NonNullable<EdgeMarketsResponse['freshness']>): string | null {
  if (f.asOf === f.metaPulled) return `data pulled ${f.asOf}`;
  if (f.fileMtime !== 'unknown' && f.asOf === f.fileMtime.slice(0, 10)) return `file modified ${f.asOf}`;
  return null;
}

function EdgeFreshnessBanner({ data }: { data: EdgeMarketsResponse }) {
  const f = data.freshness;
  if (!f && !data.readError) return null;
  const source = f ? asOfSource(f) : null;
  // Stale without being old: clock skew, an invalid pulled date or an unknown mtime (ageDays is
  // clamped to 0). Say so instead of claiming an age the data does not support.
  const unverified = f !== null && f.stale && f.ageDays <= f.staleAfterDays;
  return (
    <div role="status" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {!f ? null : f.stale ? (
          <>
            <Badge tone="amber">STALE</Badge>
            <span className="text-xs" style={{ color: 'var(--text-warn)' }}>
              {unverified
                ? `Edge dataset as of ${f.asOf} — Date could not be verified (file timestamp in the future or unreadable) — treated as stale. Firm rule: a mirror more than ${f.staleAfterDays} days behind is never presented as current.`
                : `Edge dataset as of ${f.asOf} — ${f.ageDays} days old. Firm rule: a mirror more than ${f.staleAfterDays} days behind is never presented as current.`}
            </span>
          </>
        ) : (
          <Badge tone="neutral">{`As of ${f.asOf}`}</Badge>
        )}
        {source && <span className="text-2xs" style={NOTE}>{source}</span>}
      </div>
      {data.readError && (
        <p className="text-xs" style={{ color: 'var(--text-neg)' }}>
          {`Last re-read failed (${data.readError}); showing the copy loaded at ${data.lastGoodLoadedAt ?? 'an earlier load'}.`}
        </p>
      )}
    </div>
  );
}

function CoverageBars({ byYear, markets }: { byYear: number[]; markets: number }) {
  return (
    <span className="inline-flex items-end gap-0.5" aria-hidden style={{ height: 16 }}>
      {byYear.map((n, i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: markets === 0 ? 1 : Math.max(1, Math.round((n / markets) * 16)),
            background: n === 0 ? 'var(--border-strong)' : 'var(--accent)',
          }}
        />
      ))}
    </span>
  );
}

function EdgeDataHealth({ data }: { data: EdgeMarketsResponse }) {
  const withSubs = data.markets.filter((m) => m.subs.length > 0).length;
  const columns: Column<EdgeCoverageRow>[] = [
    {
      key: 'label',
      header: 'Series',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <span>{data.fieldMeta[r.field]?.trueLabel ?? 'Unlabelled series'}</span>
          {data.fieldMeta[r.field]?.isProxy && <Badge tone="purple">[PROXY]</Badge>}
          {r.allPlaceholder && EDGE_PULL_SERIES.has(r.field) && (
            <a href={`#edge-pull-${r.field}`} aria-label="Manual pull required">
              <Badge tone="amber">Manual pull required</Badge>
            </a>
          )}
          {r.inconsistent.length > 0 && <Badge tone="amber">{`${r.inconsistent.length} inconsistent`}</Badge>}
        </span>
      ),
    },
    { key: 'unit', header: 'Unit', render: (r) => UNIT_LABEL[SERIES_UNITS[r.field]] },
    { key: 'coverage', header: 'Coverage', align: 'right', render: (r) => `${(r.pct * 100).toFixed(0)}% (${r.filled}/${r.total})` },
    { key: 'byYear', header: 'By year', render: (r) => <CoverageBars byYear={r.byYear} markets={data.marketCount} /> },
    {
      key: 'mix',
      header: 'Status mix',
      render: (r) => (
        <span className="num text-2xs" title={STATUS_LEGEND} aria-label={STATUS_LEGEND}>
          {`A${r.statusCounts.actual} · E ${r.statusCounts.estimated} · N ${r.statusCounts.nowcast} · G ${r.statusCounts.guide_only} · — ${r.statusCounts.null}`}
        </span>
      ),
    },
    {
      key: 'sources',
      header: 'Source codes',
      render: (r) => (
        <span className="text-2xs" style={{ fontFamily: 'var(--font-mono)' }}>
          {(data.sources[r.field] ?? []).join(', ') || '—'}
        </span>
      ),
    },
  ];
  const outside = data.outsidePullScope;
  return (
    <Card>
      <CardHeader title="Data health" />
      <div className="p-3">
        <DataTable columns={columns} rows={data.coverage} getRowId={(r) => r.field} minWidth={960} />
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        <p>{`${withSubs}/${data.marketCount} markets — ${data.marketCount - withSubs} metro-only markets have no CoStar submarket breakdown (permanent).`}</p>
        <p>{`Outside pull scope — truck: ${outside.truck.join(', ') || 'none'} · mfgInvest: ${outside.mfgInvest.join(', ') || 'none'}`}</p>
      </div>
    </Card>
  );
}

function EdgeBody({
  data, openPulls, queueState, board, onBoardChange,
}: {
  data: EdgeMarketsResponse;
  openPulls: number | null;
  queueState: 'loading' | 'error' | 'ready';
  board: EdgeBoardState;
  onBoardChange: (next: EdgeBoardState) => void;
}) {
  if (data.availability === 'missing') {
    return <p role="status" style={NOTE}>{`markets.json not found at ${data.dir}. Set OXFORD_EDGE_DIR in .env on this machine.`}</p>;
  }
  if (data.availability === 'unreadable') {
    return (
      <p role="status" style={NOTE}>
        {`markets.json could not be read (OneDrive lock or sync in progress?): ${data.issues[0] ?? 'unknown error'}. Retrying on next load.`}
      </p>
    );
  }
  if (data.availability === 'invalid') {
    return (
      <div role="alert" className="flex flex-col gap-1" style={AMBER_BOX}>
        <p>markets.json failed schema validation — the upstream file changed shape.</p>
        <ul className="list-disc pl-5">
          {data.issues.slice(0, 5).map((issue, i) => <li key={`${i}-${issue}`}><code>{issue}</code></li>)}
        </ul>
      </div>
    );
  }

  const buyBox = filterEdgeMarkets(data.markets, 'buybox').length;
  const fullyReal = data.coverage.filter((r) => r.pct === 1).length;
  return (
    <>
      <EdgeFreshnessBanner data={data} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Markets loaded" value={data.marketCount} format={fmtNum} accentColor="var(--accent)" />
        <KpiStat label="Buy-box markets" value={buyBox} format={fmtNum} accentColor="var(--color-info)" />
        <KpiStat label="Series fully real" value={fullyReal} format={fmtNum} sublabel={`of ${data.coverage.length}`} accentColor="var(--color-pos)" />
        <KpiStat
          label="Open manual pulls"
          value={openPulls}
          format={fmtNum}
          sublabel={
            queueState === 'loading' ? 'loading queue…'
              : queueState === 'error' ? 'queue unavailable'
                : `across the ${EDGE_PULL_SERIES.size} manual pulls`
          }
          accentColor={openPulls !== null && openPulls > 0 ? 'var(--color-warn)' : 'var(--color-pos)'}
        />
      </div>
      {data.rejectedMarkets.length > 0 && (
        <div role="alert" style={AMBER_BOX}>
          {data.rejectedMarkets.map((r, i) => (
            <p key={`${i}-${r.id ?? 'no-id'}-${r.reason}`}>{`Rejected from markets.json: ${r.id ?? '(no id)'} — ${r.reason}`}</p>
          ))}
        </div>
      )}
      <EdgeRankingBoard data={data} board={board} onBoardChange={onBoardChange} />
      <EdgeDataHealth data={data} />
      <EdgePullQueue />
    </>
  );
}

export function EdgeView({ board, onBoardChange }: { board: EdgeBoardState; onBoardChange: (next: EdgeBoardState) => void }) {
  const { data, isLoading, error } = useEdgeMarkets();
  const queue = useEdgePullQueue();
  const openPulls = queue.data ? queue.data.items.reduce((sum, item) => sum + item.counts.open, 0) : null;
  const queueState = queue.data ? 'ready' : queue.error ? 'error' : 'loading';

  return (
    <section className="flex flex-col gap-4">
      <h2 style={HEADING}>Oxford Edge</h2>
      {isLoading ? (
        <Skeleton className="h-40" />
      ) : isWarehouseUnavailable(error) ? (
        <p style={NOTE}>Edge is local-only — start the Brain Server on the workstation.</p>
      ) : error || !data ? (
        <p role="alert" style={NOTE}>Edge market data could not be loaded. Try again shortly.</p>
      ) : (
        <EdgeBody data={data} openPulls={openPulls} queueState={queueState} board={board} onBoardChange={onBoardChange} />
      )}
    </section>
  );
}
