// src/modules/intel/OwnershipView.tsx
//
// The Ownership Intelligence Center — the DEFAULT home of Property Financial Intelligence
// and the centerpiece of the module. It is an operating system for ownership decisions,
// NOT a dashboard: it answers the nine ownership questions and LEADS WITH ACTION. The
// prioritized action list and the attention matrix are the heart of the page; the capital
// allocation, risk, growth, and PM sections support a decision rather than decorate it.
//
// Everything is synthesized by the pure transforms in synthesis.ts (buildActionList,
// rankByAttention, groupByCapitalAction, topRisks, improving/deterioratingProperties) +
// the portfolio roll-ups in ownership-intel.ts — this view only renders them and routes
// clicks. Selection is LIFTED into IntelModule: clicking any property here calls
// `onOpenProperty(id)`, which sets the shared selected id and switches to the Property tab.
//
// States: loading → Skeletons; warehouse unavailable → the module's offline Card is shown
// upstream by IntelModule, and any analytics 503 here surfaces the same offline Card;
// empty (no committed financials / no scores) → an explicit "see the Imports tab" Card.
// Scores are labeled "Scored on latest full year" so the 2026-YTD caveat is clear
// (pre-mortem #5). No raw hex — theme tokens only.
import { useMemo } from 'react';
import { Database } from 'lucide-react';
import { fmtUsd, fmtUsdCompact, fmtPct } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { DataTable, type Column } from '@/primitives/DataTable';
import { isWarehouseUnavailable } from './hooks';
import {
  useScores,
  useMetrics,
  useGrowth,
  useAnomalies,
  usePmScorecards,
  type PropertyScore,
  type PeriodMetrics,
  type SinceAcquisition,
  type AnomalyFlag,
  type PmScorecard,
  type AttentionBand,
  type AnomalySeverity,
  type CapitalAction,
} from './analytics-hooks';
import {
  rankByAttention,
  groupByCapitalAction,
  topRisks,
  improvingProperties,
  deterioratingProperties,
  rankBySinceAcqGrowth,
  buildActionList,
  type Action,
  type ActionPriority,
} from './synthesis';
import { portfolioTotals, portfolioTotalsForPeriod, attentionCounts, portfolioVerdict } from './ownership-intel';
import { periodLabel } from './property-intel';
import { BasisSublabel } from '@/primitives/BasisChip';

// ---------------------------------------------------------------------------
// Tone maps (engine band → Badge tone) — identical mapping to PropertyIntelView so the
// two views read as one system.
// ---------------------------------------------------------------------------

const ATTENTION_TONE: Record<AttentionBand, BadgeTone> = {
  green: 'green',
  yellow: 'gold',
  orange: 'amber',
  red: 'red',
};

// Attention band → a distinct heat hue for the briefing heat-strip tiles (4-step ramp:
// green → gold → amber → red). Theme tokens only.
const ATTENTION_HEAT: Record<AttentionBand, string> = {
  green: 'var(--color-pos)',
  yellow: 'var(--accent)',
  orange: 'var(--color-warn)',
  red: 'var(--color-neg)',
};

const SEVERITY_TONE: Record<AnomalySeverity, BadgeTone> = {
  low: 'neutral',
  moderate: 'gold',
  high: 'amber',
  critical: 'red',
};

const CAPITAL_TONE: Record<CapitalAction, BadgeTone> = {
  invest: 'green',
  hold: 'blue',
  monitor: 'gold',
  'disposition-candidate': 'red',
};

const CAPITAL_LABEL: Record<CapitalAction, string> = {
  invest: 'Invest',
  hold: 'Hold',
  monitor: 'Monitor',
  'disposition-candidate': 'Disposition candidate',
};

const PRIORITY_TONE: Record<ActionPriority, BadgeTone> = {
  high: 'red',
  medium: 'amber',
  low: 'neutral',
};

// The four capital buckets, worst→best, so the disposition decision leads.
const CAPITAL_ORDER: CapitalAction[] = ['disposition-candidate', 'monitor', 'hold', 'invest'];

