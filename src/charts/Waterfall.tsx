/* eslint-disable react-refresh/only-export-components -- pure waterfallBars helper colocated with its chart (unit-tested) */
// src/charts/Waterfall.tsx
//
// ΔNOI driver waterfall — the signature root-cause visual: start NOI(A) → signed
// per-driver floating bars (revenue-positive / expense-negative) → end NOI(B). Plain SVG
// + theme tokens (no new deps, lean bundle — pre-mortem #6). `waterfallBars` is the pure
// layout-prep (unit-tested); the component renders those bars with fmtUsd value labels and
// a "needs 2 periods" empty state when there are no drivers (pre-mortem #2 sparse data).
import { useId } from 'react';
import { fmtUsd } from '@/analytics/format';
import { AXIS_TICK } from './theme';

export type WaterfallBarKind = 'total' | 'pos' | 'neg';

export interface WaterfallBar {
  label: string;
  /** Lower edge in value units (smaller of the two cumulative endpoints). */
  base: number;
  /** Upper edge in value units (larger of the two cumulative endpoints). */
  top: number;
  /** Signed value this bar represents (start/end carry the total; drivers carry their delta). */
  value: number;
  kind: WaterfallBarKind;
}

/** Minimal driver shape the bridge needs (mirrors the engine's NoiDriver subset). */
export interface WaterfallDriver {
  category: string;
  delta: number;
}

/**
 * Cumulative floating-bar positions for a ΔNOI bridge.
 *  - 'Start' and 'End' are full-height totals measured from 0 (base 0 → top = value).
 *  - Each driver floats on the running total: a positive delta RISES (base = running,
 *    top = running + delta), a negative delta DROPS (base = running + delta, top = running).
 *  After all drivers the running total equals `endValue` (the engine guarantees Σdelta = ΔNOI),
 *  so the last driver lands exactly on the End total. Pure; inputs are not mutated.
 */
export function waterfallBars(startValue: number, drivers: WaterfallDriver[], endValue: number): WaterfallBar[] {
  // Totals are measured from 0 but kept ORDERED (base ≤ top) so a negative NOI renders a
  // real downward bar from 0, not a top<base inversion that collapses to a 1px sliver.
  const total = (label: string, v: number): WaterfallBar => ({
    label, base: Math.min(0, v), top: Math.max(0, v), value: v, kind: 'total',
  });
  const bars: WaterfallBar[] = [total('Start', startValue)];
  let running = startValue;
  for (const d of drivers) {
    const next = running + d.delta;
    bars.push({
      label: d.category,
      base: Math.min(running, next),
      top: Math.max(running, next),
      value: d.delta,
      kind: d.delta >= 0 ? 'pos' : 'neg',
    });
    running = next;
  }
  bars.push(total('End', endValue));
  return bars;
}

interface Props {
  startValue: number;
  drivers: WaterfallDriver[];
  endValue: number;
  height?: number;
  /** Optional axis-label overrides for the two totals (e.g. 'FY2024' / 'FY2025'). */
  startLabel?: string;
  endLabel?: string;
  /** Accessible name for the chart's <svg>. Defaults to the original NOI-bridge string so
   *  existing NOI consumers are unchanged; other bridges (e.g. rent) pass their own. */
  ariaLabel?: string;
  /** Visible <title> announced alongside ariaLabel. Defaults to the original NOI-bridge string. */
  title?: string;
}

const colorFor = (kind: WaterfallBarKind): string =>
  kind === 'pos' ? 'var(--color-pos)' : kind === 'neg' ? 'var(--color-neg)' : 'var(--accent)';

/** ΔNOI bridge: full-height start/end totals + signed driver bars. SVG, theme tokens only. */
export function Waterfall({
  startValue,
  drivers,
  endValue,
  height = 260,
  startLabel,
  endLabel,
  ariaLabel = 'NOI driver waterfall',
  title = 'ΔNOI driver bridge',
}: Props) {
  const gid = useId().replace(/:/g, '');

  // Sparse-data guard (pre-mortem #2): with no drivers there is no bridge to draw.
  if (drivers.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-center"
        style={{ height, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
      >
        Needs 2 periods to bridge ΔNOI
      </div>
    );
  }

  const bars = waterfallBars(startValue, drivers, endValue);
  if (startLabel) bars[0]!.label = startLabel;
  if (endLabel) bars[bars.length - 1]!.label = endLabel;

  const margin = { top: 24, right: 8, bottom: 44, left: 8 };
  const width = Math.max(360, bars.length * 84);
  const iw = width - margin.left - margin.right;
  const ih = height - margin.top - margin.bottom;

  // Value-domain spans every bar edge (and 0 so totals are grounded). Linear, no animation
  // beyond CSS — keeps the chunk lean and respects reduced-motion by default.
  const lo = Math.min(0, ...bars.map((b) => b.base));
  const hi = Math.max(...bars.map((b) => b.top), 1);
  const span = hi - lo || 1;
  const yOf = (v: number): number => margin.top + ih - ((v - lo) / span) * ih;

  const slot = iw / bars.length;
  const barW = Math.min(56, slot * 0.62);

  return (
    <svg width={width} height={height} role="img" aria-label={ariaLabel} style={{ maxWidth: '100%' }}>
      <title id={`wf-${gid}`}>{title}</title>
      {bars.map((b, i) => {
        const cx = margin.left + slot * i + slot / 2;
        const x = cx - barW / 2;
        const yTop = yOf(b.top);
        const yBase = yOf(b.base);
        const h = Math.max(1, yBase - yTop);
        const fill = colorFor(b.kind);
        const labelText = b.kind === 'total' ? fmtUsd(b.value) : `${b.value >= 0 ? '+' : '−'}${fmtUsd(Math.abs(b.value))}`;
        const labelDisplay = b.label.length > 12 ? `${b.label.slice(0, 11)}…` : b.label;
        return (
          <g key={`${b.label}-${i}`}>
            {/* Full category name — the x-axis label below truncates past 12 chars, so this
                keeps any future long category (or a longer future label than today's two
                Rolling off / Re-leased forecast-bridge drivers) readable on hover (I-4). */}
            <title>{b.label}</title>
            <rect x={x} y={yTop} width={barW} height={h} rx={3} fill={fill} fillOpacity={b.kind === 'total' ? 0.95 : 0.82} />
            {/* signed value label above the bar's top edge */}
            <text
              x={cx}
              y={yTop - 6}
              textAnchor="middle"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, fill: 'var(--text-secondary)' }}
            >
              {labelText}
            </text>
            {/* category / total x-axis label */}
            <text x={cx} y={height - margin.bottom + 16} textAnchor="middle" style={{ ...AXIS_TICK }}>
              {labelDisplay}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
