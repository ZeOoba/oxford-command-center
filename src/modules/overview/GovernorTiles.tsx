// src/modules/overview/GovernorTiles.tsx
//
// Governor bullet tiles for the Overview KPI strip (design review 2026-10-31 finding 9): DSCR
// against the 1.25x floor, aggregate LTV against the 40% ceiling, firm cash against the $1.5M firm
// floor. Boundaries come from the snapshot's GovernorSet (GOVERNOR_FALLBACK on legacy payloads) and
// LIQUIDITY_POLICY (config/liquidity-policy.v1.json). Never restated here. Tiles stay neutral until a governor is breached; only
// the abnormal state is coloured.
import { useMemo, type ReactNode } from 'react';
import { GOVERNOR_FALLBACK, LIQUIDITY_POLICY, type PortfolioSnapshot, type Provenance as ProvenanceData } from '@contracts/index';
import {
  applyScenario, cashHeadroom, dscrHeadroom, firmCashBalance, fmtPct, fmtUsdCompact, GOVERNOR_INPUT_FIELDS, GOVERNOR_INPUT_LABEL,
  isInvestmentProperty, ltvHeadroom, ltvIncompleteRows, type IncompleteGovernorRow, type PortfolioKpis,
} from '@analytics/index';
import { Card } from '@/primitives/Card';
import { Provenance } from '@/primitives/Provenance';
import { BulletGraph, type BulletState } from '@/charts/BulletGraph';
import { useUi } from '@/brain/ui-context';
import { landlordCostCaveat } from './landlord-cost-caveat';

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
  /** `title` overrides the hover text when the line is a short form of a longer explanation. */
  lines: { text: string; abnormal?: boolean; title?: string }[];
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
          <div key={l.text} className="truncate text-2xs" title={l.title ?? l.text} style={{ color: l.abnormal ? 'var(--text-warn)' : 'var(--text-tertiary)' }}>
            {l.text}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** "blank NOI on Bravo Flex" / "blank NOI, Debt Service on 2 levered rows (A, B)" — names the cells to fill. */
const incompleteText = (rows: readonly IncompleteGovernorRow[]): { short: string; long: string } => {
  // Canonical field order, never first-appearance (row order must not change the text).
  const fields = GOVERNOR_INPUT_FIELDS.filter((f) => rows.some((r) => r.fields.includes(f))).map((f) => GOVERNOR_INPUT_LABEL[f]).join(', ');
  const n = rows.length;
  return {
    short: `incomplete · blank ${fields} on ${n} levered row${n === 1 ? '' : 's'}`,
    long: `blank ${fields} on ${rows.map((r) => r.name).join(', ')}`,
  };
};

