// Signal discipline — the one ordering every ranked surface shares (pure; no React).
//
// Order: pinned rows first (safety items such as lapsed coverage have no honest dollar figure and
// must never be out-ranked by money), then annualized dollars descending, then fewer days-to-act.
// Unquantified rows (null/undefined) sort after every quantified row — never treated as $0. Full
// ties keep input order. Confidence is deliberately not a factor: no row carries a sourced value.

export interface ImpactRankable {
  /** Annualized dollars at stake; null/undefined = not quantified. */
  impactUsd?: number | null;
  /** Rows that must stay on top regardless of dollars. */
  pinned?: boolean;
  /** Days until action is due; null/undefined = unknown (sorts after known urgency on a dollar tie). */
  daysToAct?: number | null;
}

const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** Comparator: negative when `a` ranks before `b`. 0 means a full tie (callers fall back to input order). */
export function compareByImpact(a: ImpactRankable, b: ImpactRankable): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const aq = isNum(a.impactUsd);
  const bq = isNum(b.impactUsd);
  if (aq !== bq) return aq ? -1 : 1;
  if (aq && bq && a.impactUsd !== b.impactUsd) return (b.impactUsd as number) - (a.impactUsd as number);
  const ad = isNum(a.daysToAct);
  const bd = isNum(b.daysToAct);
  if (ad !== bd) return ad ? -1 : 1;
  if (ad && bd && a.daysToAct !== b.daysToAct) return (a.daysToAct as number) - (b.daysToAct as number);
  return 0;
}

/** Stable, non-mutating rank. */
export function rankByImpact<T extends ImpactRankable>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => compareByImpact(x.row, y.row) || x.index - y.index)
    .map(({ row }) => row);
}
