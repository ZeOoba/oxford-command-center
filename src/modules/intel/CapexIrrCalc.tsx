// src/modules/intel/CapexIrrCalc.tsx
//
// Capex / Improvement IRR Calculator panel (item-8).
//
// The capital verdict says "invest"/"monitor"/"hold" but leaves return on investment unquantified.
// This panel fills that gap: given a proposed capex, projected annual NOI uplift,
// and hold period, it computes the unlevered IRR and compares it to the DB-governed hurdleRatePct
// — the SAME threshold the live capital-allocation engine's own improve-gate uses
// (server/warehouse/capital-allocation.ts). Read live via useSnapshot() (governors.hurdleRatePct),
// falling back to GOVERNOR_FALLBACK — never the separate, static CAPITAL_CONFIG.capexIrr constant,
// which a refute pass found this panel silently contradicting (15% vs the engine's real 8% gate).
//
// Rendered for capitalAction 'invest', 'monitor', or 'hold' (hold widened 2026-07-16 — routine
// maintenance/roof capex decisions live there day to day). Not shown for 'disposition-candidate'.
//
// Math: see src/modules/intel/capex-irr.ts — pure functions, independently tested.
import { useState, useMemo } from 'react';
import { fmtUsd, fmtPct } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { useSnapshot } from '@/data/queries';
import { GOVERNOR_FALLBACK } from '@contracts/index';
import { computeCapexIrr, npvAtRate } from './capex-irr';
import type { PropertyScore } from './analytics-hooks';
import { pcaNearTermForProperty, usePropertyCondition } from '../property-condition/hooks';

// ---------------------------------------------------------------------------
// Defaults — representative starting point, user overrides via inputs.
// ---------------------------------------------------------------------------
// Round-3 finding: the prior defaults (100k/20k/5yr) undiscounted to exactly capex (20k*5=100k,
// a 0% IRR) -- every property showed a failing example verdict with zero user interaction. hold=10
// reuses the cross-checked ~15.1% case from capex-irr.test.ts (well above the 8% hurdle) instead
// of introducing a new unverified magic number.
const DEFAULT_CAPEX = 100_000;
const DEFAULT_UPLIFT = 20_000;
const DEFAULT_HOLD = 10;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  /** The property's current capital action — panel shows for invest, monitor, and hold. */
  capitalAction: PropertyScore['capitalAction'];
  /** Property name for the panel heading. */
  propertyName: string | null;
  /** property_master id — enables the optional PCA near-term repairs line (Property Condition ledger). */
  propertyId?: string | null;
}

/** Capital-action states this panel renders for — an explicit allow-list (not an exclude-list):
 *  a future 5th capitalAction value must be deliberately added here, not silently render the
 *  calculator by default (refute-pass finding on the original exclude-list form). */
const CAPEX_CALC_VISIBLE_ACTIONS: ReadonlySet<PropertyScore['capitalAction']> = new Set([
  'invest', 'monitor', 'hold',
]);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Interactive IRR calculator for a proposed capex improvement on a property.
 *
 * Renders for capitalAction 'invest', 'monitor', or 'hold'. Inputs are controlled locally (no
 * server round-trip — pure client math). The hurdle rate is read live via useSnapshot(), so a
 * DB-governed re-ratification of hurdleRatePct flows through with no code change here.
 */
export function CapexIrrCalc({ capitalAction, propertyName, propertyId = null }: Props) {
  if (!CAPEX_CALC_VISIBLE_ACTIONS.has(capitalAction)) return null;

  return <CapexIrrPanel propertyName={propertyName} propertyId={propertyId} />;
}