interface Props {
  /** Switch to the Property tab focused on this property (lifted selection in IntelModule). */
  onOpenProperty: (propertyId: string) => void;
  /** Module-level selected period (PFI Phase B.3 item 3) — governs the portfolio band LEVELS.
   *  Null falls back to the latest-full-year roll-up. */
  period: string | null;
  /** Display label for the selected period ('FY2025' / '2026 YTD'); null → "latest full year". */
  periodLabel: string | null;
  /** True when the selected period is YTD/partial (IntelModule's isYtdPeriod, the same flag that
   *  raises its YTD banner). The band's NOI level then says "partial". */
  periodIsYtd?: boolean;
}

export function OwnershipView({ onOpenProperty, period, periodLabel: bandLabel, periodIsYtd = false }: Props) {
  const scores = useScores();
  const metrics = useMetrics();
  const growth = useGrowth();
  const anomalies = useAnomalies();
  const pm = usePmScorecards();

  // Any analytics route 503 → surface the same offline Card the module uses upstream.
  const unavailable =
    isWarehouseUnavailable(scores.error) ||
    isWarehouseUnavailable(metrics.error) ||
    isWarehouseUnavailable(growth.error) ||
    isWarehouseUnavailable(anomalies.error) ||
    isWarehouseUnavailable(pm.error);

  const loading =
    scores.isLoading || metrics.isLoading || growth.isLoading || anomalies.isLoading || pm.isLoading;

  // ----- Derived intelligence (memoized; pure transforms from synthesis.ts) -----
  // The `?? []` extractions are themselves memoized so their references are stable across
  // renders (otherwise every downstream useMemo would recompute each render).
  const scoreData = useMemo(() => scores.data ?? [], [scores.data]);
  const metricData = useMemo(() => metrics.data ?? [], [metrics.data]);
  const anomalyData = useMemo(() => anomalies.data ?? [], [anomalies.data]);
  const pmData = useMemo(() => pm.data ?? [], [pm.data]);
  const sinceAcq = useMemo(() => growth.data?.sinceAcquisition ?? [], [growth.data]);

  const ranked = useMemo(() => rankByAttention(scoreData), [scoreData]);
  const actions = useMemo(
    () => buildActionList({ scores: scoreData, anomalies: anomalyData, pm: pmData }),
    [scoreData, anomalyData, pmData],
  );
  const capital = useMemo(() => groupByCapitalAction(scoreData), [scoreData]);
  const risks = useMemo(() => topRisks(anomalyData, 8), [anomalyData]);
  const improving = useMemo(() => improvingProperties(sinceAcq), [sinceAcq]);
  const deteriorating = useMemo(() => deterioratingProperties(sinceAcq), [sinceAcq]);
  const leaderboard = useMemo(() => rankBySinceAcqGrowth(sinceAcq), [sinceAcq]);
  const totals = useMemo(() => portfolioTotals(metricData), [metricData]);
  const counts = useMemo(() => attentionCounts(scoreData), [scoreData]);
  const verdict = useMemo(() => portfolioVerdict(scoreData, totals), [scoreData, totals]);
  // The KPI band reflects the module-selected period's LEVELS (falls back to latest-FY totals);
  // the verdict above stays on the latest full year (the scoring basis).
  const bandTotals = useMemo(
    () => (period ? portfolioTotalsForPeriod(metricData, period) : totals),
    [period, metricData, totals],
  );

  // Latest full-year metric per property — feeds the attention matrix NOI/SF + period.
  const latestFyByProperty = useMemo(() => latestFullYear(metricData), [metricData]);
  // Property names from scores, for chips / risk lines that only carry an id.
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scoreData) m.set(s.propertyId, s.propertyName ?? s.propertyId);
    return m;
  }, [scoreData]);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton style={{ height: 92 }} />
        <Skeleton style={{ height: 200 }} />
        <Skeleton style={{ height: 280 }} />
      </div>
    );
  }

  if (unavailable) {
    return (
      <Card>
        <CardHeader title="Ownership Intelligence" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <Database size={28} style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Ownership intelligence requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            The financial warehouse runs locally alongside the brain server. This deployed mirror is read-only.
          </div>
        </div>
      </Card>
    );
  }

  if (ranked.length === 0) {
    return (
      <Card>
        <CardHeader title="Ownership Intelligence" />
        <div className="px-4 py-12 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          No financials ingested yet — see the Imports tab to approve a committed import.
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <BriefingHero
        verdict={verdict}
        actions={actions}
        ranked={ranked}
        latestFyByProperty={latestFyByProperty}
        capital={capital}
        onOpenProperty={onOpenProperty}
      />

      <PortfolioBand totals={bandTotals} counts={counts} periodLabel={bandLabel} partial={periodIsYtd} />

      <ActionList actions={actions} onOpenProperty={onOpenProperty} />

      <AttentionMatrix
        ranked={ranked}
        latestFyByProperty={latestFyByProperty}
        onOpenProperty={onOpenProperty}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TrajectoryCard
          title="Improving"
          rows={improving}
          nameById={nameById}
          positive
          onOpenProperty={onOpenProperty}
        />
        <TrajectoryCard
          title="Deteriorating"
          rows={deteriorating}
          nameById={nameById}
          positive={false}
          onOpenProperty={onOpenProperty}
        />
      </div>

      <SinceAcqLeaderboardCard leaderboard={leaderboard} nameById={nameById} onOpenProperty={onOpenProperty} />

      <CapitalAllocation capital={capital} onOpenProperty={onOpenProperty} />

      <RisksCard risks={risks} nameById={nameById} onOpenProperty={onOpenProperty} />

      <PmSnapshot scorecards={pmData} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 0) Morning-briefing hero — the above-the-fold answer (PFI Phase B.3 item 1): a one-sentence
//    portfolio verdict, the top-3 actions, a 12-tile attention heat-strip (click → Property tab),
//    and a compact capital-allocation summary. The detailed sections below restate these in full.
//    NOI/SF here is the latest-full-year level (the scoring basis), independent of the module
//    time control, so the briefing always reads as the FY posture.
// ---------------------------------------------------------------------------

function BriefingHero({
  verdict,
  actions,
  ranked,
  latestFyByProperty,
  capital,
  onOpenProperty,
}: {
  verdict: string;
  actions: Action[];
  ranked: PropertyScore[];
  latestFyByProperty: Map<string, PeriodMetrics>;
  capital: ReturnType<typeof groupByCapitalAction>;
  onOpenProperty: (id: string) => void;
}) {
  const topActions = actions.slice(0, 3);
  return (
    <Card accent>
      <CardHeader title="Morning Briefing" trailing={<Badge tone="neutral">full-asset P&L ledger · latest FY</Badge>} />
      <div className="flex flex-col gap-4 px-4 py-3">
        <p className="text-base leading-relaxed" style={{ color: 'var(--text-primary)' }}>
          {verdict}
        </p>

        <div>
          <div className="num mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
            Top actions
          </div>
          {topActions.length === 0 ? (
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              No actions outstanding — steady on the latest full-year scoring.
            </div>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {topActions.map((a) => (
                <li key={a.text} className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0">
                    <Badge tone={PRIORITY_TONE[a.priority]}>{a.priority}</Badge>
                  </span>
                  <span className="min-w-0 flex-1 text-sm" style={{ color: 'var(--text-primary)' }}>
                    {a.text}
                    {a.propertyId !== undefined && (
                      <button
                        onClick={() => onOpenProperty(a.propertyId!)}
                        className="num ml-2 text-2xs font-semibold underline-offset-2 hover:underline"
                        style={{ color: 'var(--text-accent)', cursor: 'pointer' }}
                      >
                        open →
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div>
          <div className="num mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
            Attention heat-strip
          </div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {ranked.map((s) => {
              const heat = ATTENTION_HEAT[s.attentionBand];
              const noiPerSf = latestFyByProperty.get(s.propertyId)?.noiPerSf ?? null;
              return (
                <button
                  key={s.propertyId}
                  onClick={() => onOpenProperty(s.propertyId)}
                  title={`${s.propertyName ?? s.propertyId} · ${s.attentionBand} attention`}
                  className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors"
                  style={{
                    background: `color-mix(in oklab, ${heat} 16%, transparent)`,
                    border: `1px solid color-mix(in oklab, ${heat} 40%, transparent)`,
                    cursor: 'pointer',
                  }}
                >
                  <span className="truncate text-2xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {s.propertyName ?? s.propertyId}
                  </span>
                  <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>
                    {noiPerSf === null ? '—' : `${fmtUsd(noiPerSf, true)}/SF`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
            Capital
          </span>
          {CAPITAL_ORDER.map((action) => (
            <span key={action} className="flex items-center gap-1.5">
              <Badge tone={CAPITAL_TONE[action]}>{CAPITAL_LABEL[action]}</Badge>
              <span className="num text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {capital[action].length}
              </span>
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 1) Portfolio KPI band — the levels every other section reasons against.
// ---------------------------------------------------------------------------

function PortfolioBand({
  totals,
  counts,
  periodLabel,
  partial,
}: {
  totals: ReturnType<typeof portfolioTotals>;
  counts: ReturnType<typeof attentionCounts>;
  /** Period label for the NOI level sublabel ('FY2025' / '2026 YTD'); null → "latest full year". */
  periodLabel: string | null;
  /** A YTD period is a partial-year ledger total; say so beside the level so it is not read against a
   *  full-year figure. */
  partial: boolean;
}) {
  const levelLabel = periodLabel ?? 'latest full year';
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <KpiStat
        label="Properties"
        value={totals.propertyCount}
        format={(n) => (n === null ? '—' : String(Math.round(n)))}
        accentColor="var(--accent)"
      />
      <KpiStat
        label="Portfolio NOI"
        value={totals.portfolioNoi}
        format={(n) => (n === null ? '—' : fmtUsdCompact(n))}
        accentColor="var(--color-pos)"
        sublabel={<BasisSublabel basis="ledger">{`${levelLabel} · ${partial ? 'partial · ' : ''}entity 100%`}</BasisSublabel>}
      />
      <KpiStat
        label="Oxford-Share NOI"
        value={totals.oxfordNoi}
        format={(n) => (n === null ? '—' : fmtUsdCompact(n))}
        accentColor="var(--color-info)"
        sublabel={<BasisSublabel basis="ledger">ownership-weighted</BasisSublabel>}
      />
      <KpiStat
        label="Needing Attention"
        value={counts.needingAttention}
        format={(n) => (n === null ? '—' : String(Math.round(n)))}
        accentColor={counts.needingAttention > 0 ? 'var(--color-warn)' : 'var(--color-pos)'}
        sublabel="orange + red"
      />
      <KpiStat
        label="Disposition Candidates"
        value={counts.dispositionCandidates}
        format={(n) => (n === null ? '—' : String(Math.round(n)))}
        accentColor={counts.dispositionCandidates > 0 ? 'var(--color-neg)' : 'var(--color-pos)'}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2) Action list — the operating-system core. What ownership does next, prioritized.
// ---------------------------------------------------------------------------

function ActionList({
  actions,
  onOpenProperty,
}: {
  actions: Action[];
  onOpenProperty: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader
        title="What Ownership Should Do Next"
        trailing={
          <Badge tone={actions.length > 0 ? 'gold' : 'green'}>
            {actions.length} {actions.length === 1 ? 'action' : 'actions'}
          </Badge>
        }
      />
      {actions.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          No actions outstanding — the portfolio is steady on the latest full-year scoring.
        </div>
      ) : (
        <ol className="flex flex-col">
          {actions.map((a, i) => (
            <li
              key={a.text}
              className="flex items-start gap-3 px-4 py-2.5"
              style={{ borderTop: i === 0 ? undefined : '1px solid var(--border-subtle)' }}
            >
              <span className="mt-0.5 shrink-0">
                <Badge tone={PRIORITY_TONE[a.priority]}>{a.priority}</Badge>
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {a.text}
                </span>
                {a.propertyId !== undefined && (
                  <button
                    onClick={() => onOpenProperty(a.propertyId!)}
                    className="num ml-2 text-2xs font-semibold underline-offset-2 hover:underline"
                    style={{ color: 'var(--text-accent)', cursor: 'pointer' }}
                  >
                    open →
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3) Attention matrix — every scored property, worst attention first, one row to act on.
// ---------------------------------------------------------------------------

interface AttentionRow {
  score: PropertyScore;
  latestFy: PeriodMetrics | null;
}

function AttentionMatrix({
  ranked,
  latestFyByProperty,
  onOpenProperty,
}: {
  ranked: PropertyScore[];
  latestFyByProperty: Map<string, PeriodMetrics>;
  onOpenProperty: (id: string) => void;
}) {
  const rows: AttentionRow[] = useMemo(
    () => ranked.map((score) => ({ score, latestFy: latestFyByProperty.get(score.propertyId) ?? null })),
    [ranked, latestFyByProperty],
  );

  const columns = useMemo((): Column<AttentionRow>[] => [
    {
      key: 'property',
      header: 'Property',
      align: 'left',
      sortValue: (r) => r.score.propertyName ?? r.score.propertyId,
      render: (r) => (
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
          {r.score.propertyName ?? r.score.propertyId}
        </span>
      ),
    },
    {
      key: 'attention',
      header: 'Attention',
      align: 'left',
      // sort by the worst-first ranking index (red → green).
      sortValue: (r) => ['red', 'orange', 'yellow', 'green'].indexOf(r.score.attentionBand),
      render: (r) => (
        <Badge tone={ATTENTION_TONE[r.score.attentionBand]} dot>
          {r.score.attentionBand}
        </Badge>
      ),
    },
    {
      key: 'health',
      header: 'Health',
      align: 'right',
      sortValue: (r) => r.score.health,
      render: (r) => <span style={{ color: 'var(--text-primary)' }}>{r.score.health}</span>,
    },
    {
      key: 'noiPerSf',
      header: 'NOI / SF',
      align: 'right',
      sortValue: (r) => r.latestFy?.noiPerSf ?? null,
      render: (r) => {
        const v = r.latestFy?.noiPerSf ?? null;
        const fy = r.latestFy ? periodLabel(r.latestFy.period, r.latestFy.grainHint) : null;
        return (
          <span>
            <span style={{ color: v === null ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
              {v === null ? '—' : fmtUsd(v, true)}
            </span>
            {fy && (
              <span className="ml-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                {fy}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'capital',
      header: 'Capital Action',
      align: 'left',
      sortValue: (r) => CAPITAL_ORDER.indexOf(r.score.capitalAction),
      render: (r) => <Badge tone={CAPITAL_TONE[r.score.capitalAction]}>{CAPITAL_LABEL[r.score.capitalAction]}</Badge>,
    },
    {
      key: 'reason',
      header: 'Top Reason',
      align: 'left',
      render: (r) => (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {r.score.reasons[0] ?? '—'}
        </span>
      ),
    },
  ], []);

  return (
    <Card>
      <CardHeader
        title="Attention Matrix"
        trailing={<Badge tone="neutral">scored on latest full year · worst first</Badge>}
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.score.propertyId}
        onRowClick={(r) => onOpenProperty(r.score.propertyId)}
        minWidth={760}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 4) Improving / Deteriorating — trajectory since acquisition (NOI growth).
// ---------------------------------------------------------------------------

function TrajectoryCard({
  title,
  rows,
  nameById,
  positive,
  onOpenProperty,
}: {
  title: string;
  rows: SinceAcquisition[];
  nameById: Map<string, string>;
  positive: boolean;
  onOpenProperty: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        trailing={<Badge tone={positive ? 'green' : 'red'}>{rows.length}</Badge>}
      />
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          None with comparable two-year history.
        </div>
      ) : (
        <div className="flex flex-col">
          {rows.map((r, i) => {
            const id = r.propertyId ?? '';
            const v = r.noiGrowth;
            return (
              <button
                key={id || i}
                onClick={() => id && onOpenProperty(id)}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors"
                style={{
                  borderTop: i === 0 ? undefined : '1px solid var(--border-subtle)',
                  cursor: id ? 'pointer' : 'default',
                }}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm" style={{ color: 'var(--text-primary)' }}>
                    {nameById.get(id) ?? id}
                  </div>
                  <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                    NOI since FY{r.anchorPeriod ?? '—'}
                  </div>
                </div>
                <span
                  className="num shrink-0 text-base font-semibold"
                  style={{ color: positive ? 'var(--text-pos)' : 'var(--text-neg)' }}
                >
                  {fmtSignedPct(v)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** Signed percentage, '—' when null. Positive carries a leading '+'. */
function fmtSignedPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v >= 0 ? `+${fmtPct(v)}` : fmtPct(v);
}

// ---------------------------------------------------------------------------
// 4b) Since-acquisition leaderboard — every comparable property ranked by NOI/SF growth since
//     acquisition: "which assets are compounding since we bought them" (PFI Phase B.3 item 4).
//     Properties without comparable history are excluded with an explicit note.
// ---------------------------------------------------------------------------

function SinceAcqLeaderboardCard({
  leaderboard,
  nameById,
  onOpenProperty,
}: {
  leaderboard: ReturnType<typeof rankBySinceAcqGrowth>;
  nameById: Map<string, string>;
  onOpenProperty: (id: string) => void;
}) {
  const { ranked, insufficient } = leaderboard;
  return (
    <Card>
      <CardHeader title="Compounding Since Acquisition" trailing={<Badge tone="neutral">NOI / SF growth</Badge>} />
      {ranked.length === 0 ? (
        <div className="px-4 py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          None with comparable since-acquisition history.
        </div>
      ) : (
        <div className="flex flex-col">
          {ranked.map((r, i) => {
            const id = r.propertyId ?? '';
            const v = r.noiPerSfGrowth;
            return (
              <button
                key={id || i}
                onClick={() => id && onOpenProperty(id)}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors"
                style={{
                  borderTop: i === 0 ? undefined : '1px solid var(--border-subtle)',
                  cursor: id ? 'pointer' : 'default',
                }}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="num w-5 shrink-0 text-2xs font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm" style={{ color: 'var(--text-primary)' }}>
                      {nameById.get(id) ?? id}
                    </div>
                    <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                      NOI/SF since FY{r.anchorPeriod ?? '—'}
                    </div>
                  </div>
                </div>
                <span
                  className="num shrink-0 text-base font-semibold"
                  style={{ color: v !== null && v >= 0 ? 'var(--text-pos)' : 'var(--text-neg)' }}
                >
                  {fmtSignedPct(v)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {insufficient > 0 && (
        <div className="px-4 pb-3 pt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          {insufficient} {insufficient === 1 ? 'property' : 'properties'} excluded — insufficient history.
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 5) Capital allocation — the four buckets, counts + clickable property chips.
// ---------------------------------------------------------------------------

function CapitalAllocation({
  capital,
  onOpenProperty,
}: {
  capital: ReturnType<typeof groupByCapitalAction>;
  onOpenProperty: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader title="Capital Allocation" trailing={<Badge tone="neutral">by capital action</Badge>} />
      <div className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-4" style={{ background: 'var(--border-subtle)' }}>
        {CAPITAL_ORDER.map((action) => {
          const bucket = capital[action];
          return (
            <div key={action} className="flex flex-col gap-2 px-4 py-3" style={{ background: 'var(--surface-raised)' }}>
              <div className="flex items-center justify-between gap-2">
                <Badge tone={CAPITAL_TONE[action]}>{CAPITAL_LABEL[action]}</Badge>
                <span className="num text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {bucket.length}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {bucket.length === 0 ? (
                  <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                    none
                  </span>
                ) : (
                  bucket.map((s) => (
                    <button
                      key={s.propertyId}
                      onClick={() => onOpenProperty(s.propertyId)}
                      className="rounded-full px-2 py-0.5 text-2xs transition-colors"
                      style={{
                        background: 'color-mix(in oklab, var(--text-tertiary) 12%, transparent)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                      }}
                    >
                      {s.propertyName ?? s.propertyId}
                    </button>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 6) Largest risks — top anomalies across the portfolio, severity-ranked.
// ---------------------------------------------------------------------------

function RisksCard({
  risks,
  nameById,
  onOpenProperty,
}: {
  risks: AnomalyFlag[];
  nameById: Map<string, string>;
  onOpenProperty: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader title="Largest Risks" trailing={<Badge tone={risks.length > 0 ? 'amber' : 'green'}>{risks.length}</Badge>} />
      {risks.length === 0 ? (
        <div className="px-4 py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          No anomalies flagged across the portfolio.
        </div>
      ) : (
        <div className="flex flex-col">
          {risks.map((r, i) => (
            <button
              key={`${r.propertyId}-${r.kind}-${i}`}
              onClick={() => onOpenProperty(r.propertyId)}
              className="flex items-start justify-between gap-3 px-4 py-2.5 text-left transition-colors"
              style={{ borderTop: i === 0 ? undefined : '1px solid var(--border-subtle)', cursor: 'pointer' }}
            >
              <div className="flex items-start gap-2.5">
                <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
                <div>
                  <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    {nameById.get(r.propertyId) ?? r.propertyId}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {r.detail}
                  </div>
                  <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                    {r.kind} · {r.period}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 7) PM snapshot — best & worst manager by avg NOI growth; small samples flagged.
//    (The full Managers tab arrives in Phase 4 — for now this is a read-only snapshot.)
// ---------------------------------------------------------------------------

function PmSnapshot({ scorecards }: { scorecards: PmScorecard[] }) {
  const ranked = useMemo(
    () =>
      scorecards
        .filter((c) => c.avgNoiGrowth !== null)
        .sort((a, b) => (b.avgNoiGrowth ?? 0) - (a.avgNoiGrowth ?? 0)),
    [scorecards],
  );
  const best = ranked[0] ?? null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1]! : null;

  return (
    <Card>
      <CardHeader
        title="Property Manager Snapshot"
        trailing={<Badge tone="neutral">by avg NOI growth</Badge>}
      />
      {ranked.length === 0 ? (
        <div className="px-4 py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          No manager NOI-growth data yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-px sm:grid-cols-2" style={{ background: 'var(--border-subtle)' }}>
          <PmCell label="Best manager" card={best} positive />
          <PmCell label="Worst manager" card={worst} positive={false} />
        </div>
      )}
      <div className="px-4 pb-3 pt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        Directional across few managers — see the Managers tab for the full scorecards.
      </div>
    </Card>
  );
}

function PmCell({ label, card, positive }: { label: string; card: PmScorecard | null; positive: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3" style={{ background: 'var(--surface-raised)' }}>
      <div className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      {card === null ? (
        <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
          —
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {card.propertyManager}
            </span>
            {card.smallSample && <Badge tone="neutral">small sample</Badge>}
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className="num text-base font-semibold"
              style={{ color: positive ? 'var(--text-pos)' : 'var(--text-neg)' }}
            >
              {fmtSignedPct(card.avgNoiGrowth)}
            </span>
            <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              {card.propertyCount} {card.propertyCount === 1 ? 'property' : 'properties'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure local helper: the latest full-year metric row per property (string-sortable period).
// ---------------------------------------------------------------------------

function latestFullYear(metrics: PeriodMetrics[]): Map<string, PeriodMetrics> {
  const m = new Map<string, PeriodMetrics>();
  for (const row of metrics) {
    if (row.grainHint !== 'year') continue;
    const cur = m.get(row.propertyId);
    if (!cur || row.period.localeCompare(cur.period) > 0) m.set(row.propertyId, row);
  }
  return m;
}
