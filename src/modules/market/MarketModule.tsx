import { lazy, Suspense } from 'react';
import { useMacro, useAnalytics } from '@/data/queries';
import { fmtDate, noiGapNames } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { Tabs, TabPanel } from '@/primitives/Tabs';
import { AreaChart } from '@/charts/AreaChart';
import { useTabParam, CLEAR_VIEW } from '@/lib/useTabParam';
import { useTabSpecs } from '@/shell/tab-badges';
import { ModuleLoading } from '@/shell/ModuleFallback';
import { FORCE_MOUNT_PANEL } from '@/lib/forceMountPanel';
import { useMarketIntel } from './hooks';
import { MarketScorecard } from './MarketScorecard';
import { CompsView } from './CompsView';
import { MARKET_TABS, MARKET_TAB_KEYS, type MarketTab } from './tabs';
import { isLiveMacro } from './macro-badge';
import { acquisitionLens } from './acquisition-lens';

const ProspectDemandModule = lazy(() => import('../intel/ProspectDemandModule').then((m) => ({ default: m.ProspectDemandModule })));

// Tab shell — hosts the FRED macro dashboard (MacroView: badge + KPIs + 10Y + Acquisition Lens,
// a same-glance group), the Market Intelligence scorecards, the Comps tab (task 7.3) and Demand
// (the former standalone Demand Signals module, Phase 4c). Tab state lives in the URL (`?tab=`)
// via useTabParam; a tab change clears `?view=` (Rule H).
export function MarketModule() {
  const [tab, setTab] = useTabParam<MarketTab>(MARKET_TAB_KEYS, 'macro', 'tab', CLEAR_VIEW);
  // R4: badges declared on MARKET_TABS reach the strip (useTabSpecs is the one mapping).
  const tabSpecs = useTabSpecs(MARKET_TABS);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Market" />
      </Card>

      {/* keyboardActivation="manual" — the Comps and Demand tabs mount their own warehouse queries
          (useCapitalAllocationReport / useProspectDemand) on mount, so arrowing through the strip
          shouldn't fan out queries (plan R9). The macro / scorecards panels are force-mounted
          (they were one scroll before the split, so useMarketIntel already fired on mount). */}
      <Tabs tabs={tabSpecs} selectedKey={tab} onSelectionChange={(k) => setTab(k as MarketTab)} keyboardActivation="manual" aria-label="Market views">
        <TabPanel id="macro" {...FORCE_MOUNT_PANEL}>
          <MacroView />
        </TabPanel>
        <TabPanel id="scorecards" {...FORCE_MOUNT_PANEL}>
          <MarketIntelSection />
        </TabPanel>
        <TabPanel id="comps">
          <CompsView />
        </TabPanel>
        <TabPanel id="demand">
          <Suspense fallback={<ModuleLoading />}>
            <ProspectDemandModule />
          </Suspense>
        </TabPanel>
      </Tabs>
    </div>
  );
}

function MacroView() {
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
  // A blank workbook NOI leaves the weighted cap incomplete: the spread is withheld (follow-up to audit HIGH #2).
  const lens = acquisitionLens(wtdCap, tenY, analytics ? noiGapNames(analytics.kpis) : []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Badge tone={isLiveMacro(macro.source) ? 'green' : 'amber'} dot>
          {isLiveMacro(macro.source) ? `FRED · live · ${fmtDate(macro.asOf)}` : 'FRED · snapshot (set FRED_API_KEY for live)'}
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
            <AreaChart data={macro.tenYearHistory} valueFormat={(n) => `${n.toFixed(2)}%`} height={250} color="var(--accent)" ariaLabel="10-year Treasury yield (DGS10), 12-month path" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Acquisition Lens" />
          <div className="flex flex-col gap-3 p-4">
            <Row label="Portfolio weighted cap" value={lens.capText} />
            <Row label="10Y Treasury" value={tenY !== null ? `${tenY.toFixed(2)}%` : '—'} />
            <Row label="Cap-rate spread" value={lens.spreadText} accent />
            {lens.note && (
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                {lens.note}
              </p>
            )}
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              Spread of in-place cap rate over the risk-free 10Y — a quick read on relative value for new acquisitions.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

// Phase 5 W3 — Market intelligence scorecard per cluster. Lives on its own tab, so the two
// no-data branches that used to render nothing (a blank gap in the Macro scroll) now render an
// explanatory empty state instead (R7 — a tab is never left blank).
function MarketIntelSection() {
  const { data: signals, isLoading, error } = useMarketIntel();

  if (isLoading) return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {[1, 2, 3].map(i => <Skeleton key={i} style={{ height: 90, borderRadius: 8 }} />)}
    </div>
  );

  if (error || !signals || signals.length === 0) return (
    <Card>
      <CardHeader title="Market Intelligence" trailing={<Badge tone="amber">Advisory</Badge>} />
      <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
        {error || !signals
          ? 'Market intelligence scorecards are unavailable right now — they load from the warehouse on the local Brain Server.'
          : 'No market intelligence scorecards yet — none of the tracked markets has a computed signal.'}
      </div>
    </Card>
  );

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
      <span className="num text-sm font-semibold" style={{ color: accent ? 'var(--text-accent)' : 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
