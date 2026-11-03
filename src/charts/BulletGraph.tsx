// src/charts/BulletGraph.tsx
//
// Horizontal bullet graph (Few, Bullet Graph Design Specification): grey qualitative bands, a thin
// featured-measure bar and a perpendicular comparative marker at the governor. Two bands only — the
// breach side of the governor in the darker grey, the compliant side in the lighter one — because a
// governor is a single boundary, not a graded scale. Colour is reserved for the abnormal state: the
// featured bar is neutral grey until `state` says otherwise.
//
// An optional secondary tick (e.g. the weakest property's DSCR) sits under the bar. The svg is
// role="img" and its accessible name is the caller's text summary (roadmap 2.5 rule: no chart
// without a text alternative).

export type BulletState = 'ok' | 'watch' | 'breach';

interface Props {
  /** Featured measure; null draws the bands and the marker only. */
  value: number | null;
  /** The governor (comparative measure). */
  target: number;
  /** 'floor' = values below target breach (DSCR, cash); 'ceiling' = values above breach (LTV). */
  kind: 'floor' | 'ceiling';
  /** Upper end of the scale (the lower end is 0). Values beyond it are clamped to the edge. */
  max: number;
  state: BulletState;
  /** Accessible text alternative — the svg's name. */
  summary: string;
  secondary?: number | null;
  height?: number;
}

const BAR_FILL: Record<BulletState, string> = {
  ok: 'var(--text-secondary)',
  watch: 'var(--text-secondary)',
  breach: 'var(--color-neg)',
};

export function BulletGraph({ value, target, kind, max, state, summary, secondary, height = 14 }: Props) {
  const span = max > 0 ? max : 1;
  const pct = (n: number) => Math.max(0, Math.min(100, (n / span) * 100));
  const t = pct(target);
  const breachBand = kind === 'floor' ? { x: 0, w: t } : { x: t, w: 100 - t };
  return (
    <svg
      role="img"
      aria-label={summary}
      width="100%"
      height={height}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      style={{ display: 'block' }}
    >
      <rect x={0} y={0} width={100} height={height} fill="var(--border-subtle)" />
      <rect x={breachBand.x} y={0} width={breachBand.w} height={height} fill="var(--border-strong)" />
      {value !== null && (
        <rect x={0} y={height * 0.3} width={pct(value)} height={height * 0.4} fill={BAR_FILL[state]} />
      )}
      {secondary != null && Number.isFinite(secondary) && (
        <line
          x1={pct(secondary)} x2={pct(secondary)} y1={height * 0.78} y2={height}
          stroke={state === 'ok' ? 'var(--text-tertiary)' : 'var(--color-warn)'}
          strokeWidth={2} vectorEffect="non-scaling-stroke"
        />
      )}
      <line x1={t} x2={t} y1={height * 0.1} y2={height * 0.9} stroke="var(--text-primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
