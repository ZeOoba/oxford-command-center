/** Chart palette drawn from the design tokens — series colors stay on-brand. */
export const SERIES = [
  'var(--accent)',
  'var(--color-info)',
  'var(--color-pos)',
  'var(--color-accent2)',
  'var(--color-gold-300, #e6d3a3)',
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

export const GRID_STROKE = 'var(--grid-line)';
