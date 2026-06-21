// src/modules/intel/PropertyIntelView.tsx
//
// The per-property "verdict → root cause → recommendation" page (PFI Phase B.2). Lead
// with the ownership verdict (health + capital action + rationale), then the levels
// (KPI row), then the trajectory (since-acquisition + annual trends), then the root cause
// (ΔNOI driver waterfall between the two latest FULL-YEAR periods), then anomalies. NOT a
// chart gallery — charts serve the narrative.
//
// Selection is LIFTED into IntelModule (so the tab remembers it): this view takes
// `propertyId` + `onSelectProperty` and calls the analytics hooks itself. Every null is
// guarded — a no-SF property (1851 Solar → null $/SF) shows '—' tiles and no crash; a
// single-period property shows no waterfall / no since-acquisition (pre-mortem #2). On an
// unavailable warehouse the whole module already renders the offline Card upstream; this
// view additionally degrades to a Skeleton while the analytics queries load, and labels
// its scoring basis "Scored on FY{period}" so the FY-vs-YTD grain is never misread
// (pre-mortem #5). No AreaChart — annual periods are 'YYYY', so trends use BarChart with
// 'FY2024' labels and tiles use Sparkline (pre-mortem #1).
import { useMemo } from 'react';
import { fmtUsd, fmtUsdCompact, fmtPct } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { BarChart } from '@/charts/BarChart';
import { BarList } from '@/charts/BarList';
import { Waterfall, type WaterfallDriver } from '@/charts/Waterfall';
import {
  useScores,
  useMetrics,
  useGrowth,
  useAnomalies,
  useDrivers,
  type PropertyScore,
  type PeriodMetrics,
  type SinceAcquisition,
  type AnomalyFlag,
  type AttentionBand,
  type AnomalySeverity,
} from './analytics-hooks';
import { rankByAttention } from './synthesis';
import { ExportBriefingButton } from './ExportBriefingButton';
import {
  buildAnnualSeries,
  fullYearPeriods,
  periodLabel,
  pickDriverPeriods,
  pickPeriodMetrics,
  recommendedAction,
  rootCauseLine,
} from './property-intel';

// ---------------------------------------------------------------------------
// Tone maps (engine band → Badge tone).
// ---------------------------------------------------------------------------

const ATTENTION_TONE: Record<AttentionBand, BadgeTone> = {
  green: 'green',
  yellow: 'gold',
  orange: 'amber',
  red: 'red',
};

const SEVERITY_TONE: Record<AnomalySeverity, BadgeTone> = {
  low: 'neutral',
  moderate: 'gold',
  high: 'amber',
  critical: 'red',
};

const HEALTH_TONE: Record<PropertyScore['healthBand'], BadgeTone> = {
  excellent: 'green',
  good: 'green',
  watch: 'gold',
  concern: 'red',
};

const CAPITAL_TONE: Record<PropertyScore['capitalAction'], BadgeTone> = {
  invest: 'green',
  hold: 'blue',
  monitor: 'gold',
  'disposition-candidate': 'red',
};

const CAPITAL_LABEL: Record<PropertyScore['capitalAction'], string> = {
  invest: 'invest',
  hold: 'hold',
  monitor: 'monitor',
  'disposition-candidate': 'disposition candidate',
};

interface Props {
  propertyId: string | null;
  onSelectProperty: (id: string) => void;
  /** Module-level selected period (PFI Phase B.3 item 3) — governs the KPI-row LEVELS only;
   *  the verdict, trends, since-acquisition and ΔNOI bridge stay on the full-year basis. */
  period: string | null;
  /** Display label for the selected period ('FY2025' / '2026 YTD'); null → "latest FY". */
  periodLabel: string | null;
}

/**
 * Renders a property intelligence dashboard with ownership verdict, KPIs, growth metrics, and anomaly analysis.
 *
 * Selects the property to display based on `propertyId` or defaults to the property requiring the most attention. Displays property selector, ownership verdict, KPI tiles with sparklines, since-acquisition growth, annual trends, ΔNOI waterfall analysis, and anomalies.
 *
 * @param period - Controls the period for KPI tile levels only; other cards remain on a full-year basis
 * @param periodLabel - Display label for the selected period (e.g., `'FY2025'`, `'2026 YTD'`), or `null` for latest full year
 */
