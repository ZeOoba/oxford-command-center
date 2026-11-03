// src/charts/series-provenance.ts
//
// Where each point of a trend series came from (roadmap 3.3), so a chart can draw the difference
// instead of leaving it to a badge: recorded snapshots (solid), months reconstructed from today's
// leases (dotted), and forward months of contractual roll-off (dashed). One vocabulary for every
// trend card; the legend and the line styles both read from here.

export type Provenance = 'recorded' | 'reconstructed' | 'forecast';

export const PROVENANCE_ORDER: readonly Provenance[] = ['recorded', 'reconstructed', 'forecast'];

export const PROVENANCE_LABEL: Readonly<Record<Provenance, string>> = {
  recorded: 'Recorded',
  reconstructed: 'Reconstructed (current leases)',
  forecast: 'Contractual roll-off',
};

/** SVG stroke-dasharray per provenance (undefined = solid). */
export const PROVENANCE_DASH: Readonly<Record<Provenance, string | undefined>> = {
  recorded: undefined,
  reconstructed: '1.5 4',
  forecast: '6 4',
};

export interface ProvenanceRun {
  kind: Provenance;
  /** Inclusive point indexes. A run after the first starts at the previous run's last point, so the
   *  drawn segments join without a gap; the joining segment takes the later run's style. */
  from: number;
  to: number;
}

export function provenanceRuns(kinds: readonly Provenance[]): ProvenanceRun[] {
  const runs: ProvenanceRun[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]!;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.to = i;
    else runs.push({ kind, from: last ? i - 1 : i, to: i });
  }
  return runs;
}

/** The kinds present in a series, in legend order. */
export function provenanceKinds(kinds: readonly Provenance[]): Provenance[] {
  const present = new Set(kinds);
  return PROVENANCE_ORDER.filter((k) => present.has(k));
}

/** A scenario spread around forward months: the range between two named, deterministic scenarios.
 *  It is never a probability or confidence interval, and its label must say which scenarios bound it. */
export interface SpreadPoint {
  lo: number;
  hi: number;
}
