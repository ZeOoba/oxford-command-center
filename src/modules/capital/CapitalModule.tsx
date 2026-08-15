// src/modules/capital/CapitalModule.tsx
//
// Phase 5 W2 — Capital Allocation capstone module.
// Panels:
//   1. Portfolio Allocation — ranked AllocationCard list across all assets
//      (buildPortfolioAllocation → GET /api/warehouse/capital/allocate).
//   2. Market Cap-Rate Positioning — implied cap rate vs external market benchmarks +
//      IC Memo export + Notion writeback (buildCapitalAllocationReport →
//      GET /api/warehouse/capital-allocation). Folded in from the now-deleted
//      CapitalAllocationModule.tsx (see below — this is a DIFFERENT engine and data
//      shape than panel 1, joined only by propertyId for display purposes).
//   3. Pipeline — T1/T2 candidates from portfolio.pipeline.
// Top: HurdleRateBanner (visible while hurdle rate is proposed).
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileDown, UploadCloud } from 'lucide-react';
import type { AllocationAction } from '@contracts/capital';
import { CapitalAllocationReport } from '@contracts/capital-allocation';
import type { CapitalAllocationEntry } from '@contracts/capital-allocation';
import { NotionSyncResult } from '@contracts/notion-writeback';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { Skeleton } from '@/primitives/Skeleton';
import { DataTable, type Column } from '@/primitives/DataTable';
import { useToast } from '@/primitives/toast-context';
import { useCapitalAllocation, actionLabel, actionColor, actionFillColor } from './hooks';
import { AllocationCard } from './AllocationCard';
import { HurdleRateBanner } from './HurdleRateBanner';

