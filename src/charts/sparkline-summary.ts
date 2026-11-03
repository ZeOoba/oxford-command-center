// src/charts/sparkline-summary.ts
//
// Text alternative for a Sparkline (roadmap 2.5). A sparkline is a trend cue with no axes, so its
// accessible name states what a sighted reader takes from it: the first and last values, how many
// points, and the direction. Pure so the wording is unit-tested without rendering.

export type SparkFormat = (n: number) => string;

const plain: SparkFormat = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * "NOI: $410K to $455K over 12 points, up 11.0%". The percent is omitted when the first value is 0
 * or the ends change sign (a percent across a sign flip is not meaningful); the direction word stays.
 * Fewer than two points, or any non-finite point (the chart itself cannot draw it), yields
 * "<label>: not enough data for a trend" rather than a summary over a silently shortened series.
 */
export function sparklineSummary(data: readonly number[], label: string, fmt: SparkFormat = plain): string {
  if (data.length < 2 || !data.every((v) => Number.isFinite(v))) return `${label}: not enough data for a trend`;
  const first = data[0]!;
  const last = data[data.length - 1]!;
  const ends = `${fmt(first)} to ${fmt(last)} over ${data.length} points`;
  if (last === first) return `${label}: ${ends}, flat`;
  const dir = last > first ? 'up' : 'down';
  const pctOk = first !== 0 && Math.sign(first) === Math.sign(last);
  const pct = pctOk ? ` ${Math.abs(((last - first) / Math.abs(first)) * 100).toFixed(1)}%` : '';
  return `${label}: ${ends}, ${dir}${pct}`;
}
