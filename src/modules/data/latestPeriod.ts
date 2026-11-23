import type { NoiMatrixCell } from '../intel/hooks';

/** The maximum period label across the matrix (string-sortable: YYYY / YYYY-MM). */
export function latestPeriod(matrix: NoiMatrixCell[]): string | null {
  let max: string | null = null;
  for (const c of matrix) {
    if (max === null || c.period.localeCompare(max) > 0) max = c.period;
  }
  return max;
}

export interface LedgerCoverage {
  label: string;
  detail: string | null;
}

type CoverageRow = {
  status: string;
  grain: string | null;
  propertyId?: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};

const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A strict YYYY-MM-DD prefix that parses, else null (a header typo must not crash the Data page). */
function isoDay(v: string | null): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = v.slice(0, 10);
  return Number.isFinite(Date.parse(`${d}T00:00:00Z`)) ? d : null;
}

/**
 * How far the committed P&L ledger actually runs (2026-11-23 review). A bare "2026" read as a full
 * year when the 2026 files are year-to-date cuts that stop at mid-year.
 *
 * Ruled PER PROPERTY, across EVERY property with a committed batch (refute round 2: a property whose
 * newest batch is from an earlier year is exactly the lag this label exists to show). For each
 * property, in its own newest year: a committed full-year batch means complete through Dec 31; else
 * its latest dated YTD cut; an undated YTD batch makes the property undated (metrics.ts treats a null
 * period end as the most recent, so the older dated cut would not be what it serves). The label is
 * the EARLIEST cut-off across properties: the date the whole portfolio is loaded through. Some
 * QuickBooks headers state a full-year period on a mid-year YTD report, so a cut-off is an upper
 * bound for such a property, not a guarantee.
 */
export function ledgerCoverage(imports: readonly CoverageRow[]): LedgerCoverage | null {
  const committed = imports.filter((i) => i.status === 'committed');
  const yearOf = (i: CoverageRow) => (isoDay(i.periodStart) ?? isoDay(i.periodEnd) ?? '').slice(0, 4);
  const byProperty = new Map<string, CoverageRow[]>();
  committed.forEach((i, n) => {
    if (!yearOf(i)) return;
    const key = i.propertyId ?? `unattributed-${n}`;
    byProperty.set(key, [...(byProperty.get(key) ?? []), i]);
  });
  if (byProperty.size === 0) return null;
  const cutoffs: string[] = [];
  let undated = 0;
  for (const all of byProperty.values()) {
    let year = '';
    for (const r of all) if (yearOf(r) > year) year = yearOf(r);
    const rows = all.filter((r) => yearOf(r) === year);
    if (rows.some((r) => r.grain !== 'ytd')) {
      cutoffs.push(`${year}-12-31`);
      continue;
    }
    const ends = rows.map((r) => isoDay(r.periodEnd));
    if (ends.some((e) => e === null)) {
      undated += 1;
      continue;
    }
    cutoffs.push((ends as string[]).sort()[ends.length - 1]!);
  }
  const total = byProperty.size;
  if (cutoffs.length === 0) return { label: 'YTD', detail: `cut-off not dated for ${undated} of ${total}` };
  cutoffs.sort();
  const first = cutoffs[0]!;
  const latestYear = cutoffs[cutoffs.length - 1]!.slice(0, 4);
  const day = new Date(`${first}T00:00:00Z`);
  // The label is the KPI value (large font, narrow tile), so it stays a short date; the year and
  // basis go in `detail` (2026-11-23: "2026 YTD thru Jun 12" wrapped to four lines on the live page).
  const complete = first.slice(5) === '12-31' && cutoffs.every((c) => c === first);
  const ytd = !complete && first.slice(0, 4) === latestYear;
  const label = complete ? first.slice(0, 4) : ytd ? MONTH_DAY.format(day) : `${MONTH_DAY.format(day)}, ${first.slice(0, 4)}`;
  const behind = cutoffs.filter((c) => c.slice(0, 4) < latestYear).length;
  const parts: string[] = [];
  if (ytd) parts.push(`${latestYear} YTD`);
  if (!complete) parts.push('earliest property cut-off');
  if (behind > 0) parts.push(`${behind} of ${total} not loaded for ${latestYear}`);
  if (undated > 0) parts.push(`${undated} of ${total} undated`);
  return { label, detail: parts.length > 0 ? parts.join(' · ') : null };
}
