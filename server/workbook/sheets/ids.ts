// server/workbook/sheets/ids.ts
//
// Master Workbook parser: duplicate property / lease id disambiguation. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type { DataQualityFlag } from '../../../src/contracts/index';

/**
 * Property.id is `slug(name)` (parse.ts), and it is the join key for every downstream
 * consumer — capital-allocation, debt-scoring, the warehouse crosswalk, overlay note keys.
 * Two property rows whose names slug to the same string (apostrophe/accent/whitespace
 * variants, or a genuine repeat address) would otherwise emit duplicate ids, silently
 * shadowing one property in any Map/Set keyed by id. This disambiguates in parse order:
 * the first occurrence keeps the base id; each later collision gets the next free
 * `<base>-N` (N starts at 2), skipping any suffix a real property already legitimately owns.
 * Mutates `items` in place (parse order preserved) and returns it. Each rename is surfaced
 * as a DataQualityFlag rather than applied silently.
 */
export function disambiguatePropertyIds<T extends { id: string; name: string }>(
  items: T[],
  flags: DataQualityFlag[],
): T[] {
  const taken = new Set<string>();
  for (const item of items) {
    if (!taken.has(item.id)) {
      taken.add(item.id);
      continue;
    }
    const base = item.id;
    let n = 2;
    let candidate = `${base}-${n}`;
    while (taken.has(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    flags.push({
      entity: candidate,
      field: 'id',
      issue: `property id collision on "${base}" (name "${item.name}") — disambiguated to "${candidate}"`,
      rawValue: base,
      severity: 'warn',
    });
    item.id = candidate;
    taken.add(candidate);
  }
  return items;
}

/**
 * Lease.id twin of disambiguatePropertyIds above — same collision-in-parse-order semantics,
 * described via tenant identity instead of a property `name`. Deliberately NOT a shared
 * generalization of disambiguatePropertyIds: keeping them independent means this fix cannot
 * perturb the already-shipped, already-tested property-id path.
 *
 * Suffix assignment WITHIN a collision group (2+ items sharing the same natural/pre-disambiguation
 * id) is decided by a deterministic property of the LEASE CONTENT — leaseEnd asc, then leaseStart
 * asc, then monthlyRent asc, then annualRent asc, then sf asc (nulls/undefined sort last at every
 * step) — NOT by parse/array order (Defect J, round-2 REFUTE; annualRent/sf added round-3 REFUTE).
 * Two rows that share an IDENTICAL natural id (e.g. a tenant's expiring lease plus its own
 * already-executed renewal, both listed as separate rent-roll rows for the same suite) previously
 * had the bare base id assigned to whichever happened to parse first, so a worksheet re-sort (e.g.
 * by lease-end date) silently moved any overlay data (arrears, renewal stage, market rent) attached
 * to that id from one physical lease record to the other. Groups are themselves processed in a
 * canonical (sorted-by-base-id) order so the overall outcome — including which candidate suffixes
 * are still free for one group after another group has claimed some — is independent of the
 * original items[] array order, not just independent of order WITHIN a group.
 *
 * Round-3 REFUTE (HIGH): the original 3-field chain (leaseEnd/leaseStart/monthlyRent) was not a
 * TOTAL order — two rows that tie on all three (identical dates AND monthlyRent, but a different
 * `sf` or an `annualRent` read independently from a different workbook column that can diverge from
 * `monthlyRent * 12`) had nothing left to break the tie on, so the sort's stability silently fell
 * back to array (worksheet row) order for that residual case — reintroducing the exact instability
 * this function exists to eliminate, just one level further down the tie-break chain. Extending the
 * chain with annualRent then sf closes every realistic case; if items STILL tie after all five
 * fields, that is a genuine full content duplicate — array order remains the fallback there (there
 * is nothing else to break the tie on), but the emitted flag message says so explicitly instead of
 * claiming a "deterministic order" the code didn't actually deliver for that residual group.
 *
 * leaseEnd/leaseStart/monthlyRent/annualRent/sf are all OPTIONAL on the constraint (absent →
 * treated as null/tied) so a caller that doesn't carry lease-content fields (e.g. this file's own
 * unit tests) still type-checks and falls back to array order via the sort's stability, matching
 * pre-Defect-J behavior exactly.
 */
export function disambiguateLeaseIds<
  T extends {
    id: string;
    tenantName: string;
    company: string | null;
    leaseEnd?: string | null;
    leaseStart?: string | null;
    monthlyRent?: number | null;
    annualRent?: number | null;
    sf?: number | null;
  },
>(items: T[], flags: DataQualityFlag[]): T[] {
  // Every row's NATURAL id, computed up front -- a synthetic "-N" candidate below must never
  // claim one of these, or a colliding lease early in parse order could steal a not-yet-processed
  // lease's rightful id, flipping ownership under row reordering (the exact instability this
  // function exists to eliminate, reintroduced in the collision-adjacent id space).
  const allNaturalIds = new Set(items.map((i) => i.id));

  // Group items by their natural (pre-disambiguation) id -- collisions only exist within a group.
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const g = groups.get(item.id);
    if (g) g.push(item);
    else groups.set(item.id, [item]);
  }

  // (nullRank, comparable) -- absent/null sorts after any real value, matching "nulls last".
  const rank = (v: string | number | null | undefined): [number, string | number] =>
    v === null || v === undefined ? [1, ''] : [0, v];
  const compareRanked = (a: string | number | null | undefined, b: string | number | null | undefined): number => {
    const [aNull, aVal] = rank(a);
    const [bNull, bVal] = rank(b);
    if (aNull !== bNull) return aNull - bNull;
    if (aVal === bVal) return 0;
    return aVal < bVal ? -1 : 1;
  };
  // String form of `rank()`, used only to build a full-chain equality KEY (not a comparison) for
  // clustering fully-tied items -- see the fullKey usage below.
  const compareRankedKey = (v: string | number | null | undefined): string => {
    const [nullRank, val] = rank(v);
    return `${nullRank}:${val}`;
  };

  const taken = new Set<string>();
  // Canonical (alphabetical) base-id order -- makes the WHOLE function's output independent of the
  // original items[] order, not just order within one group (required for Invariant 5-style
  // determinism: distinct collision groups never fight over each other's candidate suffixes, but
  // processing them in a fixed order removes even that theoretical dependency).
  for (const base of [...groups.keys()].sort()) {
    const group = groups.get(base)!;
    if (group.length === 1) {
      taken.add(base); // no collision -- keeps its natural id untouched, exactly as before
      continue;
    }
    // Deterministic tie-break chain. Array.prototype.sort is stable, so when every ranked field
    // ties (e.g. this file's own tests, which don't set any of the five content fields), the
    // group's original relative (array) order decides -- identical to pre-Defect-J behavior.
    const sorted = [...group].sort(
      (a, b) =>
        compareRanked(a.leaseEnd, b.leaseEnd) ||
        compareRanked(a.leaseStart, b.leaseStart) ||
        compareRanked(a.monthlyRent, b.monthlyRent) ||
        compareRanked(a.annualRent, b.annualRent) ||
        compareRanked(a.sf, b.sf),
    );
    // Round-3 REFUTE (HIGH): the prior 3-field chain wasn't a TOTAL order over lease content -- two
    // rows tying on leaseEnd/leaseStart/monthlyRent (but differing sf, or an annualRent read
    // independently from a different workbook column that can diverge from monthlyRent * 12) had
    // nothing left to break the tie on, silently falling back to array/worksheet-row order for that
    // residual case -- exactly the instability this function exists to eliminate. The chain above now
    // also covers annualRent/sf; cluster items by whether the FULL 5-field key still ties (equal-key
    // items are always contiguous after this sort, since it's a total preorder on that key) so the
    // flag text below can say honestly whether the chain actually decided this item's position, or
    // whether it's a genuine full content duplicate that fell back to array order.
    const fullKey = (v: T): string =>
      [compareRankedKey(v.leaseEnd), compareRankedKey(v.leaseStart), compareRankedKey(v.monthlyRent), compareRankedKey(v.annualRent), compareRankedKey(v.sf)].join('|');
    const fullKeyCounts = new Map<string, number>();
    for (const item of sorted) {
      const k = fullKey(item);
      fullKeyCounts.set(k, (fullKeyCounts.get(k) ?? 0) + 1);
    }
    // First in the deterministic order keeps the bare base id (already equals it -- explicit for
    // clarity, since "first" is no longer necessarily items[0] within the group).
    taken.add(base);
    for (let i = 1; i < sorted.length; i++) {
      const item = sorted[i]!;
      let n = 2;
      let candidate = `${base}-${n}`;
      while (taken.has(candidate) || allNaturalIds.has(candidate)) {
        n += 1;
        candidate = `${base}-${n}`;
      }
      const clusterSize = fullKeyCounts.get(fullKey(item)) ?? 1;
      const issue =
        clusterSize > 1
          ? `lease id collision on "${base}" (tenant "${item.company ?? item.tenantName}") — disambiguated to "${candidate}" (tie-broken by leaseEnd/leaseStart/monthlyRent/annualRent/sf; ${clusterSize} members remained fully tied and were ordered by worksheet position — a true content duplicate)`
          : `lease id collision on "${base}" (tenant "${item.company ?? item.tenantName}") — disambiguated to "${candidate}" (deterministic order: leaseEnd asc, then leaseStart, then monthlyRent, then annualRent, then sf, nulls last)`;
      flags.push({
        entity: candidate,
        field: 'id',
        issue,
        rawValue: base,
        severity: 'warn',
      });
      item.id = candidate;
      taken.add(candidate);
    }
  }
  return items;
}
