// src/modules/overview/GovernorTiles.tsx
//
// Governor bullet tiles for the Overview KPI strip (design review 2026-10-31 finding 9): DSCR
// against the 1.25x floor, aggregate LTV against the 40% ceiling, firm cash against the $1.5M firm
// floor. Boundaries come from the snapshot's GovernorSet (GOVERNOR_FALLBACK on legacy payloads) and
// LIQUIDITY_POLICY (config/liquidity-policy.v1.json). Never restated here. Tiles stay neutral until a governor is breached; only
// the abnormal state is coloured.
import { useMemo, type ReactNode } from 'react';
import { GOVERNOR_FALLBACK, LIQUIDITY_POLICY, type PortfolioSnapshot, type Provenance as ProvenanceData } from '@contracts/index';
import { applyScenario, cashHeadroom, dscrHeadroom, firmCashBalance, fmtPct, fmtUsdCompact, ltvHeadroom, type PortfolioKpis } from '@analytics/index';
import { Card } from '@/primitives/Card';
import { Provenance } from '@/primitives/Provenance';
import { BulletGraph, type BulletState } from '@/charts/BulletGraph';
import { useUi } from '@/brain/ui-context';

const fmtX = (n: number) => `${n.toFixed(2)}x`;
// A breaching value is rounded TOWARD the breach side at display precision, so it can never print as
// the boundary itself (1.2496x must not read "1.25x ... below floor"; 40.04% must not read "40.0%
// ... above ceiling"; $1,499,999 must not read "$1.50M ... below floor"). Non-breaching values use
// the ordinary formatters.
// Round normally first, then step one display unit toward the breach side only while the rounded
// figure would still sit on the boundary — a plain Math.floor(n * 100) misprints exact two-decimal
// workbook values through float error (1.15 * 100 = 114.999… → "1.14x").
const fmtDscr = (n: number, floor: number) => {
  if (n >= floor) return fmtX(n);
  let c = Math.round(n * 100);
  while (c / 100 >= floor) c -= 1;
  return `${(c / 100).toFixed(2)}x`;
};
const fmtLtv = (n: number | null, ceiling: number) => {
  if (n === null || n <= ceiling) return fmtPct(n);
  let c = Math.round(n * 1000);
  while (c / 1000 <= ceiling) c += 1;
  return fmtPct(c / 1000);
};
const fmtCash = (n: number | null, floor: number) => {
  if (n === null || n >= floor) return fmtUsdCompact(n);
  const step = Math.abs(n) >= 1_000_000 ? 10_000 : 1_000; // fmtUsdCompact's granularity below $10M
  return fmtUsdCompact(Math.floor(n / step) * step);
};