function fmtPct(n: number | null): string {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

// ── Market cap-rate positioning ──────────────────────────────────────────────────
// Folded in from CapitalAllocationModule.tsx (deleted — this was its only mounted home).
// Sourced from GET /api/warehouse/capital-allocation (CapitalAllocationReport), produced by
// buildCapitalAllocationReport — a DIFFERENT engine than buildPortfolioAllocation above.
// All fail-open: null inputs render '—'. capRatePercentile is a discrete band
// (bottom/median/top) — never interpolated. Diagnostic only — does not feed capitalAction
// or priorityScore in either engine.

function useCapitalAllocationReport() {
  return useQuery({
    queryKey: ['warehouse', 'capital-allocation', 'report'] as const,
    queryFn: () =>
      fetchParsedOrMirror('/api/warehouse/capital-allocation', CapitalAllocationReport),
    ...QUERY_OPTS,
  });
}

/**
 * Mutation: write the current capital decisions back to the Notion Property Register.
 * The route recomputes the report server-side, so no request body is needed. The response is
 * Zod-validated against NotionSyncResult; a non-2xx (e.g. 400 NOTION_TOKEN not configured)
 * surfaces a thrown Error the caller turns into an error toast.
 */
async function postCapitalNotionSync(): Promise<NotionSyncResult> {
  const res = await fetch('/api/warehouse/capital-allocation/sync-notion', { method: 'POST' });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json && typeof json === 'object' && 'error' in json ? String((json as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return NotionSyncResult.parse(json);
}

function fmtCapRate(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

/** Signed gap in basis points vs market median. Positive = higher yield than market. */
function fmtCapRateGap(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const bps = Math.round(n * 10_000);
  return `${bps >= 0 ? '+' : ''}${bps} bps`;
}

function capBandLabel(band: CapitalAllocationEntry['capRatePercentile']): string {
  switch (band) {
    case 'bottom': return 'Below mkt';
    case 'median': return 'At mkt';
    case 'top': return 'Above mkt';
    default: return '—';
  }
}

function capBandTone(band: CapitalAllocationEntry['capRatePercentile']): BadgeTone {
  // Cap-rate level only — NOT a desirability judgment. 'top' = higher yield / cheaper basis.
  switch (band) {
    case 'top': return 'green';
    case 'median': return 'neutral';
    case 'bottom': return 'amber';
    default: return 'neutral';
  }
}

const CAP_RATE_COLS: Column<CapitalAllocationEntry>[] = [
  {
    key: 'property',
    header: 'Property',
    render: (e) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>
          {e.propertyName ?? e.propertyId}
        </div>
        {e.market && (
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {e.market}
          </div>
        )}
      </div>
    ),
    sortValue: (e) => e.propertyName ?? e.propertyId,
  },
  {
    key: 'impliedCap',
    header: 'Implied Cap',
    align: 'right',
    render: (e) => (
      <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
        {fmtCapRate(e.impliedCapRate)}
      </span>
    ),
    sortValue: (e) => e.impliedCapRate ?? -1,
  },
  {
    key: 'capGap',
    header: 'vs Mkt',
    align: 'right',
    render: (e) => (
      <span
        className="num text-xs"
        style={{
          color: e.capRateGap === null
            ? 'var(--text-tertiary)'
            : e.capRateGap >= 0
            ? 'var(--text-pos)'
            : 'var(--text-warn)',
        }}
      >
        {fmtCapRateGap(e.capRateGap)}
      </span>
    ),
    sortValue: (e) => e.capRateGap ?? -999,
  },
  {
    key: 'capBand',
    header: 'Cap Band',
    render: (e) =>
      e.capRatePercentile === null ? (
        <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>—</span>
      ) : (
        <Badge tone={capBandTone(e.capRatePercentile)}>{capBandLabel(e.capRatePercentile)}</Badge>
      ),
    sortValue: (e) => e.capRatePercentile ?? '',
  },
];

// Export IC Memo — opens the server-rendered IC Memo HTML (Content-Disposition: attachment) in
// a new tab. The browser downloads the ORA-styled memo; the user prints it to a PDF (extractable
// text) for Investment Committee circulation. Folded in verbatim from CapitalAllocationModule.tsx.
const IC_MEMO_URL = '/api/warehouse/capital-allocation/ic-memo';

function ExportIcMemoButton({ disabled }: { disabled: boolean }) {
  return (
    <a
      href={disabled ? undefined : IC_MEMO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-disabled={disabled}
      tabIndex={0}
      title={
        disabled
          ? 'No scored properties to export'
          : 'Download an ORA-styled IC memo (print to PDF for circulation)'
      }
      className="inline-flex items-center gap-1.5 rounded text-2xs font-medium"
      style={{
        padding: '4px 10px',
        border: '1px solid var(--accent)',
        color: disabled ? 'var(--text-tertiary)' : 'var(--text-accent)',
        background: 'transparent',
        textDecoration: 'none',
        pointerEvents: disabled ? 'none' : 'auto',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <FileDown size={13} />
      Export IC Memo
    </a>
  );
}

export function CapitalModule() {
  const { data, isLoading, error } = useCapitalAllocation();
  const { data: report, isLoading: reportLoading, error: reportError } = useCapitalAllocationReport();
  const { toast } = useToast();
  const notionSync = useMutation({
    mutationFn: postCapitalNotionSync,
    onSuccess: (r) => {
      const errCount = r.errors.length;
      toast({
        tone: errCount > 0 ? 'info' : 'success',
        title: `Synced ${r.synced} to Notion`,
        description: `${r.skipped} skipped${errCount > 0 ? ` · ${errCount} error${errCount > 1 ? 's' : ''}` : ''}`,
      });
    },
    onError: (e) =>
      toast({
        tone: 'error',
        title: 'Notion sync failed',
        description: e instanceof Error ? e.message : String(e),
      }),
  });

  if (isLoading) return (
    <div className="flex flex-col gap-4">
      {[1, 2, 3].map(i => <Skeleton key={i} style={{ height: 80, borderRadius: 8 }} />)}
    </div>
  );

  if (error || !data) return (
    <Card>
      <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
        Capital allocation data unavailable — warehouse may be offline.
      </div>
    </Card>
  );

  const { portfolio, hurdleRate } = data;
  const actionEntries = Object.entries(portfolio.actionCounts) as Array<[string, number]>;
  const capEntries = report?.entries ?? [];
  const bench = report?.marketBenchmarks;
  // Round 8 fresh-sweep: actionCounts silently absorbs withheld-because-distrusted verdicts into
  // whatever action they collapsed to (usually 'hold') with no indication anything was withheld.
  // 'buy' is excluded — bookTrust:'unknown' there is a "not applicable" placeholder, not distrust
  // (see AllocationCard.tsx / filterTrustedVerdicts for the same distinction).
  const distrustedCount = portfolio.verdicts.filter(
    (v) => v.action !== 'buy' && v.inputs.bookTrust !== 'trusted',
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Advisory banner — shown while hurdle rate is proposed */}
      <HurdleRateBanner hurdleRate={hurdleRate} />

      {/* Summary header */}
      <Card>
        <CardHeader
          title="Capital Allocation"
          trailing={
            <div style={{ display: 'flex', gap: 6 }}>
              {distrustedCount > 0 && (
                <Badge tone="red">{distrustedCount} on untrusted book</Badge>
              )}
              {actionEntries.filter(([, n]) => n > 0).map(([action, count]) => (
                <span key={action} style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                  background: `color-mix(in oklab, ${actionFillColor(action as AllocationAction)} 12%, transparent)`,
                  color: actionColor(action as AllocationAction),
                  border: `1px solid color-mix(in oklab, ${actionFillColor(action as AllocationAction)} 35%, transparent)`,
                }}>
                  {actionLabel(action as AllocationAction)} {count}
                </span>
              ))}
            </div>
          }
        />
      </Card>

      {/* Portfolio allocation list */}
      <div className="flex flex-col gap-3">
        {portfolio.verdicts.length === 0 ? (
          <Card>
            <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
              No verdicts — run a full warehouse ingest first.
            </div>
          </Card>
        ) : (
          portfolio.verdicts.map(v => (
            <AllocationCard
              key={v.propertyId}
              verdict={v}
              hurdleRatePct={hurdleRate.hurdleRatePct}
            />
          ))
        )}
      </div>

      {/* Market Cap-Rate Positioning — folded in from CapitalAllocationModule.tsx */}
      <Card>
        <CardHeader
          title="Market Cap-Rate Positioning"
          trailing={
            <div className="flex items-center gap-1.5">
              <ExportIcMemoButton disabled={capEntries.length === 0} />
              {bench && (
                !bench.available || bench.source === 'unavailable' ? (
                  <Badge tone="neutral">Cap benchmarks offline</Badge>
                ) : bench.source === 'seed' ? (
                  <Badge tone="amber">Cap benchmarks: seeded</Badge>
                ) : (
                  <Badge tone="green">Cap benchmarks: live</Badge>
                )
              )}
              <Button
                variant="subtle"
                size="sm"
                onPress={() => notionSync.mutate()}
                isDisabled={notionSync.isPending || capEntries.length === 0}
                aria-label="Sync capital decisions to Notion"
              >
                <UploadCloud size={13} />
                {notionSync.isPending ? 'Syncing…' : 'Sync to Notion'}
              </Button>
            </div>
          }
        />
        {reportLoading ? (
          <div style={{ padding: 16 }}>
            <Skeleton style={{ height: 120, borderRadius: 8 }} />
          </div>
        ) : reportError || !report ? (
          <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
            Cap-rate positioning unavailable — warehouse capital-allocation report offline.
          </div>
        ) : capEntries.length === 0 ? (
          <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
            No properties scored yet.
          </div>
        ) : (
          <DataTable
            columns={CAP_RATE_COLS}
            rows={capEntries}
            getRowId={(e) => e.propertyId}
            initialSort={{ key: 'capGap', dir: 'desc' }}
            minWidth={480}
          />
        )}
      </Card>

      {/* Pipeline candidates */}
      {portfolio.pipeline.length > 0 && (
        <Card>
          <CardHeader title="Buy Pipeline" trailing={<Badge tone="neutral">{portfolio.pipeline.length} candidates</Badge>} />
          <div style={{ padding: '8px 0' }}>
            {portfolio.pipeline.map(c => (
              <div key={c.candidateId} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 13,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{c.address ?? c.candidateId}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{c.market ?? '—'}</div>
                </div>
                {c.tier && <Badge tone={c.tier === 'T1' ? 'green' : 'neutral'}>{c.tier}</Badge>}
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  IRR {fmtPct(c.leveredIrr)}
                </span>
                {c.basisDiscountPct !== null && (
                  <span style={{ fontSize: 12, color: 'var(--text-pos)' }}>
                    {fmtPct(c.basisDiscountPct)} disc.
                  </span>
                )}
                {c.composite !== null && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {Math.round(c.composite)}/100
                  </span>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Cap-rate methodology footnote */}
      <div className="px-1 pb-1">
        <p className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Implied cap = Spine-A NOI ÷ Oxford-share workbook value; “vs Mkt” and Cap Band compare
          against external market benchmarks
          {bench && (!bench.available || bench.source === 'unavailable')
            ? ' (benchmarks unavailable — cap columns blank).'
            : bench?.source === 'seed'
            ? ' (seeded snapshot — set a live feed for FRED-backed bands).'
            : ' (live feed).'}{' '}
          Cap Band is a discrete position (below / at / above market), not a continuous percentile,
          and is diagnostic only — it does not affect the priority score or capital action in
          either engine above.
        </p>
      </div>
    </div>
  );
}