function CapexIrrPanel({ propertyName, propertyId }: { propertyName: string | null; propertyId: string | null }) {
  const { data } = useSnapshot();
  // PCA near-term repairs on file for this property — fetched only when a property id is supplied, so
  // every caller that does not pass one behaves exactly as before.
  const { data: pcaReport } = usePropertyCondition({ enabled: propertyId !== null });
  const pca = pcaNearTermForProperty(pcaReport, propertyId);
  const hurdle = data?.snapshot.governors?.hurdleRatePct ?? GOVERNOR_FALLBACK.hurdleRatePct;
  const isProposed = (data?.snapshot.governors?.hurdleRateRatification ?? GOVERNOR_FALLBACK.hurdleRateRatification) === 'proposed';

  // Controlled inputs — generic starting figures, not this property's actual projected numbers.
  const [capex, setCapex] = useState<number>(DEFAULT_CAPEX);
  const [uplift, setUplift] = useState<number>(DEFAULT_UPLIFT);
  const [hold, setHold] = useState<number>(DEFAULT_HOLD);
  // Opt-in: the PCA's near-term repairs are deferred maintenance the building needs regardless — the
  // capital-allocation engine floors its assumed spend at them (max, not sum), and this mirrors that, but only on request
  // (a default-on checkbox would silently change a generic example's verdict).
  const [includePca, setIncludePca] = useState(false);
  const effectiveCapex = includePca && pca ? Math.max(capex, pca.dollars) : capex;

  // Pure computation — no side effects. passesHurdle uses the RAW (unrounded) values with the
  // SAME strict `>` the live capital-allocation engine's own improve-gate uses — this is
  // comparison-LOGIC parity (see capex-irr.ts's header for the boundary case a third refute round
  // found: the bisected irr and hurdle can land on either side of `>` at a genuine tie, because
  // the bisection's own residual isn't exactly zero). Reading NPV and passesHurdle off the SAME
  // raw irr (not two independently-rounded values) is still what keeps them from CONTRADICTING
  // each other — a prior display-precision rounding scheme here reintroduced exactly that
  // contradiction, per a second refute pass — removed rather than patched again.
  const result = useMemo(() => {
    const irr = computeCapexIrr(effectiveCapex, uplift, hold);
    const npv = Number.isFinite(irr)
      ? npvAtRate(effectiveCapex, uplift, hold, hurdle)
      : null;
    const passesHurdle = Number.isFinite(irr) && irr > hurdle;
    return { irr, npv, passesHurdle };
  }, [effectiveCapex, uplift, hold, hurdle]);

  // Derived display. NaN (invalid inputs, e.g. capex=0) and -Infinity (a genuine no-return
  // project, uplift<=0) are DISTINCT failure modes with distinct copy — conflating them under one
  // "no return" message mislabels an input error as an investment verdict.
  const irrDisplay = !Number.isFinite(result.irr)
    ? result.irr === -Infinity
      ? '−∞'
      : '—'
    : fmtPct(result.irr);

  const npvDisplay =
    result.npv !== null && Number.isFinite(result.npv)
      ? fmtUsd(result.npv)
      : '—';

  // Deliberately NOT "deploy capital" / "do not deploy": CAPITAL_VERB (property-intel.ts) reserves
  // "Deploy capital" for capitalAction 'invest' specifically. Since this panel also renders for
  // 'hold' and 'monitor', reusing that phrasing would put "deploy capital" directly under a "Hold"
  // verdict header — a visible contradiction a refute pass flagged. This tool's own vocabulary
  // ("clears the hurdle") stays independent of the platform's capital-action verbs.
  // Round-3 finding (S4): the advisory banner above was purely additive -- the verdict card itself
  // never referenced isProposed, so it could still read as a plain, unqualified "Clears the
  // hurdle" if the banner went unnoticed. Only the two hurdle-comparison branches carry a
  // qualifier — the NaN/-Infinity branches are already not verdicts about the hurdle at all.
  const nonBindingSuffix = isProposed ? ' — non-binding' : '';
  const verdict = Number.isNaN(result.irr)
    ? 'Invalid inputs — enter a positive capex and hold period'
    : result.irr === -Infinity
      ? 'No positive return at these inputs'
      : result.passesHurdle
        ? `Clears the hurdle (${fmtPct(hurdle)})${nonBindingSuffix}`
        : `Does not clear the hurdle (${fmtPct(hurdle)})${nonBindingSuffix}`;

  const verdictTone = !Number.isFinite(result.irr)
    ? ('red' as const)
    : result.passesHurdle
      ? ('green' as const)
      : ('red' as const);

  return (
    <Card>
      <CardHeader
        title={`Capex IRR Calculator${propertyName ? ` — ${propertyName}` : ''}`}
        trailing={
          <Badge tone="neutral">
            hurdle {fmtPct(hurdle)}
          </Badge>
        }
      />

      {/* Advisory banner — mirrors HurdleRateBanner.tsx's existing treatment for a PROPOSED
          (not yet ratified) hurdle: every other hurdleRatePct consumer (the capital-allocation
          engine's advisoryOnly flag, that banner) treats a proposed rate as non-binding, and this
          panel must not silently drive a "clears the hurdle" verdict off one with no disclosure
          (Gabriel-directed fix). Latent today — the live rate is ratified. */}
      {isProposed && (
        <div
          className="mx-4 mt-3 flex items-center gap-2 rounded-md px-3 py-2.5 text-sm"
          style={{
            background: 'color-mix(in oklab, var(--color-warn) 12%, transparent)',
            border: '1px solid color-mix(in oklab, var(--color-warn) 35%, transparent)',
            color: 'var(--text-primary)',
          }}
        >
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            <strong>Advisory only</strong> — hurdle rate {fmtPct(hurdle)} pending ratification.
            Verdicts below are non-binding.
          </span>
        </div>
      )}

      {/* Assumptions disclosure — the model is unlevered, single-point (no growth), and has no
          terminal/exit value; omitting a caption invites reading a bare "%"/"$" figure as if it
          already accounted for those (refute-pass finding). */}
      <div
        className="px-4 pt-3 text-2xs"
        style={{ color: 'var(--text-tertiary)' }}
      >
        Unlevered, pre-tax IRR on a uniform annual NOI uplift — no growth, no terminal/exit value,
        whole years only. Figures below are example starting values, not this property's projected
        capex — edit them to model your own scenario.
      </div>

      {/* Inputs */}
      <div
        className="grid grid-cols-1 gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-3"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <LabeledInput
          id="capex-irr-capex"
          label="Proposed capex ($)"
          value={capex}
          min={1}
          step={5_000}
          onChange={setCapex}
        />
        <LabeledInput
          id="capex-irr-uplift"
          label="Annual NOI uplift ($)"
          value={uplift}
          min={0}
          step={1_000}
          onChange={setUplift}
        />
        <LabeledInput
          id="capex-irr-hold"
          label="Hold period (years)"
          value={hold}
          min={1}
          max={10}
          step={1}
          onChange={(v) => setHold(Math.min(10, Math.max(1, Math.round(v))))}
        />
      </div>

      {/* PCA near-term repairs (Property Condition ledger) — only when this property has PCA dollars on file. */}
      {pca && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-xs"
          style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <label htmlFor="capex-irr-include-pca" className="flex cursor-pointer items-center gap-2">
            <input
              id="capex-irr-include-pca"
              type="checkbox"
              checked={includePca}
              onChange={(e) => setIncludePca(e.target.checked)}
            />
            <span>
              Include PCA near-term repairs as a capex floor ({fmtUsd(pca.dollars)})
            </span>
          </label>
          <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            Immediate {fmtUsd(pca.immediateUsd)} + Yr 1–2 {fmtUsd(pca.shortTermUsd)} ·{' '}
            {pca.consultant ?? `${pca.reportCount} reports`}
            {pca.reportDate ? ` · oldest report ${pca.reportDate}` : ''} · deferred maintenance the building needs
            regardless. The capital-allocation engine uses eligible reports (with square footage) when they exceed its assumed spend; this line counts current building reports (a portfolio report is dropped when building reports exist)
          </span>
          {includePca && (
            <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              Total capex modeled: {fmtUsd(effectiveCapex)}
            </span>
          )}
        </div>
      )}

      {/* Outputs */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-3">
        {/* IRR */}
        <div>
          <div
            className="num text-2xs font-semibold uppercase"
            style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}
          >
            IRR
          </div>
          <div
            className="num mt-1.5 text-2xl font-semibold leading-none"
            style={{
              color: !Number.isFinite(result.irr)
                ? 'var(--color-neg)'
                : result.passesHurdle
                  ? 'var(--color-pos)'
                  : 'var(--color-neg)',
            }}
          >
            {irrDisplay}
          </div>
        </div>

        {/* NPV at hurdle */}
        <div>
          <div
            className="num text-2xs font-semibold uppercase"
            style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}
          >
            NPV at {fmtPct(hurdle)} hurdle
          </div>
          <div
            className="num mt-1.5 text-2xl font-semibold leading-none"
            style={{
              color:
                result.npv !== null && Number.isFinite(result.npv)
                  ? result.npv >= 0
                    ? 'var(--color-pos)'
                    : 'var(--color-neg)'
                  : 'var(--text-tertiary)',
            }}
          >
            {npvDisplay}
          </div>
          <div
            className="num mt-1 text-2xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {result.npv === null || !Number.isFinite(result.npv)
              ? `at the ${fmtPct(hurdle)} hurdle rate`
              : result.npv >= 0
                ? `surplus above the ${fmtPct(hurdle)} hurdle rate`
                : `shortfall against the ${fmtPct(hurdle)} hurdle rate`}
          </div>
        </div>

        {/* Verdict */}
        <div className="flex flex-col justify-center">
          <div
            className="num mb-2 text-2xs font-semibold uppercase"
            style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}
          >
            Verdict
          </div>
          <VerdictCard tone={verdictTone} label={verdict} />
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LabeledInput({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  // Round-3 finding: the field previously ignored a non-finite parseFloat result entirely, so
  // backspacing to empty snapped the DOM value back to the last valid number and a fresh keystroke
  // concatenated onto it instead of replacing it. rawText holds the user's in-progress (not yet
  // parseable) text; it's cleared back to null the moment a keystroke DOES parse, so the field then
  // reflects the (possibly clamped, e.g. hold-period) controlled value like it always did.
  const [rawText, setRawText] = useState<string | null>(null);
  const displayValue = rawText !== null ? rawText : String(value);

  return (
    <div>
      <label
        htmlFor={id}
        className="num mb-1.5 block text-2xs font-semibold uppercase"
        style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={displayValue}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const text = e.target.value;
          const v = parseFloat(text);
          if (Number.isFinite(v)) {
            setRawText(null);
            onChange(v);
          } else {
            setRawText(text);
          }
        }}
        className="num w-full rounded-md px-3 py-2 text-sm font-semibold"
        style={{
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-strong)',
          color: 'var(--text-primary)',
          outline: 'none',
        }}
      />
    </div>
  );
}

function VerdictCard({
  tone,
  label,
}: {
  tone: 'green' | 'red';
  label: string;
}) {
  const isPositive = tone === 'green';
  return (
    <div
      className="rounded-md px-3 py-2.5 text-sm font-semibold"
      style={{
        background: isPositive ? 'var(--color-pos-soft)' : 'var(--color-neg-soft)',
        color: isPositive ? 'var(--color-pos)' : 'var(--color-neg)',
        border: `1px solid ${isPositive ? 'color-mix(in oklab, var(--color-pos) 35%, transparent)' : 'color-mix(in oklab, var(--color-neg) 35%, transparent)'}`,
      }}
    >
      {label}
    </div>
  );
}
