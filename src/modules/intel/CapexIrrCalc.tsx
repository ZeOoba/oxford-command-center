// src/modules/intel/CapexIrrCalc.tsx
//
// Capex / Improvement IRR Calculator panel (item-8).
//
// Shows the capital verdict says "invest" but leaves return on investment unquantified.
// This panel fills that gap: given a proposed capex, projected annual NOI uplift, and
// hold period, it computes the unlevered IRR and compares it to the ratified capex hurdle
// (CAPITAL_CONFIG.capexIrr = 15%) imported from capital-config — never hardcoded here.
//
// Only rendered when capitalAction is 'invest' or 'monitor' (improvement is being considered).
//
// Math: see src/modules/intel/capex-irr.ts — pure functions, independently tested.
import { useState, useMemo } from 'react';
import { fmtUsd, fmtPct } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { CAPITAL_CONFIG } from '../../../server/warehouse/capital-config';
import { computeCapexIrr, npvAtRate } from './capex-irr';
import type { PropertyScore } from './analytics-hooks';

// ---------------------------------------------------------------------------
// Defaults — representative starting point, user overrides via inputs.
// ---------------------------------------------------------------------------
const DEFAULT_CAPEX = 100_000;
const DEFAULT_UPLIFT = 20_000;
const DEFAULT_HOLD = 5;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  /** The property's current capital action — panel only shows for invest/monitor. */
  capitalAction: PropertyScore['capitalAction'];
  /** Property name for the panel heading. */
  propertyName: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Interactive IRR calculator for a proposed capex improvement on a property.
 *
 * Renders only when capitalAction is 'invest' or 'monitor'. Inputs are controlled
 * locally (no server round-trip — pure client math). The hurdle rate is imported from
 * CAPITAL_CONFIG.capexIrr so any future governed rate change flows through automatically.
 */
export function CapexIrrCalc({ capitalAction, propertyName }: Props) {
  // Only relevant when investment/improvement is being considered.
  if (capitalAction !== 'invest' && capitalAction !== 'monitor') return null;

  return <CapexIrrPanel propertyName={propertyName} />;
}

function CapexIrrPanel({ propertyName }: { propertyName: string | null }) {
  const hurdle = CAPITAL_CONFIG.capexIrr; // 0.15 from governed constants

  // Controlled inputs
  const [capex, setCapex] = useState<number>(DEFAULT_CAPEX);
  const [uplift, setUplift] = useState<number>(DEFAULT_UPLIFT);
  const [hold, setHold] = useState<number>(DEFAULT_HOLD);

  // Pure computation — no side effects
  const result = useMemo(() => {
    const irr = computeCapexIrr(capex, uplift, hold);
    const npv = Number.isFinite(irr)
      ? npvAtRate(capex, uplift, hold, hurdle)
      : null;
    const passesHurdle = Number.isFinite(irr) && irr >= hurdle;
    return { irr, npv, passesHurdle };
  }, [capex, uplift, hold, hurdle]);

  // Derived display
  const irrDisplay = !Number.isFinite(result.irr)
    ? result.irr === -Infinity
      ? '−∞'
      : '—'
    : fmtPct(result.irr);

  const npvDisplay =
    result.npv !== null && Number.isFinite(result.npv)
      ? fmtUsd(result.npv)
      : '—';

  const verdict =
    !Number.isFinite(result.irr)
      ? 'No return — do not deploy capital'
      : result.passesHurdle
        ? `Above hurdle (${fmtPct(hurdle)}) — deploy capital`
        : `Below hurdle (${fmtPct(hurdle)}) — do not deploy`;

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

      {/* Inputs */}
      <div
        className="grid grid-cols-1 gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-3"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <LabeledInput
          label="Proposed capex ($)"
          value={capex}
          min={1}
          step={5_000}
          onChange={setCapex}
        />
        <LabeledInput
          label="Annual NOI uplift ($)"
          value={uplift}
          min={0}
          step={1_000}
          onChange={setUplift}
        />
        <LabeledInput
          label="Hold period (years)"
          value={hold}
          min={1}
          max={10}
          step={1}
          onChange={(v) => setHold(Math.min(10, Math.max(1, Math.round(v))))}
        />
      </div>

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
            surplus above {fmtPct(hurdle)} cost of capital
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
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label
        className="num mb-1.5 block text-2xs font-semibold uppercase"
        style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}
      >
        {label}
      </label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
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
