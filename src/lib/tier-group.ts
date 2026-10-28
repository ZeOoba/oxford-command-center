// Signal discipline — "group by cause before listing". Symptoms of one problem become one row
// (twelve expiring leases are one decision, not twelve), ranked by the dollars the group carries.
import type { TierItem } from '@/primitives/TierBoard';

/** A cause needs this many members before it is worth a row of its own. */
export const MIN_GROUP_SIZE = 3;

/** Underlying signals a row stands for (a rolled-up row stands for all of its members). */
export function signalCount(item: TierItem): number {
  return item.members ? item.members.length : 1;
}

export type DescribeCause = (cause: string, members: TierItem[]) => { title: string; detail?: string };

function sumUsd(items: TierItem[]): number | null {
  let total = 0;
  let any = false;
  for (const i of items) {
    if (i.impactUsd === null || i.impactUsd === undefined) continue;
    total += i.impactUsd;
    any = true;
  }
  return any ? total : null; // no quantified member -> stays unquantified, never $0
}

/** The text after the em dash in "Expiring, no renewal signal — Tenant", else the whole title. */
function subject(title: string): string {
  const i = title.indexOf(' — ');
  return i === -1 ? title : title.slice(i + 3);
}

/** "A, B, C +5 more" from the members' subjects (members are already in rank order). */
export function previewSubjects(members: TierItem[], take = 3): string {
  const names = members.slice(0, take).map((m) => subject(m.title));
  const rest = members.length - names.length;
  return rest > 0 ? `${names.join(', ')} +${rest} more` : names.join(', ');
}

/**
 * Roll items that share a `cause` (and number at least `minSize`) into a single row, then rank the
 * result: pinned rows first, then by annualized dollars — unquantified rows last, ties and nulls in
 * their original order.
 * Items with no cause, or whose cause is below `minSize`, pass through unchanged.
 * `scope` (e.g. a severity) namespaces the synthetic group id, so one cause grouped separately in two
 * scopes never yields two rows with the same id.
 */
export function groupByCause(
  items: TierItem[],
  describe: DescribeCause,
  minSize = MIN_GROUP_SIZE,
  scope?: string,
): TierItem[] {
  const byCause = new Map<string, TierItem[]>();
  for (const item of items) {
    if (!item.cause) continue;
    byCause.set(item.cause, [...(byCause.get(item.cause) ?? []), item]);
  }

  const emitted = new Set<string>();
  const rows: TierItem[] = [];
  for (const item of items) {
    const members = item.cause ? byCause.get(item.cause) : undefined;
    if (!item.cause || !members || members.length < minSize) {
      rows.push(item);
      continue;
    }
    if (emitted.has(item.cause)) continue;
    emitted.add(item.cause);
    const text = describe(item.cause, members);
    rows.push({
      id: `group:${scope ? `${scope}:` : ''}${item.cause}`,
      category: item.category,
      categoryTone: item.categoryTone,
      impactKind: item.impactKind,
      impactUsd: sumUsd(members),
      title: text.title,
      detail: text.detail ?? previewSubjects(members),
      chips: item.chips,
      cause: item.cause,
      members,
      pinned: members.some((m) => m.pinned) || undefined,
    });
  }

  return rankRows(rows);
}

/**
 * Rank already-built rows without regrouping them: pinned first, then dollars descending,
 * unquantified last, ties and nulls in their original order. For callers that group per scope and
 * then merge the scopes into one list (a second `groupByCause` would re-fold the scopes together).
 */
export function rankRows(rows: TierItem[]): TierItem[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (!!a.row.pinned !== !!b.row.pinned) return a.row.pinned ? -1 : 1;
      const av = a.row.impactUsd;
      const bv = b.row.impactUsd;
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;
      if (aNull && bNull) return a.index - b.index;
      if (aNull) return 1;
      if (bNull) return -1;
      return bv - av || a.index - b.index;
    })
    .map(({ row }, i) => ({ ...row, rank: i + 1 }));
}
