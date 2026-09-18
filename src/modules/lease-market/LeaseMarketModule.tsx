// src/modules/lease-market/LeaseMarketModule.tsx
//
// Lease Market Intelligence UI (spec rev 3 §4): KPI row + Portfolio · Market Rents · Acquisition Radar ·
// Changes · Data Quality. All rents are ASKING rents on an NNN-equivalent basis. Degrades on the static mirror.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { BarChart } from '@/charts/BarChart';
import { RentCurve } from '@/charts/RentCurve';
import { isWarehouseUnavailable, useWarehouseLive } from '../intel/hooks';
import type {
  CellBenchmark, CompRow, ListedButLeased, ListingEventRow, ListingHygieneFlag, MarketDataQuality, MarketFreshness, PositioningRow,
  RadarCandidate, SignalRow,
} from '@contracts/lease-market';
import {
  DECISION_LABELS, EVENT_LABELS, KIND_LABELS, bandLabel, bandTone, confidenceTone, curvePointsFor, eventSummary, evidenceSummary, fmtPct,
  fmtPsf, fmtSf, fmtUsd, radarWhy, severityTone, sourceLabel, sourceTone, unknownLabel, useLeaseMarketChanges, useLeaseMarketHistory,
  useLeaseMarketPositioning, useLeaseMarketRadar, useLeaseMarketSignals, useLeaseMarketSummary, useRadarDecision,
} from './hooks';

const MUTED = { color: 'var(--text-tertiary)' } as const;
const TABS = ['Portfolio', 'Market Rents', 'Acquisition Radar', 'Changes', 'Data Quality'] as const;
type Tab = (typeof TABS)[number];

