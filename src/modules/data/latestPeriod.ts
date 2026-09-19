import type { NoiMatrixCell } from '../intel/hooks';

/** The maximum period label across the matrix (string-sortable: YYYY / YYYY-MM). */
export function latestPeriod(matrix: NoiMatrixCell[]): string | null {
  let max: string | null = null;
  for (const c of matrix) {
    if (max === null || c.period.localeCompare(max) > 0) max = c.period;
  }
  return max;
}