function GovernorTile({
  name, label, display, prov, state, bullet, lines,
}: {
  name: string;
  label: string;
  display: string;
  prov?: ProvenanceData;
  state: BulletState | 'unknown';
  bullet: ReactNode;
  lines: { text: string; abnormal?: boolean }[];
}) {
  return (
    <Card className="overflow-hidden">
      <div role="group" aria-label={name} data-state={state} className="flex flex-col gap-2 px-4 pt-3.5 pb-3.5">
        <div className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
          {label}
        </div>
        <div className="num text-2xl font-semibold leading-none" style={{ color: state === 'breach' ? 'var(--text-neg)' : 'var(--text-primary)' }}>
          {prov ? <Provenance prov={prov}>{display}</Provenance> : display}
        </div>
        {bullet}
        {lines.map((l) => (
          <div key={l.text} className="truncate text-2xs" title={l.text} style={{ color: l.abnormal ? 'var(--text-warn)' : 'var(--text-tertiary)' }}>
            {l.text}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function GovernorTiles({ snapshot, kpis }: { snapshot: PortfolioSnapshot; kpis: PortfolioKpis }) {
  const { scenario } = useUi();
  // Same scenario basis as the analytics bundle the rest of the strip reads (useAnalytics).
  const properties = useMemo(() => applyScenario(snapshot, scenario).properties, [snapshot, scenario]);
  const gov = snapshot.governors ?? GOVERNOR_FALLBACK;
  const dscr = dscrHeadroom(properties, gov.dscrFloor);
  const ltv = ltvHeadroom(kpis.ltv.value, gov.ltvCeiling);
  // Firm cash = the "Oxford" Cash Balances entity — Gabriel's INTERIM PROXY (2026-11-02) for the
  // ratified sweepable-cash basis, which the snapshot cannot compute yet (see firmCashBalance). No unique Oxford entity (incl. an absent feed) → unknown, never a
  // breach and never OK. The all-entity total is shown as context only; it carries no verdict.
  const cash = cashHeadroom(firmCashBalance(snapshot.cash.entities), LIQUIDITY_POLICY.firmCashFloorUsd);
  const cashState: BulletState | 'unknown' = cash.value === null ? 'unknown' : cash.breached ? 'breach' : 'ok';

  // A non-Base scenario shocks NOI (engine.applyScenario), so the DSCR figures are modeled, not workbook.
  const dscrSource = scenario === 'Base' ? 'workbook' : `Scenario: ${scenario} (modeled)`;
  const dscrState: BulletState | 'unknown' = dscr.portfolio === null ? 'unknown' : dscr.breached ? 'breach' : dscr.weakestBelowFloor ? 'watch' : 'ok';
  const ltvState: BulletState | 'unknown' = ltv.value === null ? 'unknown' : ltv.breached ? 'breach' : 'ok';
  const n = dscr.leveredCount;
  const dscrBasis = `${n} levered propert${n === 1 ? 'y' : 'ies'} · affiliate notes included · Σ NOI / Σ debt service · ${dscrSource}`;
  const weakestText = dscr.weakest ? `weakest ${dscr.weakest.name} ${fmtDscr(dscr.weakest.dscr, dscr.floor)}` : null;
  const dscrSummary = dscr.portfolio === null
    ? `DSCR not available — no levered properties. Floor ${fmtX(dscr.floor)}.`
    : `DSCR ${fmtDscr(dscr.portfolio, dscr.floor)} against the ${fmtX(dscr.floor)} floor, ${dscr.breached ? 'below floor' : 'within governor'}.` +
      (dscr.weakest ? ` Weakest property ${dscr.weakest.name} ${fmtDscr(dscr.weakest.dscr, dscr.floor)}${dscr.weakestBelowFloor ? ', below floor' : ''}.` : '') +
      ` Basis: Σ NOI / Σ debt service over ${n} levered propert${n === 1 ? 'y' : 'ies'}, affiliate notes included, Oxford share, ${dscrSource}.`;
  const dscrMax = Math.max(dscr.floor * 2, (dscr.portfolio ?? 0) * 1.1, (dscr.weakest?.dscr ?? 0) * 1.1);

  const ltvSummary = ltv.value === null
    ? `LTV not available. Ceiling ${fmtPct(ltv.ceiling)}.`
    : `LTV ${fmtLtv(ltv.value, ltv.ceiling)} against the ${fmtPct(ltv.ceiling)} ceiling, ${ltv.breached ? 'above ceiling' : 'within governor'}. Basis: aggregate third-party loan balance / Σ value, affiliate notes excluded.`;
  const ltvMax = Math.max(ltv.ceiling * 1.5, (ltv.value ?? 0) * 1.1);

  const cushionText = cash.cushion === null ? null
    : cash.cushion >= 0 ? `+${fmtUsdCompact(cash.cushion)} over floor` : `${fmtUsdCompact(-cash.cushion)} below floor`;
  const cashSummary = cash.value === null
    ? `Firm cash unknown — no single Oxford entity in Cash Balances. Floor ${fmtUsdCompact(cash.floor)}. No floor verdict.`
    : `Firm cash ${fmtCash(cash.value, cash.floor)} against the ${fmtUsdCompact(cash.floor)} floor, ${cash.breached ? `below floor by ${fmtUsdCompact(-(cash.cushion ?? 0))}` : 'within floor'}. Basis: Oxford entity balance, interim proxy until the ratified sweepable-cash basis is computable. All entities total ${fmtUsdCompact(kpis.totalCash.value)}, context only.`;
  const cashMax = Math.max(cash.floor * 2, (cash.value ?? 0) * 1.1);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <GovernorTile
        name="DSCR vs governor"
        label={`DSCR · floor ${fmtX(dscr.floor)}`}
        display={dscr.portfolio === null ? '—' : fmtDscr(dscr.portfolio, dscr.floor)}
        state={dscrState}
        bullet={<BulletGraph value={dscr.portfolio} target={dscr.floor} kind="floor" max={dscrMax} state={dscrState === 'unknown' ? 'ok' : dscrState} secondary={dscr.weakest?.dscr ?? null} summary={dscrSummary} />}
        lines={[{ text: dscrBasis }, ...(weakestText ? [{ text: weakestText, abnormal: dscr.weakestBelowFloor }] : [])]}
      />
      <GovernorTile
        name="LTV vs governor"
        label={`LTV · ceiling ${fmtPct(ltv.ceiling)}`}
        display={fmtLtv(ltv.value, ltv.ceiling)}
        prov={kpis.ltv.prov}
        state={ltvState}
        bullet={<BulletGraph value={ltv.value} target={ltv.ceiling} kind="ceiling" max={ltvMax} state={ltvState === 'breach' ? 'breach' : 'ok'} summary={ltvSummary} />}
        lines={[{ text: 'aggregate · affiliate notes excluded · third-party debt / Σ value' }]}
      />
      <GovernorTile
        name="Cash vs floor"
        label={`Firm cash · Oxford entity · floor ${fmtUsdCompact(cash.floor)}`}
        display={fmtCash(cash.value, cash.floor)}
        state={cashState}
        bullet={<BulletGraph value={cash.value} target={cash.floor} kind="floor" max={cashMax} state={cashState === 'breach' ? 'breach' : 'ok'} summary={cashSummary} />}
        lines={[
          { text: cushionText ?? 'unknown — no single Oxford entity', abnormal: cash.value === null },
          { text: `all entities ${fmtUsdCompact(kpis.totalCash.value)} · context, not the floor basis` },
        ]}
      />
    </div>
  );
}
