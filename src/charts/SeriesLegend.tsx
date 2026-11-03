// src/charts/SeriesLegend.tsx — the recorded / reconstructed / roll-off legend for a trend card, plus
// the scenario-spread swatch when the chart draws one (roadmap 3.3). Swatches mirror the chart's own
// strokes, and every item carries text, so the distinction never rests on line style alone.
import { PROVENANCE_DASH, PROVENANCE_LABEL, type Provenance } from './series-provenance';

interface Props {
  kinds: readonly Provenance[];
  color?: string;
  /** Names the two scenarios bounding the band. Omit when the chart draws no band. */
  bandLabel?: string;
}

export function SeriesLegend({ kinds, color = 'var(--color-pos)', bandLabel }: Props) {
  if (kinds.length === 0 && !bandLabel) return null;
  return (
    <ul className="num flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs" style={{ color: 'var(--text-tertiary)' }} aria-label="Chart legend">
      {kinds.map((k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <svg width={22} height={8} aria-hidden="true">
            <line x1={1} x2={21} y1={4} y2={4} stroke={color} strokeWidth={2} strokeDasharray={PROVENANCE_DASH[k]} strokeLinecap="round" />
          </svg>
          {PROVENANCE_LABEL[k]}
        </li>
      ))}
      {bandLabel && (
        <li className="inline-flex items-center gap-1.5">
          <svg width={22} height={10} aria-hidden="true">
            <rect x={1} y={1} width={20} height={8} rx={2} fill={color} fillOpacity={0.16} />
          </svg>
          {bandLabel}
        </li>
      )}
    </ul>
  );
}