export function GovernorTiles({ snapshot, kpis }: { snapshot: PortfolioSnapshot; kpis: PortfolioKpis }) {
  const { scenario } = useUi();
  // Same scenario basis as the analytics bundle the rest of the strip reads (useAnalytics).
  const properties = useMemo(() => applyScenario(snapshot, scenario).properties, [snapshot, scenario]);
  const gov = snapshot.governors ?? GOVERNOR_FALLBACK;
  const dscr = dscrHeadroom(properties, gov.dscrFloor);
  const ltv = ltvHeadroom(kpis.ltv.value, gov.ltvCeiling);
  // Audit 2026-11-12 HIGH #2: a blank governor input on a levered row makes the figure incomplete
  // (dscrHeadroom / portfolioKpis.ltv return null) — the tile says so and names the cells to fill.
  const dscrGap = dscr.incomplete.length > 0 ? incompleteText(dscr.incomplete) : null;
  const ltvRows = ltvIncompleteRows(properties.filter(isInvestmentProperty));
  const ltvGap = ltvRows.length > 0 ? incompleteText(ltvRows) : null;
  // With a blank loan the known third-party debt / Σ value is a LOWER BOUND on aggregate LTV (balances
  // are non-negative). Above the ceiling, the breach is certain whatever the blank holds, so it is
  // shown as a breach, never as "no verdict" (refute wf_fe0c7b48-326). Below it, the tile stays unknown.
  // Only a bound when every blank-loan row carries a known (positive) value. A row whose Value is also
  // blank (0) understates Σ value, the DENOMINATOR, so known debt / Σ value could OVERSTATE the true
  // LTV; withholding the breach there is fail-safe (unknown, never ok).
  const boundable = ltvRows.every((r) => (properties.find((p) => p.id === r.id)?.oxfordValue ?? 0) > 0);
  const ltvLowerBound = ltvGap && boundable && kpis.totalDebt.value !== null && kpis.value.value ? kpis.totalDebt.value / kpis.value.value : null;
  const ltvLowerBoundBreach = ltvLowerBound !== null && ltvLowerBound > ltv.ceiling;
  // Firm cash = the "Oxford" Cash Balances entity — Gabriel's INTERIM PROXY (2026-11-02) for the
  // ratified sweepable-cash basis, which the snapshot cannot compute yet (see firmCashBalance). No unique Oxford entity (incl. an absent feed) → unknown, never a
  // breach and never OK. The all-entity total is shown as context only; it carries no verdict.
  const cash = cashHeadroom(firmCashBalance(snapshot.cash.entities), LIQUIDITY_POLICY.firmCashFloorUsd);
  const cashState: BulletState | 'unknown' = cash.value === null ? 'unknown' : cash.breached ? 'breach' : 'ok';

  // A non-Base scenario shocks NOI (engine.applyScenario), so the DSCR figures are modeled, not workbook.
  const dscrSource = scenario === 'Base' ? 'workbook' : `Scenario: ${scenario} (modeled)`;
  // Incomplete aggregate: a weakest property already below the floor still shows 'watch' — that row's
  // workbook DSCR is known; only the aggregate is not (refute wf_fe0c7b48-326).
  const dscrState: BulletState | 'unknown' = dscr.portfolio === null
    ? (dscrGap && dscr.weakestBelowFloor ? 'watch' : 'unknown')
    : dscr.breached ? 'breach' : dscr.weakestBelowFloor ? 'watch' : 'ok';
  const ltvState: BulletState | 'unknown' = ltvLowerBoundBreach ? 'breach' : ltv.value === null ? 'unknown' : ltv.breached ? 'breach' : 'ok';
  const n = dscr.leveredCount;
  const dscrBasis = `${n} levered propert${n === 1 ? 'y' : 'ies'} · affiliate notes included · Σ NOI / Σ debt service · ${dscrSource}`;
  const weakestText = dscr.weakest ? `weakest ${dscr.weakest.name} ${fmtDscr(dscr.weakest.dscr, dscr.floor)}` : null;
  // Design review 2026-10-31 finding 6: a levered property whose expenses read $0 (NNN, not absolute)
  // has its DSCR overstated by the unsourced landlord-paid costs. Population = dscrHeadroom's own
  // levered set (dscr.leveredIds: levered + unknown-Debt-Service investment rows), so `of` equals
  // dscr.leveredCount (refute wf_da5abccb-d31).
  const leveredIds = new Set(dscr.leveredIds);
  const llDscr = landlordCostCaveat(properties.filter((p) => leveredIds.has(p.id)), { measure: 'this DSCR' });
  // Neutral, not warn: on these tiles colour means a governor state (breach / weakest below floor),
  // and a data caveat is not one. The words carry it.
  const llDscrLine = llDscr
    ? { text: `LL costs not sourced on ${llDscr.flagged.length} of ${llDscr.of} levered`, title: llDscr.title }
    : null;
  const dscrSummary = dscrGap
    ? `DSCR incomplete — ${dscrGap.long}. Floor ${fmtX(dscr.floor)}. No governor verdict until the workbook cells are filled.`
    : dscr.portfolio === null
    ? `DSCR not available — no levered properties. Floor ${fmtX(dscr.floor)}.`
    : `DSCR ${fmtDscr(dscr.portfolio, dscr.floor)} against the ${fmtX(dscr.floor)} floor, ${dscr.breached ? 'below floor' : 'within governor'}.` +
      (dscr.weakest ? ` Weakest property ${dscr.weakest.name} ${fmtDscr(dscr.weakest.dscr, dscr.floor)}${dscr.weakestBelowFloor ? ', below floor' : ''}.` : '') +
      ` Basis: Σ NOI / Σ debt service over ${n} levered propert${n === 1 ? 'y' : 'ies'}, affiliate notes included, Oxford share, ${dscrSource}.`;
  const dscrMax = Math.max(dscr.floor * 2, (dscr.portfolio ?? 0) * 1.1, (dscr.weakest?.dscr ?? 0) * 1.1);

  const ltvSummary = ltvGap && ltvLowerBoundBreach
    ? `LTV at least ${fmtLtv(ltvLowerBound, ltv.ceiling)} against the ${fmtPct(ltv.ceiling)} ceiling, above ceiling (incomplete — ${ltvGap.long}; the known debt alone breaches).`
    : ltvGap
    ? `LTV incomplete — ${ltvGap.long}. Ceiling ${fmtPct(ltv.ceiling)}. No governor verdict until the workbook cells are filled.`
    : ltv.value === null
    ? `LTV not available. Ceiling ${fmtPct(ltv.ceiling)}.`
    : `LTV ${fmtLtv(ltv.value, ltv.ceiling)} against the ${fmtPct(ltv.ceiling)} ceiling, ${ltv.breached ? 'above ceiling' : 'within governor'}. Basis: aggregate third-party loan balance / Σ value, affiliate notes excluded.`;
  const ltvMax = Math.max(ltv.ceiling * 1.5, (ltv.value ?? ltvLowerBound ?? 0) * 1.1);

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
        lines={[
          ...(dscrGap ? [{ text: dscrGap.short, abnormal: true, title: `DSCR incomplete — ${dscrGap.long}` }] : []),
          { text: dscrBasis },
          ...(weakestText ? [{ text: weakestText, abnormal: dscr.weakestBelowFloor }] : []),
          ...(llDscrLine ? [llDscrLine] : []),
        ]}
      />
      <GovernorTile
        name="LTV vs governor"
        label={`LTV · ceiling ${fmtPct(ltv.ceiling)}`}
        display={ltvLowerBoundBreach ? `≥${fmtLtv(ltvLowerBound, ltv.ceiling)}` : fmtLtv(ltv.value, ltv.ceiling)}
        prov={kpis.ltv.prov}
        state={ltvState}
        bullet={<BulletGraph value={ltvLowerBoundBreach ? ltvLowerBound : ltv.value} target={ltv.ceiling} kind="ceiling" max={ltvMax} state={ltvState === 'breach' ? 'breach' : 'ok'} summary={ltvSummary} />}
        lines={[
          ...(ltvGap ? [{ text: ltvGap.short, abnormal: true, title: `LTV incomplete — ${ltvGap.long}` }] : []),
          { text: 'aggregate · affiliate notes excluded · third-party debt / Σ value' },
        ]}
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
