import { useMacro, useAnalytics } from '@/data/queries';
import { fmtPct } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { AreaChart } from '@/charts/AreaChart';
import { useMarketIntel } from './hooks';
import { MarketScorecard } from './MarketScorecard';

export function MarketModule() {
  const { data: macro, isLoading } = useMacro();
  const { analytics } = useAnalytics();
  if (isLoading || !macro) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} style={{ height: 96 }} />)}
      </div>
    );
  }

  // Belt-and-braces against a stale baked /macro.json carrying the legacy 0-sentinel: a pre-cure
  // bake during a partial FRED outage produced indicators.DGS10.value = 0 with source='fred', and
  // a deployed mirror with that file would render '10Y at 0.00%' + an inflated cap-rate spread
  // (wtdCap * 100 - 0) until a re-bake overwrites it. Mirrors the agent-side guard in
  // server/ai/agent.ts summarizeMacro (`!dgs10 || dgs10.value === null || !Number.isFinite(...) ||
  // dgs10.value <= 0`). A real 10Y Treasury rate cannot be ≤ 0.
  const dgs10Value = macro.indicators.find((i) => i.id === 'DGS10')?.value;
  const tenY = dgs10Value != null && Number.isFinite(dgs10Value) && dgs10Value > 0 ? dgs10Value : null;
  const wtdCap = analytics?.kpis.weightedCapRate.value ?? null;
  const spreadPp = tenY !== null && wtdCap !== null ? wtdCap * 100 - tenY : null;
  const spreadBps = spreadPp !== null ? Math.round(spreadPp * 100) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Badge tone={macro.source === 'fred' ? 'green' : 'amber'} dot>
          {macro.source === 'fred' ? 'FRED · live' : 'FRED · snapshot (set FRED_API_KEY for live)'}
        </Badge>
        <span className="num text-2xs uppercase" style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
          Macro indicators
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {macro.indicators.map((ind) => {
          // Sanitize DGS10 against the legacy 0-sentinel from a pre-cure baked /macro.json (see
          // the comment on tenY above). The same guard is intentionally NOT applied to SOFR /
          // Fed Funds, where a near-zero reading is a legitimate zero-bound regime, not a
          // missing observation.
          const safeValue = ind.id === 'DGS10' && ind.value !== null && !(Number.isFinite(ind.value) && ind.value > 0)
            ? null
            : ind.value;
          return (
            <KpiStat
              key={ind.id}
              label={ind.label}
              value={safeValue}
              format={(n) => (n === null ? '—' : `${n.toFixed(2)}%`)}
              sublabel={ind.change === null ? undefined : `${ind.change >= 0 ? '+' : ''}${Math.round(ind.change * 100)} bps MoM`}
              accentColor={ind.id === 'DGS10' ? 'var(--accent)' : 'var(--color-info)'}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="10-Year Treasury — 12-Month Path" trailing={<Badge tone="neutral">DGS10</Badge>} />
          <div className="px-3 pb-2 pt-3">
            <AreaChart data={macro.tenYearHistory} valueFormat={(n) => `${n.toFixed(2)}%`} height={250} color="var(--accent)" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Acquisition Lens" />
          <div className="flex flex-col gap-3 p-4">
            <Row label="Portfolio weighted cap" value={wtdCap !== null ? fmtPct(wtdCap, 2) : '—'} />
            <Row label="10Y Treasury" value={tenY !== null ? `${tenY.toFixed(2)}%` : '—'} />
            <Row label="Cap-rate spread" value={spreadBps !== null ? `${spreadBps} bps` : '—'} accent />
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              Spread of in-place cap rate over the risk-free 10Y — a quick read on relative value for new acquisitions.
            </p>
          </div>
        </Card>
      </div>
      {/* Phase 5 W3 — Market intelligence scorecard per cluster */}
      <MarketIntelSection />
    </div>
  );
}

function MarketIntelSection() {
  const { data: signals, isLoading, error } = useMarketIntel();

  if (isLoading) return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {[1, 2, 3].map(i => <Skeleton key={i} style={{ height: 90, borderRadius: 8 }} />)}
    </div>
  );

  if (error || !signals) return null;
  if (signals.length === 0) return null;

  return (
    <div>
      <Card>
        <CardHeader
          title="Market Intelligence"
          trailing={<Badge tone="amber">Advisory</Badge>}
        />
      </Card>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 mt-3">
        {signals.map(s => <MarketScorecard key={s.cluster} signal={s} />)}
      </div>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="num text-2xs uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="num text-sm font-semibold" style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
