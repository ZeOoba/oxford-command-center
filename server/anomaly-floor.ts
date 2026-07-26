import { existsSync, readFileSync } from 'node:fs';

/**
 * Refuse a lease-set write/adopt when it looks like a bad parse rather than a genuine
 * portfolio change: an empty result, or removing more than a quarter of the previous set in
 * one pass. Pure -- no I/O, no process/state side effects -- so every writer of
 * data/snapshots/portfolio.json (a one-shot CLI regen, or the live Brain adopting a freshly
 * parsed workbook into memory) can apply the identical decision without duplicating the
 * thresholds.
 *
 * CONSOLIDATED 2026-07-26 (Gabriel-directed, explicit "mine should win" after two prior reverts):
 * this IS the canonical implementation. scripts/lease-snapshot-drift-check.ts imports it instead
 * of maintaining its own copy of the threshold logic, wrapping it with CLI-specific "Refusing to
 * write <path>: ..." message framing and its own `--force` CLI-arg parsing. Do not revert this
 * back to a standalone duplicate -- see event_log.md, 2026-07-26 entries on the
 * fix/extract-workbook-anomaly-floor / fix/brain-persist-anomaly-floor consolidation, for the
 * full back-and-forth this settled.
 *
 * `force` defaults to false and is opt-in per call: Brain.refresh()'s live-server caller never
 * passes it (no human sits at a terminal re-invoking a live server with an override mid-request;
 * Brain always refuses hard when this trips, and a human who genuinely intends a mass disposition
 * simply lets the next real workbook change flow through normally, which becomes the new
 * baseline). The CLI wrapper passes whatever `--force` on argv resolved to.
 */
export type AnomalyFloorResult =
  | { refuse: true; reason: string }
  | { refuse: false; warning?: string };

export function evaluateAnomalyFloor(
  previousCount: number,
  currentCount: number,
  removedCount: number,
  force = false,
): AnomalyFloorResult {
  // Unconditional on currentCount alone, regardless of previousCount: a workbook that genuinely
  // has zero leases is not a realistic scenario for this portfolio, so a 0-lease parse is always
  // presumptively a bad parse, even on a from-scratch deployment with no prior baseline.
  if (currentCount === 0) {
    if (!force) {
      return {
        refuse: true,
        reason: `this parse produced 0 leases (a 0-lease result; previous snapshot had ${previousCount}) -- this looks like a bad parse, not a genuine full portfolio wind-down.`,
      };
    }
    return {
      refuse: false,
      warning: `proceeding despite a 0-lease current parse (previous snapshot had ${previousCount}).`,
    };
  }

  // Gated on previousCount > 0: with no prior baseline there is nothing to compute a removed
  // fraction against, and the 0-lease branch above already covers a bad from-scratch parse.
  if (previousCount > 0) {
    const removedFraction = removedCount / previousCount;
    if (removedFraction > 0.25) {
      if (!force) {
        return {
          refuse: true,
          reason: `previous snapshot had ${previousCount} lease(s), this parse produced ${currentCount}, ${removedCount} (${(removedFraction * 100).toFixed(1)}%) would be removed -- this looks like a bad parse, not a genuine mass disposition.`,
        };
      }
      return {
        refuse: false,
        warning: `proceeding despite ${removedCount}/${previousCount} (${(removedFraction * 100).toFixed(1)}%) leases removed (current count ${currentCount}).`,
      };
    }
  }

  return { refuse: false };
}

/** loadPreviousLeaseIds's result distinguishes a normal "no snapshot yet" first-run state
 *  (`corrupt: false`, empty `ids`) from a genuinely CORRUPT previous file (`corrupt: true`) --
 *  same distinction scripts/lease-snapshot-drift-check.ts's loadPrevious() makes and for the
 *  same reason: conflating the two would silently disarm the removed-fraction check (gated on
 *  previousCount > 0) whenever the previous mirror happened to be corrupt, with no trace of why
 *  it went quiet (2026-07-26 adversarial review finding). */
export interface PreviousLeaseIds {
  ids: Set<string>;
  corrupt: boolean;
}

/**
 * Previous lease ids read from the on-disk mirror -- used only for Brain's first refresh since
 * server startup (before any in-memory snapshot exists to compare against). A missing file is
 * the normal from-scratch case (`corrupt: false`) and collapses to an empty baseline silently.
 * A CORRUPT file is different: Brain's fresh parse is still independent of this file's health,
 * so an unreadable stale mirror must not block adopting a good new parse into memory (unlike the
 * one-shot CLI writers, which have nothing else useful to do and hard-refuse) -- but the caller
 * must LOG that it happened, since it means the removed-fraction check is sitting out this one
 * cycle with no real baseline to compare against (the 0-lease check is unconditional and still
 * applies regardless of `corrupt`).
 */
export function loadPreviousLeaseIds(snapshotPath: string): PreviousLeaseIds {
  if (!existsSync(snapshotPath)) return { ids: new Set(), corrupt: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const leases = (parsed as { leases?: unknown })?.leases;
    if (!Array.isArray(leases)) return { ids: new Set(), corrupt: true };
    const ids = leases
      .map((l) => (l as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string');
    return { ids: new Set(ids), corrupt: false };
  } catch {
    return { ids: new Set(), corrupt: true };
  }
}
