/** Chart palette drawn from the design tokens — series colors stay on-brand. */
export const SERIES = [
  'var(--accent)',
  'var(--color-info)',
  'var(--color-pos)',
  'var(--color-accent2)',
  'var(--color-warn)',
  'var(--text-tertiary)',
] as const;

export function colorAt(i: number): string {
  return SERIES[i % SERIES.length]!;
}

export const AXIS_TICK = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fill: 'var(--text-tertiary)',
} as const;

// Axis TITLE text (e.g. ScatterChart's xLabel/yLabel) — same font/size as AXIS_TICK, but the
// brighter text-secondary fill so a label reads as more prominent than its own ticks. Without an
// explicit fill, visx's Axis label falls back to a hardcoded #222 Arial, invisible on the dark
// 'command' surface (2026-09-23 review, I-1).
export const AXIS_LABEL = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fill: 'var(--text-secondary)',
} as const;

export const GRID_STROKE = 'var(--grid-line)';