export function PropertyIntelView({ propertyId, onSelectProperty, period, periodLabel: kpiPeriodLabel }: Props) {
  const scores = useScores();
  const metrics = useMetrics();
  const growth = useGrowth();
  const anomalies = useAnomalies();

  // Selector source: scores ranked red→green (worst attention first) so the property most
  // in need of ownership attention is the first chip and the default selection.
  const ranked = useMemo(() => rankByAttention(scores.data ?? []), [scores.data]);

  // Effective selection: the lifted id if it still maps to a scored property, else the
  // first (worst-attention) ranked property. The driver hooks key off this, so resolve it
  // before the early returns to keep the hook order stable.
  const selectedId = useMemo(() => {
    if (propertyId && ranked.some((s) => s.propertyId === propertyId)) return propertyId;
    return ranked[0]?.propertyId ?? null;
  }, [propertyId, ranked]);

  const propMetrics = useMemo(
    () => (metrics.data ?? []).filter((m) => m.propertyId === selectedId),
    [metrics.data, selectedId],
  );
  const driverPeriods = useMemo(() => pickDriverPeriods(propMetrics), [propMetrics]);
  // Drivers are enabled only with two full-year periods (the hook is disabled otherwise).
  const drivers = useDrivers(selectedId, driverPeriods?.from ?? null, driverPeriods?.to ?? null);

  const loading = scores.isLoading || metrics.isLoading || growth.isLoading || anomalies.isLoading;
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton style={{ height: 56 }} />
        <Skeleton style={{ height: 150 }} />
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 260 }} />
      </div>
    );
  }

  if (ranked.length === 0 || selectedId === null) {
    return (
      <Card>
        <CardHeader title="Per-Property Intelligence" />
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No scored properties yet. Approve a committed import to populate the analytics engine.
        </div>
      </Card>
    );
  }

  const score = ranked.find((s) => s.propertyId === selectedId) ?? null;
  const fyMetrics = fullYearPeriods(propMetrics);
  const latestFy = fyMetrics[fyMetrics.length - 1] ?? null;
  // KPI-row levels follow the module-selected period (falls back to latest FY); trends, the
  // since-acquisition strip and the ΔNOI bridge below stay on the full-year basis.
  const displayMetrics = pickPeriodMetrics(propMetrics, period);
  const sinceAcq = (growth.data?.sinceAcquisition ?? []).find((s) => s.propertyId === selectedId) ?? null;
  const propAnomalies = (anomalies.data ?? []).filter((a) => a.propertyId === selectedId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <PropertySelector ranked={ranked} selectedId={selectedId} onSelect={onSelectProperty} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ExportBriefingButton kind="property" id={selectedId} />
          <ExportBriefingButton kind="property" id={selectedId} narrative />
        </div>
      </div>

      {score && (
        <VerdictHeader
          score={score}
          rootCause={rootCauseLine(drivers.data ?? null)}
          driversLoading={drivers.isLoading}
          hasTwoFy={driverPeriods !== null}
        />
      )}

      <KpiRow
        metrics={propMetrics}
        latestFy={displayMetrics}
        quartile={score?.noiPerSfQuartile ?? null}
        periodLabel={kpiPeriodLabel}
      />

      <SinceAcquisitionStrip sinceAcq={sinceAcq} />

      <TrendsRow fyMetrics={fyMetrics} allMetrics={propMetrics} latestFy={latestFy} />

      <RootCauseCard
        from={driverPeriods?.from ?? null}
        to={driverPeriods?.to ?? null}
        fromNoi={fromPeriodNoi(fyMetrics)}
        toNoi={latestFy ? latestFy.noi : null}
        totalDelta={drivers.data?.totalDelta ?? null}
        drivers={drivers.data?.drivers ?? null}
        driversLoading={drivers.isLoading}
      />

      {propAnomalies.length > 0 && <AnomaliesCard anomalies={propAnomalies} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Property selector — chips ordered red→green, the worst-attention property first.
// ---------------------------------------------------------------------------

function PropertySelector({
  ranked,
  selectedId,
  onSelect,
}: {
  ranked: PropertyScore[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Property"
        trailing={<Badge tone="neutral">{ranked.length} scored · worst attention first</Badge>}
      />
      <div className="flex flex-wrap gap-1.5 px-4 py-3">
        {ranked.map((s) => {
          const active = s.propertyId === selectedId;
          const tone = ATTENTION_TONE[s.attentionBand];
          return (
            <button
              key={s.propertyId}
              onClick={() => onSelect(s.propertyId)}
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-semibold transition-colors"
              style={
                active
                  ? { background: 'var(--accent-quiet)', color: 'var(--text-primary)', border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)' }
                  : { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }
              }
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone === 'gold' ? 'var(--accent)' : tone === 'amber' ? 'var(--color-warn)' : tone === 'red' ? 'var(--color-neg)' : 'var(--color-pos)' }} />
              {s.propertyName ?? s.propertyId}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Verdict header — gold-accent Card leading with the ownership verdict.
// ---------------------------------------------------------------------------

function VerdictHeader({
  score,
  rootCause,
  driversLoading,
  hasTwoFy,
}: {
  score: PropertyScore;
  /** Synthesized ΔNOI root-cause line, or null (single-period / no drivers). */
  rootCause: string | null;
  driversLoading: boolean;
  /** Whether the property has the two full years a ΔNOI bridge needs. */
  hasTwoFy: boolean;
}) {
  // WHY: lead with the synthesized root cause; degrade clearly when it can't be computed.
  const why = !hasTwoFy
    ? 'Needs two full years to bridge the NOI change.'
    : driversLoading
      ? 'Analyzing ΔNOI drivers…'
      : (rootCause ?? 'ΔNOI drivers unavailable.');
  // DO: the recommended action from the capital action + leading reason.
  const recommended = recommendedAction(score);
  return (
    <Card accent>
      <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-5">
          <div>
            <div className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
              Health
            </div>
            <div className="num text-4xl font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>
              {score.health}
            </div>
            <div className="num mt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              Scored on FY{score.period}
            </div>
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <div className="text-lg display font-semibold" style={{ color: 'var(--text-primary)' }}>
              {score.propertyName ?? score.propertyId}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={HEALTH_TONE[score.healthBand]}>{score.healthBand}</Badge>
              <Badge tone={ATTENTION_TONE[score.attentionBand]} dot>{score.attentionBand} attention</Badge>
              <Badge tone={CAPITAL_TONE[score.capitalAction]}>{CAPITAL_LABEL[score.capitalAction]}</Badge>
            </div>
          </div>
        </div>
        {score.reasons.length > 0 && (
          <div className="lg:max-w-[42%]">
            <div className="num mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
              Rationale
            </div>
            <ul className="flex flex-col gap-1">
              {score.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <span aria-hidden style={{ color: 'var(--accent)' }}>•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {/* WHY → DO: the answer-first synthesis (PFI Phase B.3 item 2). */}
      <div
        className="grid grid-cols-1 gap-x-6 gap-y-3 border-t px-5 py-3 sm:grid-cols-2"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div>
          <div className="num mb-1 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
            Why
          </div>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{why}</div>
        </div>
        <div>
          <div className="num mb-1 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
            Recommended
          </div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{recommended}</div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// KPI row — NOI / NOI margin / NOI/SF / Revenue/SF / Expense ratio, each with a FY
// sparkline. Ownership overlay on NOI when ownershipPct<1. Null $/SF renders '—'.
// ---------------------------------------------------------------------------

function KpiRow({
  metrics,
  latestFy,
  quartile,
  periodLabel,
}: {
  metrics: PeriodMetrics[];
  latestFy: PeriodMetrics | null;
  /** Portfolio NOI/SF quartile from the property's score (1=best … 4=worst), null if unranked. */
  quartile: number | null;
  /** Label of the displayed period ('FY2025' / '2026 YTD'); null → "latest FY". */
  periodLabel: string | null;
}) {
  const noiSeries = buildAnnualSeries(metrics, (m) => m.noi);
  const marginSeries = buildAnnualSeries(metrics, (m) => m.noiMargin);
  const noiPerSfSeries = buildAnnualSeries(metrics, (m) => m.noiPerSf);
  const revPerSfSeries = buildAnnualSeries(metrics, (m) => m.revenuePerSf);
  const expRatioSeries = buildAnnualSeries(metrics, (m) => m.expenseRatio);

  const noiSublabel = noiSublabelFor(latestFy);
  // NOI/SF quartile sublabel — '—' when the property has no SF (null $/SF) or is unranked.
  const quartileSublabel =
    latestFy === null || latestFy.noiPerSf === null || quartile === null ? '—' : `Q${quartile} of portfolio`;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <KpiStat
        label={`NOI (${periodLabel ?? 'latest FY'})`}
        value={latestFy ? latestFy.noi : null}
        format={(n) => (n === null ? '—' : fmtUsdCompact(n))}
        accentColor="var(--color-pos)"
        spark={noiSeries}
        sublabel={noiSublabel}
      />
      <KpiStat
        label="NOI Margin"
        value={latestFy ? latestFy.noiMargin : null}
        format={(n) => (n === null ? '—' : fmtPct(n))}
        accentColor="var(--accent)"
        spark={marginSeries}
      />
      <KpiStat
        label="NOI / SF"
        value={latestFy ? latestFy.noiPerSf : null}
        format={(n) => (n === null ? '—' : fmtUsd(n, true))}
        accentColor="var(--color-info)"
        spark={noiPerSfSeries}
        sublabel={quartileSublabel}
      />
      <KpiStat
        label="Revenue / SF"
        value={latestFy ? latestFy.revenuePerSf : null}
        format={(n) => (n === null ? '—' : fmtUsd(n, true))}
        accentColor="var(--color-accent2)"
        spark={revPerSfSeries}
      />
      <KpiStat
        label="Expense Ratio"
        value={latestFy ? latestFy.expenseRatio : null}
        format={(n) => (n === null ? '—' : fmtPct(n))}
        accentColor="var(--color-warn)"
        spark={expRatioSeries}
      />
    </div>
  );
}

/** NOI of the earlier of the two latest full-year periods (the waterfall's start), or null
 *  when fewer than two FY periods exist. */
function fromPeriodNoi(fyMetrics: PeriodMetrics[]): number | null {
  if (fyMetrics.length < 2) return null;
  return fyMetrics[fyMetrics.length - 2]!.noi;
}

/** Oxford-share overlay on the NOI tile when the firm owns <100% of the asset. */
function noiSublabelFor(latestFy: PeriodMetrics | null): string | undefined {
  if (!latestFy || latestFy.ownershipPct >= 1) return undefined;
  const pct = Math.round(latestFy.ownershipPct * 100);
  return `Oxford ${pct}%: ${fmtUsdCompact(latestFy.oxfordNoi)}`;
}

// ---------------------------------------------------------------------------
// Since-acquisition strip — growth from the anchor FY; "insufficient history" when not
// comparable (single-period property).
// ---------------------------------------------------------------------------

function SinceAcquisitionStrip({ sinceAcq }: { sinceAcq: SinceAcquisition | null }) {
  if (!sinceAcq || !sinceAcq.comparable || sinceAcq.anchorPeriod === null) {
    return (
      <Card>
        <CardHeader title="Since Acquisition" />
        <div className="px-4 py-5 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Insufficient history — need two full years to measure growth since acquisition.
        </div>
      </Card>
    );
  }
  const items: Array<{ label: string; value: number | null }> = [
    { label: 'NOI', value: sinceAcq.noiGrowth },
    { label: 'NOI / SF', value: sinceAcq.noiPerSfGrowth },
    { label: 'Revenue', value: sinceAcq.revenueGrowth },
    { label: 'Taxes', value: sinceAcq.taxesGrowth },
    { label: 'Insurance', value: sinceAcq.insuranceGrowth },
  ];
  return (
    <Card>
      <CardHeader
        title="Since Acquisition"
        trailing={<Badge tone="neutral">since FY{sinceAcq.anchorPeriod}</Badge>}
      />
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-3 md:grid-cols-5">
        {items.map((it) => (
          <div key={it.label}>
            <div className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
              {it.label}
            </div>
            <div
              className="num mt-1 text-base font-semibold"
              style={{ color: growthColor(it.value) }}
            >
              {fmtSignedPct(it.value)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function growthColor(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'var(--text-tertiary)';
  return v >= 0 ? 'var(--color-pos)' : 'var(--color-neg)';
}

/** Signed percentage, '—' when null. Positive carries a leading '+' for legibility. */
function fmtSignedPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v >= 0 ? `+${fmtPct(v)}` : fmtPct(v);
}

// ---------------------------------------------------------------------------
// Trends — left: annual NOI BarChart (YTD bar tagged); right: latest-FY expense breakdown.
// ---------------------------------------------------------------------------

function TrendsRow({
  fyMetrics,
  allMetrics,
  latestFy,
}: {
  fyMetrics: PeriodMetrics[];
  allMetrics: PeriodMetrics[];
  latestFy: PeriodMetrics | null;
}) {
  // Annual NOI series: every FY period, plus any YTD period (tagged '{year} YTD').
  const noiBars = useMemo(() => {
    const rows = [...allMetrics].sort((a, b) => a.period.localeCompare(b.period));
    return rows.map((m) => ({ label: periodLabel(m.period, m.grainHint), value: m.noi }));
  }, [allMetrics]);

  const expenseItems = useMemo(() => {
    if (!latestFy) return [];
    return Object.entries(latestFy.categories)
      .filter(([, v]) => Number.isFinite(v) && v !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([label, value]) => ({ label, value: Math.abs(value), display: fmtUsd(value) }));
  }, [latestFy]);

  return (
    <Card>
      <CardHeader
        title="Trends"
        trailing={<Badge tone="gold">{fyMetrics.length} full {fyMetrics.length === 1 ? 'year' : 'years'}</Badge>}
      />
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="num mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>
            Annual NOI
          </div>
          {noiBars.length > 0 ? (
            <BarChart data={noiBars} valueFormat={fmtUsdCompact} height={220} color="var(--color-pos)" />
          ) : (
            <div className="py-8 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>No annual NOI yet.</div>
          )}
        </div>
        <div>
          <div className="num mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>
            {latestFy ? `Expense breakdown · FY${latestFy.period}` : 'Expense breakdown'}
          </div>
          {expenseItems.length === 0 ? (
            <div className="py-4 text-2xs" style={{ color: 'var(--text-tertiary)' }}>No categorized expenses for the latest full year.</div>
          ) : (
            <BarList items={expenseItems} />
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Root cause — ΔNOI driver waterfall between the two latest FULL-YEAR periods.
// ---------------------------------------------------------------------------

function RootCauseCard({
  from,
  to,
  fromNoi,
  toNoi,
  totalDelta,
  drivers,
  driversLoading,
}: {
  from: string | null;
  to: string | null;
  fromNoi: number | null;
  toNoi: number | null;
  totalDelta: number | null;
  drivers: WaterfallDriver[] | null;
  driversLoading: boolean;
}) {
  // No two full years → no bridge (single-period / YTD-only property).
  if (from === null || to === null) {
    return (
      <Card>
        <CardHeader title="Root Cause — ΔNOI" />
        <div className="px-4 py-8 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Needs two full years to bridge the NOI change.
        </div>
      </Card>
    );
  }

  if (driversLoading || drivers === null || totalDelta === null || fromNoi === null || toNoi === null) {
    return (
      <Card>
        <CardHeader title={`Root Cause — ΔNOI FY${from}→FY${to}`} />
        <div className="p-4">
          <Skeleton style={{ height: 220 }} />
        </div>
      </Card>
    );
  }

  // Ground the bridge in real NOI levels: start = FY{from} NOI, end = FY{to} NOI. The
  // engine guarantees Σdriver = totalDelta = toNoi − fromNoi, so the last driver lands
  // exactly on the End total (the Waterfall component enforces base ≤ top per bar). The
  // one-line root-cause synthesis now leads the verdict hero above (PFI Phase B.3 item 2),
  // so this card is the detailed bridge only — no duplicated headline.
  return (
    <Card>
      <CardHeader
        title={`Root Cause — ΔNOI FY${from}→FY${to}`}
        trailing={
          <Badge tone={totalDelta >= 0 ? 'green' : 'red'}>
            {totalDelta >= 0 ? '+' : '−'}{fmtUsd(Math.abs(totalDelta))}
          </Badge>
        }
      />
      <div className="overflow-x-auto px-2 py-2">
        <Waterfall
          startValue={fromNoi}
          drivers={drivers}
          endValue={toNoi}
          startLabel={`FY${from}`}
          endLabel={`FY${to}`}
          height={260}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Anomalies — this property's flagged anomalies (severity Badge + detail).
// ---------------------------------------------------------------------------

function AnomaliesCard({ anomalies }: { anomalies: AnomalyFlag[] }) {
  return (
    <Card>
      <CardHeader title="Anomalies" trailing={<Badge tone="amber">{anomalies.length}</Badge>} />
      <div className="flex flex-col">
        {anomalies.map((a, i) => (
          <div
            key={`${a.kind}-${a.period}-${i}`}
            className="flex items-start justify-between gap-3 px-4 py-2.5"
            style={{ borderTop: i === 0 ? undefined : '1px solid var(--border-subtle)' }}
          >
            <div className="flex items-start gap-2.5">
              <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-primary)' }}>{a.detail}</div>
                <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{a.kind} · {a.period}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