function Toggle({ active, onClick, children, role }: { active: boolean; onClick: () => void; children: ReactNode; role?: 'tab' }) {
  return (
    <button
      type="button"
      role={role}
      aria-selected={role === 'tab' ? active : undefined}
      aria-pressed={role === 'tab' ? undefined : active}
      onClick={onClick}
      className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs"
      style={{ border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`, color: 'var(--text-secondary)' }}
    >
      {children}
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-2xs" style={MUTED}>{children}</p>;
}

function unavailable(error: unknown): string {
  return isWarehouseUnavailable(error) ? 'Not available on this mirror.' : `Failed to load: ${error instanceof Error ? error.message : 'unknown error'}`;
}

// ── Portfolio ─────────────────────────────────────────────────────────────────
const positionCols: Column<PositioningRow>[] = [
  { key: 'property', header: 'Property', render: (r) => <span style={{ fontWeight: 600 }}>{r.propertyKey}</span>, sortValue: (r) => r.propertyKey },
  { key: 'unit', header: 'Unit', render: (r) => r.unit ?? '—' },
  {
    key: 'source',
    header: 'Source',
    // Go-live change (2026-09-17): tells Gabriel "this is what CoStar says we're marketing" (a listing
    // row) apart from "this is what our rent roll says is empty" (a rent-roll row) — see
    // PositioningRowSource's contract doc comment.
    render: (r) => <Badge tone={sourceTone(r.source)}>{sourceLabel(r.source)}</Badge>,
    sortValue: (r) => r.source,
  },
  { key: 'sf', header: 'SF', align: 'right', render: (r) => r.sf.toLocaleString('en-US'), sortValue: (r) => r.sf },
  { key: 'asking', header: 'ORA asking', align: 'right', render: (r) => fmtPsf(r.oraAskingNnnEq), sortValue: (r) => r.oraAskingNnnEq },
  { key: 'median', header: 'Comp median', align: 'right', render: (r) => fmtPsf(r.stats?.median), sortValue: (r) => r.stats?.median ?? null },
  { key: 'range', header: 'Range (P25–P75)', render: (r) => (r.stats ? `${fmtPsf(r.stats.p25)}–${fmtPsf(r.stats.p75)}` : '—') },
  // ComparableStats.low/high (whole-branch review item 5): the full comp spread, not just P25–P75.
  { key: 'spread', header: 'Full range', render: (r) => (r.stats ? `${fmtPsf(r.stats.low)}–${fmtPsf(r.stats.high)}` : '—') },
  { key: 'pctl', header: 'Pctl', align: 'right', render: (r) => (r.percentile === null ? '—' : `${Math.round(r.percentile * 100)}th`), sortValue: (r) => r.percentile },
  { key: 'gap', header: 'Gap', align: 'right', render: (r) => fmtPct(r.gapPct), sortValue: (r) => r.gapPct },
  { key: 'band', header: 'Position', render: (r) => <Badge tone={bandTone(r.band)}>{bandLabel(r.band)}</Badge>, sortValue: (r) => r.band },
  {
    key: 'conf',
    header: 'Confidence',
    render: (r) =>
      r.stats ? (
        <div className="flex flex-col gap-0.5">
          <Badge tone={confidenceTone(r.stats.confidence)}>{`${r.stats.confidence} · ${r.stats.basis} · n ${r.stats.n}`}</Badge>
          {/* R3 (deferred UI-fix round): explains a MEDIUM/LOW confidence caused by missing subject/comp data. */}
          {r.stats.unknown.length > 0 && <span className="text-2xs" style={MUTED}>{unknownLabel(r.stats.unknown)}</span>}
        </div>
      ) : (
        '—'
      ),
  },
  { key: 'dom', header: 'DOM', align: 'right', render: (r) => (r.effectiveDom === null ? '—' : `${r.effectiveDom}d`), sortValue: (r) => r.effectiveDom },
  { key: 'flags', header: 'Flags', render: (r) => (r.flags.includes('not_listed') ? <Badge tone="red">Not listed</Badge> : '') },
  { key: 'rec', header: 'Recommendation', render: (r) => <span className="text-2xs">{r.recommendation}</span> },
];

const compCols: Column<CompRow>[] = [
  { key: 'address', header: 'Comparable', render: (c) => c.address ?? `Space ${c.listingId}` },
  { key: 'sf', header: 'SF', align: 'right', render: (c) => fmtSf(c.availableSf), sortValue: (c) => c.availableSf },
  { key: 'asking', header: 'Asking', align: 'right', render: (c) => fmtPsf(c.askingNnnEq), sortValue: (c) => c.askingNnnEq },
  { key: 'score', header: 'Similarity', align: 'right', render: (c) => String(c.score), sortValue: (c) => c.score },
  { key: 'dist', header: 'Miles', align: 'right', render: (c) => (c.distanceMi === null ? '—' : c.distanceMi.toFixed(1)), sortValue: (c) => c.distanceMi },
];

const leasedCols: Column<ListedButLeased>[] = [
  { key: 'property', header: 'Property', render: (l) => l.propertyKey },
  { key: 'suite', header: 'Suite', render: (l) => l.suite || '—' },
  { key: 'asking', header: 'Asking', align: 'right', render: (l) => fmtPsf(l.askingNnnEq) },
  { key: 'dom', header: 'DOM', align: 'right', render: (l) => `${l.effectiveDom}d` },
];

// Deferred R2: a listing whose owner screens as ORA-self but whose address is not mapped in
// config.oraProperties — the Portfolio tab's existing listing-hygiene surface.
const hygieneCols: Column<ListingHygieneFlag>[] = [
  { key: 'address', header: 'Address', render: (h) => h.address ?? `Space ${h.listingId}` },
  { key: 'market', header: 'Market', render: (h) => h.marketId },
  { key: 'reason', header: 'Issue', render: (h) => <span className="text-2xs">{h.reason}</span> },
];

function PortfolioTab({ onHistory }: { onHistory: (id: number) => void }) {
  const q = useLeaseMarketPositioning();
  const [selected, setSelected] = useState<string | null>(null);
  if (q.isLoading) return <Note>Loading…</Note>;
  if (!q.data) return <Note>{unavailable(q.error)}</Note>;
  const rowId = (r: PositioningRow) => `${r.propertyKey}|${r.unit ?? ''}`;
  const active = q.data.rows.find((r) => rowId(r) === selected) ?? null;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        {/* Go-live change (2026-09-17): Rent Position now sources ORA available space primarily from
            ORA-owned CoStar listings (the real rent roll carries no vacant rows) — a rent-roll vacancy
            that matches a listing still wins and keeps its row; see the Source column. */}
        <CardHeader title="Oxford Rent Position — ORA marketed & vacant space vs. comparable asking rents" />
        <div className="p-4">
          {q.data.rows.length === 0 ? (
            <Note>No ORA space currently listed in CoStar or vacant in the rent roll.</Note>
          ) : (
            <DataTable columns={positionCols} rows={q.data.rows} getRowId={rowId} onRowClick={(r) => setSelected((prev) => (prev === rowId(r) ? null : rowId(r)))} initialSort={{ key: 'gap', dir: 'desc' }} minWidth={1200} />
          )}
          {q.data.unconfiguredPropertyKeys.length > 0 && <Note>Not yet mapped to a comparable set: {q.data.unconfiguredPropertyKeys.join(', ')}</Note>}
        </div>
      </Card>
      {active && (
        <Card>
          <CardHeader title={`Comparables — ${active.propertyKey} ${active.unit ?? ''}`} trailing={<span className="text-2xs" style={MUTED}>click a comparable for its history</span>} />
          <div className="p-4">
            {active.comps.length === 0 ? <Note>Using the market cell (no similarity comparable set).</Note> : <DataTable columns={compCols} rows={active.comps} getRowId={(c) => String(c.listingId)} onRowClick={(c) => onHistory(c.listingId)} />}
          </div>
        </Card>
      )}
      {q.data.listedButLeased.length > 0 && (
        <Card>
          {/* Go-live change (2026-09-17): every active, mapped ORA listing now gets its own Rent
              Position row above (source "CoStar listing"), so this should be empty in ordinary
              operation — a non-empty list here is a genuine data inconsistency worth investigating,
              not the routine "listed but not vacant" case it used to report. */}
          <CardHeader title="Listed in CoStar with no Rent Position row (data inconsistency)" />
          <div className="p-4">
            <DataTable columns={leasedCols} rows={q.data.listedButLeased} getRowId={(l) => String(l.listingId)} onRowClick={(l) => onHistory(l.listingId)} />
          </div>
        </Card>
      )}
      {q.data.hygieneFlags.length > 0 && (
        <Card>
          <CardHeader title="Listing hygiene" />
          <div className="p-4">
            <DataTable columns={hygieneCols} rows={q.data.hygieneFlags} getRowId={(h) => String(h.listingId)} onRowClick={(h) => onHistory(h.listingId)} />
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Market Rents ──────────────────────────────────────────────────────────────
const benchCols: Column<CellBenchmark>[] = [
  { key: 'cell', header: 'Cell', render: (b) => <span className="text-2xs">{b.cellKey}</span>, sortValue: (b) => b.cellKey },
  { key: 'n', header: 'Quoted / total', align: 'right', render: (b) => `${b.n} / ${b.totalN}`, sortValue: (b) => b.n },
  // CellBenchmark.quotedShare (whole-branch review item 5): the quoted share as a percentage, not just the raw n/totalN counts.
  { key: 'quotedShare', header: 'Quoted share', align: 'right', render: (b) => fmtPct(b.quotedShare, false), sortValue: (b) => b.quotedShare },
  { key: 'p25', header: 'P25', align: 'right', render: (b) => fmtPsf(b.p25) },
  { key: 'median', header: 'Median', align: 'right', render: (b) => fmtPsf(b.median), sortValue: (b) => b.median },
  { key: 'p75', header: 'P75', align: 'right', render: (b) => fmtPsf(b.p75) },
  { key: 'flags', header: 'Notes', render: (b) => [b.lowCoverage ? 'low coverage' : '', b.rolledUp !== 'none' ? `rolled up: ${b.rolledUp}` : ''].filter(Boolean).join(' · ') },
];

// ── Radar ─────────────────────────────────────────────────────────────────────
function RadarTab({ onHistory }: { onHistory: (id: number) => void }) {
  const q = useLeaseMarketRadar();
  const decide = useRadarDecision();
  // Decisions are a server WRITE; on the baked mirror they have no edge home → hide the column
  // entirely (not just disable it) until the live Brain Server is confirmed reachable (Phase 1b
  // pattern — see DataQualityView/MappingsView/LeaseRunView for the same live-gated column).
  const live = useWarehouseLive();
  if (q.isLoading) return <Note>Loading…</Note>;
  if (!q.data) return <Note>{unavailable(q.error)}</Note>;
  const cols: Column<RadarCandidate>[] = [
    { key: 'score', header: 'Score', align: 'right', render: (c) => <Badge tone={c.score >= 70 ? 'red' : 'amber'}>{String(c.score)}</Badge>, sortValue: (c) => c.score },
    { key: 'address', header: 'Property', render: (c) => <span style={{ fontWeight: 600 }}>{c.address ?? `Property ${c.propertyId}`}</span> },
    { key: 'market', header: 'Market', render: (c) => c.marketId },
    { key: 'sf', header: 'Bldg SF', align: 'right', render: (c) => fmtSf(c.buildingSf), sortValue: (c) => c.buildingSf },
    { key: 'why', header: 'Why it surfaced', render: (c) => <span className="text-2xs">{radarWhy(c)}</span> },
    { key: 'gap', header: 'Indicative rent gap', align: 'right', render: (c) => fmtUsd(c.indicativeRentGapUsd), sortValue: (c) => c.indicativeRentGapUsd },
    { key: 'conf', header: 'Confidence', render: (c) => <Badge tone={confidenceTone(c.confidence)}>{c.confidence}</Badge> },
    { key: 'owner', header: 'Owner', render: (c) => `${c.ownerName ?? '—'} (${c.ownerType}, ${c.ownerListingCount} listed)` },
    { key: 'broker', header: 'Broker', render: (c) => c.brokerName ?? '—' },
    { key: 'decision', header: 'Decision', render: (c) => (c.latestDecision ? `${DECISION_LABELS[c.latestDecision.decision]} · ${c.latestDecision.decidedAt.slice(0, 10)}` : '—') },
    ...(live
      ? ([{
          key: 'actions',
          header: '',
          render: (c) => (
            <div className="flex gap-1">
              {(['investigate', 'monitor', 'pass'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className="rounded-[var(--radius-sm)] px-2 py-0.5 text-2xs"
                  style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                  disabled={decide.isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    decide.mutate({ propertyId: c.propertyId, decision: d, note: null });
                  }}
                >
                  {DECISION_LABELS[d]}
                </button>
              ))}
            </div>
          ),
        }] as Column<RadarCandidate>[])
      : []),
  ];
  const monitorCols: Column<SignalRow>[] = [
    { key: 'space', header: 'Space', render: (s) => s.address ?? `Space ${s.listingId ?? ''}` },
    { key: 'market', header: 'Market', render: (s) => s.marketId },
    { key: 'evidence', header: 'Evidence', render: (s) => evidenceSummary(s) },
  ];
  return (
    <div className="flex flex-col gap-4">
      {q.data.candidatesWithheld.map((w) => (
        <p key={w.marketId} className="text-2xs" style={{ color: 'var(--color-warn)' }}>{w.marketId}: {w.reason}</p>
      ))}
      <Card>
        <CardHeader title="Acquisition Radar — ranked candidates" trailing={<span className="text-2xs" style={MUTED}>Indicative rent gap = gross, vacant space only — not NOI.</span>} />
        <div className="p-4">
          {q.data.candidates.length === 0 ? <Note>No radar candidates.</Note> : <DataTable columns={cols} rows={q.data.candidates} getRowId={(c) => String(c.propertyId)} minWidth={1300} />}
          {decide.isError && <p role="alert" className="mt-2 text-2xs" style={{ color: 'var(--color-warn)' }}>{decide.error instanceof Error ? decide.error.message : 'Decision failed'}</p>}
        </div>
      </Card>
      <Card>
        <CardHeader title="Withdrawn after a stale run (outcome unknown)" />
        <div className="p-4">
          {q.data.monitor.length === 0 ? <Note>None in the lookback window.</Note> : <DataTable columns={monitorCols} rows={q.data.monitor} getRowId={(s) => String(s.id)} onRowClick={(s) => s.listingId !== null && onHistory(s.listingId)} />}
        </div>
      </Card>
    </div>
  );
}

// ── Changes ───────────────────────────────────────────────────────────────────
function ChangesTab({ onHistory }: { onHistory: (id: number) => void }) {
  const changes = useLeaseMarketChanges();
  const signals = useLeaseMarketSignals();
  const eventCols: Column<ListingEventRow>[] = [
    { key: 'kind', header: 'Event', render: (e) => EVENT_LABELS[e.kind], sortValue: (e) => e.kind },
    { key: 'market', header: 'Market', render: (e) => e.marketId },
    { key: 'space', header: 'Space', render: (e) => e.address ?? `Space ${e.listingId}` },
    { key: 'detail', header: 'Detail', render: (e) => eventSummary(e) },
    { key: 'date', header: 'Export', render: (e) => e.eventDate, sortValue: (e) => e.eventDate },
  ];
  const signalCols: Column<SignalRow>[] = [
    { key: 'severity', header: 'Severity', render: (s) => <Badge tone={severityTone(s.severity)}>{s.severity}</Badge> },
    { key: 'kind', header: 'Signal', render: (s) => KIND_LABELS[s.kind], sortValue: (s) => s.kind },
    { key: 'space', header: 'Space', render: (s) => s.address ?? `Space ${s.listingId ?? ''}` },
    { key: 'evidence', header: 'Evidence', render: (s) => evidenceSummary(s) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Changes in the latest complete exports" />
        <div className="p-4">
          {changes.isLoading ? <Note>Loading…</Note> : !changes.data ? <Note>{unavailable(changes.error)}</Note> : changes.data.events.length === 0 ? <Note>No changes.</Note> : (
            <DataTable columns={eventCols} rows={changes.data.events} getRowId={(e) => String(e.id)} onRowClick={(e) => onHistory(e.listingId)} />
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Signals" />
        <div className="p-4">
          {/* SignalsResponse.candidatesWithheld (whole-branch review item 5): the same withheld banner the Radar tab shows. */}
          {(signals.data?.candidatesWithheld ?? []).map((w) => (
            <p key={w.marketId} className="mb-2 text-2xs" style={{ color: 'var(--color-warn)' }}>{w.marketId}: {w.reason}</p>
          ))}
          {signals.isLoading ? <Note>Loading…</Note> : !signals.data ? <Note>{unavailable(signals.error)}</Note> : signals.data.signals.length === 0 ? <Note>No signals.</Note> : (
            <DataTable columns={signalCols} rows={signals.data.signals} getRowId={(s) => String(s.id)} onRowClick={(s) => s.listingId !== null && onHistory(s.listingId)} />
          )}
        </div>
      </Card>
    </div>
  );
}

// ── Data quality ──────────────────────────────────────────────────────────────
const freshnessCols: Column<MarketFreshness>[] = [
  { key: 'market', header: 'Market', render: (f) => f.label },
  { key: 'enabled', header: 'Enabled', render: (f) => (f.enabled ? 'yes' : 'no') },
  // MarketFreshness.lastLandingDate/lastCompleteness (whole-branch review item 5): the most recent
  // landing may be a PARTIAL export more recent than the last COMPLETE one below — surface both so a
  // market whose newest landing is partial shows that date and state, not just the complete-only view.
  { key: 'lastLanding', header: 'Last landing', render: (f) => f.lastLandingDate ?? 'none' },
  { key: 'completeness', header: 'Landing state', render: (f) => f.lastCompleteness ?? '—' },
  { key: 'last', header: 'Last complete export', render: (f) => f.lastCompleteDate ?? 'none' },
  { key: 'state', header: 'Status', render: (f) => <Badge tone={f.stale ? 'amber' : 'green'}>{f.stale ? 'stale' : 'fresh'}</Badge> },
  { key: 'reason', header: 'Partial reason', render: (f) => f.partialReason ?? '' },
];
const qualityCols: Column<MarketDataQuality>[] = [
  { key: 'market', header: 'Market', render: (q) => q.marketId },
  { key: 'active', header: 'Active spaces', align: 'right', render: (q) => String(q.activeSpaces) },
  { key: 'rows', header: 'Last export rows / skipped', align: 'right', render: (q) => `${q.lastExportRows} / ${q.lastExportSkipped}` },
  { key: 'quoted', header: 'Quoted NNN', align: 'right', render: (q) => fmtPct(q.quotedShare, false) },
  { key: 'coords', header: 'Coordinates', align: 'right', render: (q) => fmtPct(q.coordsShare, false) },
  { key: 'low', header: 'Low confidence', align: 'right', render: (q) => fmtPct(q.lowConfidenceShare, false) },
  { key: 'rejected', header: 'Rejected rents', align: 'right', render: (q) => String(q.rejectedRents) },
];

// ── History drawer ────────────────────────────────────────────────────────────
function HistoryDrawer({ listingId, onClose }: { listingId: number; onClose: () => void }) {
  const q = useLeaseMarketHistory(listingId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // jsdom (unit tests) doesn't implement scrollIntoView — guard so the drawer still opens there.
    if (typeof ref.current?.scrollIntoView === 'function') ref.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [listingId]);
  return (
    <div ref={ref}>
      <Card>
        <CardHeader
          title={`Space history — ${q.data?.address ?? `space ${listingId}`}`}
          trailing={<button type="button" className="text-2xs" style={MUTED} onClick={onClose}>Close</button>}
        />
        <div className="p-4">
          {q.isLoading ? <Note>Loading…</Note> : !q.data ? <Note>{unavailable(q.error)}</Note> : (
            <ul className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
              {q.data.observations.map((o, i) => (
                <li key={`${i}-${o.observedAt}`}>{o.observedAt} · {fmtSf(o.availableSf)} · {fmtPsf(o.askingNnnEq)} {o.rentBasis} ({o.confidence}){o.costarDom !== null ? ` · CoStar DOM ${o.costarDom}d` : ''}</li>
              ))}
              {q.data.events.map((e) => (
                <li key={`e${e.id}`}>{e.eventDate} · {EVENT_LABELS[e.kind]} · {eventSummary(e)}</li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

// ── Module ────────────────────────────────────────────────────────────────────
export function LeaseMarketModule() {
  const summary = useLeaseMarketSummary();
  const [tab, setTab] = useState<Tab>('Portfolio');
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);

  const data = summary.data;
  const marketId =
    selectedMarket ?? data?.freshness.find((f) => f.enabled && f.lastCompleteDate !== null)?.marketId ?? data?.freshness.find((f) => f.enabled)?.marketId ?? null;
  const points = useMemo(() => (data && marketId ? curvePointsFor(data.curve, marketId) : []), [data, marketId]);

  if (summary.isLoading) return <div className="p-6"><Note>Loading…</Note></div>;
  if (!data) return <Card><div className="p-6"><Note>{unavailable(summary.error)}</Note></div></Card>;

  const k = data.kpis;
  const kpis: Array<[string, string]> = [
    ['Markets fresh', `${k.marketsFresh} / ${k.marketsEnabled}`],
    ['Active spaces', String(k.activeSpaces)],
    ['New in latest exports', String(k.newInLatest)],
    ['Price cuts', String(k.priceCutsInLatest)],
    ['Stale listings', String(k.stale)],
    ['Radar candidates', String(k.radarCandidates)],
  ];
  const dom = data.domByMarket.find((d) => d.marketId === marketId);
  const marketLabel = data.freshness.find((f) => f.marketId === marketId)?.label ?? '—';
  const marketBenchmarks = data.benchmarks.filter((b) => b.marketId === marketId);

  const changeTab = (t: Tab) => {
    setTab(t);
    setHistoryId(null); // the drawer is scoped to whichever tab opened it — close it on tab switch
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        {kpis.map(([label, value]) => (
          <Card key={label}>
            <div className="p-3">
              <div className="text-2xs" style={MUTED}>{label}</div>
              <div className="num text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div>
            </div>
          </Card>
        ))}
      </div>
      <p className="text-2xs" style={MUTED}>
        As of {data.asOf}{data.lastComputedAt !== null ? ` · last computed ${data.lastComputedAt}` : ''} · asking rents, NNN-equivalent $/SF/yr · CoStar-derived, internal use only
      </p>
      {/* I3 (whole-branch review): ingest without compute leaves Radar empty and KPIs zeroed with no
          explanation — say so plainly and name the command. M-1: lastComputedAt is now the max of two
          tables (see compute.ts), but a run that wrote to neither (zero active spaces, zero configured
          comps) is still indistinguishable from "never run" — the wording below covers both. */}
      {data.lastComputedAt === null && (
        <p className="text-2xs" style={{ color: 'var(--color-warn)' }}>Compute has not been run yet, or the last run produced no signals — Market Rents and Changes may show ingested data with no Radar or KPI signals. Run `npm run lease-market:compute`.</p>
      )}
      {/* rowLevel (whole-branch review item 5): explains why rows on a redacted mirror read "Property 123". */}
      {!data.rowLevel && (
        <p className="text-2xs" style={MUTED}>Addresses, owners and brokers are hidden on this mirror — this is why rows read &quot;Property 123&quot;.</p>
      )}

      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <Toggle key={t} role="tab" active={tab === t} onClick={() => changeTab(t)}>{t}</Toggle>
        ))}
      </div>

      {tab === 'Portfolio' && <PortfolioTab onHistory={setHistoryId} />}

      {tab === 'Market Rents' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1">
            {data.freshness.filter((f) => f.enabled).map((f) => (
              <Toggle key={f.marketId} active={f.marketId === marketId} onClick={() => setSelectedMarket(f.marketId)}>{f.label}</Toggle>
            ))}
          </div>
          <Card>
            <CardHeader title={`Asking rent vs. available SF — ${marketLabel}`} trailing={<span className="text-2xs" style={MUTED}>● quoted NNN · ○ converted · gold = ORA · band P25–P75 per size band (n ≥ 5)</span>} />
            <div className="p-4"><RentCurve points={points} /></div>
          </Card>
          <Card>
            <CardHeader title={`Days on market — ${marketLabel}`} />
            <div className="p-4">{dom ? <BarChart data={dom.bins.map((b) => ({ label: b.label, value: b.count }))} /> : <Note>No listings yet.</Note>}</div>
          </Card>
          <Card>
            <CardHeader title="Benchmark cells" />
            <div className="p-4">
              {marketBenchmarks.length === 0 ? <Note>No benchmark cells yet.</Note> : <DataTable columns={benchCols} rows={marketBenchmarks} getRowId={(b) => b.cellKey} />}
            </div>
          </Card>
        </div>
      )}

      {tab === 'Acquisition Radar' && <RadarTab onHistory={setHistoryId} />}
      {tab === 'Changes' && <ChangesTab onHistory={setHistoryId} />}

      {tab === 'Data Quality' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Export freshness" />
            <div className="p-4"><DataTable columns={freshnessCols} rows={data.freshness} getRowId={(f) => f.marketId} /></div>
          </Card>
          <Card>
            <CardHeader title="Data quality" />
            <div className="p-4"><DataTable columns={qualityCols} rows={data.dataQuality} getRowId={(q) => q.marketId} /></div>
          </Card>
        </div>
      )}

      {historyId !== null && <HistoryDrawer listingId={historyId} onClose={() => setHistoryId(null)} />}
    </div>
  );
}
