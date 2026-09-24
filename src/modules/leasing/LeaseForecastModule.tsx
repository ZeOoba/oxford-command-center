// src/modules/leasing/LeaseForecastModule.tsx
//
// Phase 3 W2 — Leasing Intelligence UI.
//
// Layout (IA decongestion Phase 4d — the Leasing destination; tab state in the URL via useTabParam,
// `?tab=`, default Rollover; see ./tabs.ts). Five tabs, this module owns the strip:
//   Above the strip (R2): A. Expiry Bucket Cards — 4 cards (0-6m / 6-12m / 12-24m / 24m+), shown ONLY
//                on the forecast-backed tabs (Rollover / Forecast / Market rents)
//   Rollover     — C. Leasing Velocity Table (per-property time-to-lease)
//   Rent roll    — the absorbed LeasesModule (rent roll + critical dates), lazy-mounted
//   Forecast     — B. Rent Forecast scenario selector + POST mutation, with E. the AI leasing narrative
//                  beneath it (deliberately NOT its own tab — the destination is capped at 5 tabs)
//   Market rents — D. Market-Rent Editor — inline form to set/clear per-property market rents
//   Tenants      — the absorbed TenantsModule, lazy-mounted
//
// Rule G: the warehouse-offline gate belongs to the forecast-backed tabs ONLY. Rent roll and Tenants
// read the snapshot and work on the static mirror, so a 503 from the leasing-forecast route must never
// blank them — there is no whole-module early return here. The bucket-card visibility and the offline
// gate derive from ONE condition (`forecastScoped` / `forecastOffline` below).
import { lazy, Suspense, useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, TrendingUp, TrendingDown, Pencil } from 'lucide-react';
import { useLeaseForecast, BUCKET_DISPLAY_ORDER } from './hooks';
import { isWarehouseUnavailable, WAREHOUSE_KEYS } from '../intel/hooks';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { saveMarketRent } from '@/data/actions';
import { ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';
import { fmtUsdCompact, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Tabs, TabPanel } from '@/primitives/Tabs';
import { SegmentedControl } from '@/primitives/SegmentedControl';
import { useTabParam, CLEAR_VIEW } from '@/lib/useTabParam';
import { ModuleLoading } from '@/shell/ModuleFallback';
import { useTabSpecs } from '@/shell/tab-badges';
import { LEASING_TABS, LEASING_TAB_KEYS, LEASING_FORECAST_TABS, type LeasingTab } from './tabs';
import type { RentScenario, RentForecastResult, LeasingVelocity, LeaseNarrativeResponse as LeaseNarrative } from '@contracts/lease-forecast';
import { RentForecastResponse, LeaseNarrativeResponse } from '@contracts/lease-forecast';

// ── Expiry bucket display helpers ──────────────────────────────────────────────

const BUCKET_LABELS: Record<string, string> = {
  '0-6m': '0–6 Months',
  '6-12m': '6–12 Months',
  '12-24m': '12–24 Months',
  '24m+': '24+ Months',
};

const BUCKET_TONES: Record<string, 'red' | 'amber' | 'neutral' | 'green'> = {
  '0-6m': 'red',
  '6-12m': 'amber',
  '12-24m': 'neutral',
  '24m+': 'green',
};

// Use the canonical order from hooks.ts (re-exported for this file's JSX usage)
const DISPLAY_BUCKETS = BUCKET_DISPLAY_ORDER;

// ── Scenario helpers ───────────────────────────────────────────────────────────

const SCENARIO_LABELS: Record<RentScenario, string> = {
  renew_at_current: 'Renew at Current',
  renew_at_market: 'Renew at Market',
  vacancy_haircut: 'Vacancy Haircut',
};

async function fetchRentForecast(
  scenario: RentScenario,
  vacancyPct: number,
): Promise<RentForecastResult | null> {
  const res = await fetch('/api/warehouse/leasing/rent-forecast', {
    method: 'POST',
    headers: ORA_JSON_MUTATION_HEADERS,
    body: JSON.stringify({ scenarios: [scenario], horizonMonths: 12, vacancyPct }),
  });
  if (!res.ok) throw new Error(`Rent forecast failed (${res.status})`);
  const parsed = RentForecastResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error('Invalid rent forecast response payload');
  return parsed.data.results[0] ?? null;
}

// ── Tabs ───────────────────────────────────────────────────────────────────────

const LeasesModule = lazy(() => import('../leases/LeasesModule').then((m) => ({ default: m.LeasesModule })));
const TenantsModule = lazy(() => import('../tenants/TenantsModule').then((m) => ({ default: m.TenantsModule })));

const SCENARIO_OPTIONS = (['renew_at_current', 'renew_at_market', 'vacancy_haircut'] as RentScenario[]).map((s) => ({
  value: s,
  label: SCENARIO_LABELS[s],
}));

// ── Velocity table ─────────────────────────────────────────────────────────────

const velocityCols: Column<LeasingVelocity>[] = [
  {
    key: 'property',
    header: 'Property',
    render: (v) => <span style={{ fontWeight: 600 }}>{v.propertyName}</span>,
    sortValue: (v) => v.propertyName,
  },
  {
    key: 'median',
    header: 'Median Days to Lease',
    align: 'right',
    render: (v) =>
      v.medianDaysToLease === null ? (
        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
      ) : (
        <span
          className="num"
          style={{ color: v.slowLeasing ? 'var(--text-warn)' : 'var(--text-primary)' }}
        >
          {v.medianDaysToLease}
        </span>
      ),
    sortValue: (v) => v.medianDaysToLease,
  },
  {
    key: 'events',
    header: 'Events',
    align: 'right',
    render: (v) => <span className="num">{fmtNum(v.leasingEventsN)}</span>,
    sortValue: (v) => v.leasingEventsN,
  },
  {
    key: 'slow',
    header: 'Slow?',
    render: (v) =>
      v.slowLeasing ? (
        <Badge tone="amber">Slow</Badge>
      ) : (
        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
      ),
    sortValue: (v) => (v.slowLeasing ? 1 : 0),
  },
];

// ── Market-rent editor ─────────────────────────────────────────────────────────

const fieldStyle = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
} as const;

function MarketRentEditor({ marketRents }: { marketRents: Record<string, number> }) {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [psf, setPsf] = useState('');
  const keyRef = useRef<HTMLInputElement>(null);

  const saveMutation = useMutation({
    mutationFn: ({ k, p }: { k: string; p: number }) => saveMarketRent(k, p),
    onSuccess: () => {
      // Invalidate both the snapshot (overlay update) and the leasing forecast (market gaps re-computed)
      void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY });
      void qc.invalidateQueries({ queryKey: WAREHOUSE_KEYS.noi });
      void qc.invalidateQueries({ queryKey: ['warehouse', 'leasing'] });
      setKey('');
      setPsf('');
      keyRef.current?.focus();
    },
  });

  const handleSave = () => {
    const trimmed = key.trim();
    const val = parseFloat(psf);
    if (!trimmed || !Number.isFinite(val) || val < 0) return;
    saveMutation.mutate({ k: trimmed, p: val });
  };

  const handleClear = (k: string) => {
    saveMutation.mutate({ k, p: 0 }); // 0 signals "absent" per the overlay contract
  };

  const entries = Object.entries(marketRents).filter(([, v]) => v > 0);

  return (
    <Card>
      <CardHeader
        title="Market Rents"
        trailing={
          <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            $/SF · overlay-sourced
          </span>
        }
      />
      <div className="flex flex-col gap-3 p-4">
        <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Enter a property key or lease ID with a $/SF annual market rent. Used for the
          under-market gap signal and the "Renew at Market" forecast scenario.
        </div>

        {/* Existing entries */}
        {entries.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {entries.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-3 py-1.5" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
                <span className="num text-2xs font-medium" style={{ color: 'var(--text-secondary)' }}>{k}</span>
                <div className="flex items-center gap-2">
                  <span className="num text-2xs" style={{ color: 'var(--text-pos)' }}>${v.toFixed(2)}/SF</span>
                  <button
                    onClick={() => handleClear(k)}
                    disabled={saveMutation.isPending}
                    className="num text-2xs"
                    style={{ color: 'var(--text-tertiary)', opacity: saveMutation.isPending ? 0.5 : 1 }}
                    aria-label={`Clear market rent for ${k}`}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add form */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={keyRef}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Property key or lease ID"
            aria-label="Property key for market rent"
            className="num h-8 rounded-[var(--radius-sm)] px-2.5 text-2xs outline-none"
            style={{ ...fieldStyle, width: 200 }}
          />
          <div className="flex items-center gap-1">
            <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>$</span>
            <input
              value={psf}
              onChange={(e) => setPsf(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
              placeholder="0.00"
              aria-label="Market rent per SF"
              type="number"
              min={0}
              step={0.25}
              className="num h-8 w-20 rounded-[var(--radius-sm)] px-2.5 text-2xs outline-none"
              style={fieldStyle}
            />
            <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>/SF</span>
          </div>
          <Button
            size="sm"
            variant="subtle"
            onPress={handleSave}
            isDisabled={saveMutation.isPending || !key.trim() || !psf}
            aria-label="Save market rent"
          >
            <Pencil size={12} /> Set
          </Button>
        </div>

        {saveMutation.isError && (
          <div className="text-2xs" style={{ color: 'var(--text-neg)' }}>
            Save failed — brain server not reachable.
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Main module ────────────────────────────────────────────────────────────────

async function fetchLeaseNarrative(): Promise<LeaseNarrative> {
  const res = await fetch('/api/warehouse/leasing/narrative');
  if (!res.ok) throw new Error(`Narrative fetch failed (${res.status})`);
  const parsed = LeaseNarrativeResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error('Invalid narrative response payload');
  return parsed.data;
}

export function LeaseForecastModule() {
  const { data, error } = useLeaseForecast();
  const { data: snapshotData } = useSnapshot();
  const [tab, setTab] = useTabParam<LeasingTab>(LEASING_TAB_KEYS, 'rollover', 'tab', CLEAR_VIEW);
  // R4: severity badges (Rent roll = overdue critical dates). LEASING_TABS is a module-level constant, so the
  // badge hooks run in a stable order. The badge lives on the destination tab, not the inner SegmentedControl.
  const tabSpecs = useTabSpecs(LEASING_TABS);

  const [scenario, setScenario] = useState<RentScenario>('renew_at_current');
  const [vacancyPct, setVacancyPct] = useState(0.1);

  const rentMutation = useMutation({
    mutationFn: () => fetchRentForecast(scenario, vacancyPct),
  });

  const narrativeMutation = useMutation({
    mutationFn: fetchLeaseNarrative,
  });

  // Graceful warehouse degradation (Rule G). ONE condition drives both the bucket cards and the offline
  // gate: they only apply on the forecast-backed tabs; Rent roll / Tenants are never gated.
  const warehouseDown = isWarehouseUnavailable(error);
  const forecastScoped = LEASING_FORECAST_TABS.has(tab);
  const forecastOffline = forecastScoped && warehouseDown;
  const showBuckets = forecastScoped && !forecastOffline;
  const marketRents = snapshotData?.snapshot.marketRents ?? {};

  const buckets = data?.bucketTotals ?? [];
  const velocity = data?.velocity ?? [];
  const forecast = rentMutation.data ?? null;

  // The offline card for a forecast-backed panel (the market-rent editor below it stays usable: its
  // writes go to the overlay, not the warehouse).
  const offlineCard = (
    <Card>
      <div className="px-6 py-10 text-center" style={{ color: 'var(--text-tertiary)' }}>
        <TrendingUp size={28} className="mx-auto mb-3 opacity-40" />
        <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Leasing Intelligence Unavailable
        </div>
        <div className="mt-1 text-2xs">
          Warehouse routes are not reachable on the static mirror. Run the local brain server to
          enable leasing forecasts, velocity tracking, and rent gap analysis.
        </div>
      </div>
    </Card>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Section A — Expiry Bucket Cards (forecast-backed tabs only; R2 above the strip) */}
      {showBuckets && (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {DISPLAY_BUCKETS.map((bucket) => {
          const b = buckets.find((x) => x.bucket === bucket);
          return (
            <div
              key={bucket}
              className="flex flex-col gap-1.5 rounded-[var(--radius-md)] p-4"
              style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
            >
              <Badge tone={BUCKET_TONES[bucket]}>{BUCKET_LABELS[bucket]}</Badge>
              <div className="num mt-1 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {b ? fmtNum(b.count) : '—'}
              </div>
              <div className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>
                {b ? fmtUsdCompact(b.expiringRent) : '—'}
              </div>
              <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                {b ? `${fmtNum(b.expiringSf)} SF` : '—'}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* keyboardActivation="manual": the Rent roll / Tenants panels mount their own queries, so arrowing
          across the strip must not fire them. The forecast + narrative mutations only fire on an explicit
          button press, never on tab selection. */}
      <Tabs tabs={tabSpecs} selectedKey={tab} onSelectionChange={(k) => setTab(k as LeasingTab)} keyboardActivation="manual" aria-label="Leasing views">
      <TabPanel id="forecast">
      {forecastOffline ? offlineCard : (
        <div className="flex flex-col gap-4">
        {/* Section B — Rent Forecast Scenario */}
        <Card>
          <CardHeader
            title="Rent Forecast"
            trailing={
              <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                Workbook basis
              </span>
            }
          />
          <div className="flex flex-col gap-4 p-4">
            {/* Scenario picker — R5 level-2 switch (local state, no side effects until Run). */}
            <SegmentedControl
              aria-label="Rent forecast scenario"
              options={SCENARIO_OPTIONS}
              value={scenario}
              onChange={setScenario}
            />

            {/* Vacancy pct slider — only for vacancy_haircut */}
            {scenario === 'vacancy_haircut' && (
              <div className="flex items-center gap-3">
                <label className="num text-2xs" style={{ color: 'var(--text-secondary)', minWidth: 80 }}>
                  Vacancy {Math.round(vacancyPct * 100)}%
                </label>
                <input
                  type="range"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={vacancyPct}
                  onChange={(e) => setVacancyPct(Number(e.target.value))}
                  className="w-40"
                  aria-label="Vacancy percentage"
                />
              </div>
            )}

            {/* Run button */}
            <div>
              <Button
                size="sm"
                variant="subtle"
                onPress={() => rentMutation.mutate()}
                isDisabled={rentMutation.isPending}
                aria-label="Run rent forecast"
              >
                Run Forecast <ArrowRight size={12} />
              </Button>
            </div>

            {/* Result */}
            {forecast && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-6">
                  <div>
                    <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>In-Place</div>
                    <div className="num text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {fmtUsdCompact(forecast.inPlaceAnnualRent)}
                    </div>
                  </div>
                  <ArrowRight size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <div>
                    <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>Projected</div>
                    <div className="num text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {fmtUsdCompact(forecast.projectedAnnualRent)}
                    </div>
                  </div>
                  <div>
                    <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>NOI Impact</div>
                    <div
                      className="num text-lg font-semibold flex items-center gap-1"
                      style={{ color: forecast.noiImpactAnnualUsd >= 0 ? 'var(--text-pos)' : 'var(--text-neg)' }}
                    >
                      {forecast.noiImpactAnnualUsd >= 0 ? (
                        <TrendingUp size={14} />
                      ) : (
                        <TrendingDown size={14} />
                      )}
                      {fmtUsdCompact(Math.abs(forecast.noiImpactAnnualUsd))}
                    </div>
                  </div>
                  <div>
                    <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>Expiring in Horizon</div>
                    <div className="num text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {fmtUsdCompact(forecast.expiringRentInHorizon)}
                    </div>
                  </div>
                </div>
                {forecast.assumptions.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {forecast.assumptions.map((a, i) => (
                      <li key={i} className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                        · {a}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {rentMutation.isError && (
              <div className="text-2xs" style={{ color: 'var(--text-neg)' }}>
                Forecast unavailable — warehouse not reachable.
              </div>
            )}
          </div>
        </Card>

        {/* Section E — AI Leasing Narrative (rendered beneath the forecast, same tab) */}
        <Card>
          <CardHeader
            title="AI Leasing Narrative"
            trailing={
              <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                Haiku 4.5 · fail-open
              </span>
            }
          />
          <div className="flex flex-col gap-3 p-4">
            <Button
              size="sm"
              variant="subtle"
              onPress={() => narrativeMutation.mutate()}
              isDisabled={narrativeMutation.isPending}
              aria-label="Generate leasing narrative"
            >
              Generate Leasing Narrative <ArrowRight size={12} />
            </Button>

            {narrativeMutation.isError && (
              <div className="text-2xs" style={{ color: 'var(--text-neg)' }}>
                Narrative unavailable — brain server not reachable.
              </div>
            )}

            {narrativeMutation.data && (
              <>
                {narrativeMutation.data.degraded ? (
                  <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                    Narrative unavailable — AI key not configured.
                  </div>
                ) : narrativeMutation.data.narrative ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Badge tone="amber">AI Generated</Badge>
                    </div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                      {narrativeMutation.data.narrative.headline}
                    </p>
                    <p className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
                      {narrativeMutation.data.narrative.summary}
                    </p>
                    {narrativeMutation.data.narrative.bullets.length > 0 && (
                      <ul className="list-disc pl-5 space-y-1">
                        {narrativeMutation.data.narrative.bullets.map((bullet, i) => (
                          <li key={i} className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
                            {bullet}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </Card>
        </div>
      )}
      </TabPanel>

      {/* Section C — Leasing Velocity */}
      <TabPanel id="rollover">
      {forecastOffline ? offlineCard : (
        <Card>
          <CardHeader title="Leasing Velocity" />
          {velocity.length === 0 ? (
            <div className="px-4 py-8 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              No leasing event history yet — populate lease_events to enable velocity tracking.
            </div>
          ) : (
            <DataTable
              columns={velocityCols}
              rows={velocity}
              getRowId={(v) => v.propertyId}
              initialSort={{ key: 'median', dir: 'asc' }}
              maxHeight={360}
            />
          )}
        </Card>
      )}
      </TabPanel>

      <TabPanel id="market-rents">
      <div className="flex flex-col gap-4">
      {forecastOffline && offlineCard}
      {/* Section D — Market-Rent Editor (available even on the mirror: writes go to the overlay) */}
      <MarketRentEditor marketRents={marketRents} />
      </div>
      </TabPanel>

      <TabPanel id="rent-roll"><Suspense fallback={<ModuleLoading />}><LeasesModule /></Suspense></TabPanel>
      <TabPanel id="tenants"><Suspense fallback={<ModuleLoading />}><TenantsModule /></Suspense></TabPanel>
      </Tabs>

    </div>
  );
}
