// scripts/lease-snapshot-drift-check.ts
//
// Regenerates data/snapshots/portfolio.json from the live workbook (same as `npm run extract`),
// then diffs the NEW lease set against what was there immediately before, reporting any lease
// whose id, leaseEnd, or (to/from $0 or >25%) annualRent changed. Run on a schedule so
// portfolio.json never goes stale for longer than the schedule's own interval, independent of
// whether the interactive dev/prod server is
// running (which is the actual root cause of the staleness this script exists to close --
// see docs/superpowers/plans/2026-07-24-lease-id-integrity-fix-plan.md).
//
// Exit codes: 0 = ran clean, no drift. 1 = refused to write (anomaly floor tripped, corrupt
// overlay/previous-snapshot, or force-eligible refusal) -- portfolio.json is UNCHANGED. 2 = ran,
// wrote portfolio.json, and found drift worth a look. 3 = unexpected error/crash (main() threw) --
// distinguished from 1 so an unattended scheduler can tell "correctly refused, nothing touched"
// apart from "crashed before doing anything useful" using the exit code alone (Round-3 REFUTE).
//
// Usage: npx tsx scripts/lease-snapshot-drift-check.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LeaseStatus, PortfolioSnapshot } from '../src/contracts/index';
import { parseWorkbook } from '../server/workbook/parse';
import type { M365TasksDegradation } from '../server/sources/m365-tasks';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, SNAPSHOT_PATH } from '../server/config';
import { renameSyncWithRetry } from '../server/lib/rename-retry';
import { loadOverlay, applyOverlay, overlayPath, evaluateOverlayPrecondition } from '../server/overlay';
import { evaluateAnomalyFloor as evaluateAnomalyFloorCore } from '../server/anomaly-floor';
import { checkSnapshot } from '../server/reconcile-runtime';
import { resolveQuickbooks } from '../server/sources/quickbooks';

loadEnvFile();

/** Local view of the fields this drift check compares -- named distinctly from
 *  server/ar/match-tenant.ts's own LeaseLite (different shape) to avoid a same-name mixup.
 *  `propertyKey`/`unit` are here for the business-key pairing below, not the id diff. */
export interface DriftLeaseView {
  id: string;
  propertyKey: string;
  tenantName: string;
  company: string | null;
  unit: string | null;
  leaseEnd: string | null;
  annualRent: number;
  /** Vacancy context for the rent-change report (2026-09-07 incident, see RENT_CHANGE_MATERIAL_FRACTION).
   *  The Lease contract carries no explicit notice-to-vacate field, so status + leaseEnd +
   *  monthsToExpiry are all the context a reader gets alongside a rent move. */
  status: LeaseStatus;
  monthsToExpiry: number | null;
}

/** A previous lease and a current lease that are the same real-world tenancy under different ids. */
export interface RekeyedLease {
  key: string;
  previous: DriftLeaseView;
  current: DriftLeaseView;
  leaseEndChanged: boolean;
}

/** A business key that maps to more than one lease on either side -- reported, never paired. */
export interface AmbiguousKey { key: string; previousCount: number; currentCount: number; }

/**
 * Materiality for the rentChanged bucket: a retained lease's annualRent moving by MORE than this
 * fraction of its previous value is reported; at or under it is not. 25% deliberately mirrors the
 * anomaly floor's >25%-removed threshold (server/anomaly-floor.ts) rather than inventing a second
 * number: a routine 2-4% escalation or a modest renewal bump never trips it, a halving/doubling
 * does. A move to or from exactly $0 is ALWAYS reported regardless of this fraction -- that is the
 * incident shape, and $0 has no meaningful relative size.
 */
export const RENT_CHANGE_MATERIAL_FRACTION = 0.25;

export type RentChangeKind = 'to-zero' | 'from-zero' | 'material';

/** A retained tenancy (id-matched, or paired across a re-key) whose annualRent moved -- see rentChangeKind. */
export interface RentChange {
  previous: DriftLeaseView;
  current: DriftLeaseView;
  kind: RentChangeKind;
}

export interface DriftResult {
  /** Raw id-level diff. `removedIds` is what the anomaly floor is computed from -- see main(). */
  newIds: DriftLeaseView[];
  removedIds: DriftLeaseView[];
  /** leaseEnd changes on leases whose id did NOT change (pre-existing behavior, unchanged). */
  changedDates: DriftLeaseView[];
  /** id-unmatched leases paired across the id change by business key. */
  rekeyed: RekeyedLease[];
  genuinelyNew: DriftLeaseView[];
  genuinelyRemoved: DriftLeaseView[];
  ambiguous: AmbiguousKey[];
  /** annualRent moves on RETAINED tenancies (id-matched AND re-keyed pairs) -- to/from $0, or by
   *  more than RENT_CHANGE_MATERIAL_FRACTION. Report-only, like changedDates: never a refusal input. */
  rentChanged: RentChange[];
}

/**
 * Why a retained lease's rent move is reportable, or null when it is not.
 *
 * Added 2026-09-14 (weekly financial-code sweep) for the 2026-09-07 refresh (commit 85dfecf) in
 * which three RETAINED lease ids went from real rent to annualRent 0 -- two already 'Expired', one
 * still 'Active' with four months of term -- and no report anywhere carried a line about it. Every
 * existing guard was structurally blind to that shape: the count floor saw nothing added or removed,
 * the leaseEnd bucket saw no date move, and evaluateReconciliationGate's Σannual-vs-workbook-total
 * check PASSED because the workbook itself had zeroed the cells, so parsed and declared totals still
 * agreed. This bucket is the value-level companion to changedDates, and like it, it only reports:
 * a genuine vacancy zeroes rent too, and refusing would block real, wanted edits.
 */
export function rentChangeKind(previous: DriftLeaseView, current: DriftLeaseView): RentChangeKind | null {
  const prev = previous.annualRent;
  const cur = current.annualRent;
  if (prev === cur) return null;
  if (cur === 0) return 'to-zero';
  if (prev === 0) return 'from-zero';
  return Math.abs(cur - prev) / Math.abs(prev) > RENT_CHANGE_MATERIAL_FRACTION ? 'material' : null;
}

/** Trim, collapse internal runs of whitespace, lowercase. Keeps cosmetic workbook edits
 *  ("Acme  LLC" -> "Acme LLC") from reading as a different tenancy. */
function normalize(s: string | null): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Identity of a tenancy independent of its generated id: property + unit + tenant.
 *
 * `propertyKey` (not `propertyId`) is the property component deliberately -- propertyKey is
 * non-nullable in the Lease contract (the raw rent-roll label), while `propertyId` is nullable
 * (only set when the property was matchable), so keying on propertyId would silently collapse
 * every unmatched-property lease into one key. `unit` IS nullable (single-tenant buildings carry
 * none) and contributes an empty component in that case, which is fine -- the tenant component
 * still separates them.
 *
 * Returns null when the tenant component is empty, i.e. the key cannot identify anything and must
 * never be used to pair.
 */
export function businessKey(lease: DriftLeaseView): string | null {
  const tenant = normalize(lease.company) || normalize(lease.tenantName);
  if (!tenant) return null;
  return `${normalize(lease.propertyKey)} | ${normalize(lease.unit)} | ${tenant}`;
}

function countKeys(leases: DriftLeaseView[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of leases) {
    const k = businessKey(l);
    if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Diff two lease sets by id, then pair whatever the id diff left unmatched by BUSINESS key.
 *
 * Why this exists (2026-07-24): PR #232 changed every lease id at once (row-position ->
 * tenant-identity). The id-only diff reported "137 removed / 138 new" and said nothing about the
 * five leases whose leaseEnd actually moved underneath that churn -- two of which had gone into
 * holdover on 2026-06-30 while the snapshot still showed 8-10 months of term. Pairing by business
 * key turns that report into "137 re-keyed (5 with date changes), 1 genuinely new, 0 removed".
 *
 * Pairing is deliberately conservative: a key is only used when it is unique across the FULL
 * previous set AND the FULL current set -- not merely unique among the unmatched leaves. A key
 * that is unique among unmatched leaves but duplicated in the full set could pair against a lease
 * that is already id-matched to something else, attaching one tenancy's history to another. That
 * is the same misattachment hazard that makes migrate-lease-overlay-ids.ts refuse prefix matches.
 */
export function computeDrift(previous: DriftLeaseView[], current: DriftLeaseView[]): DriftResult {
  const prevById = new Map(previous.map((l) => [l.id, l]));
  const currentIds = new Set(current.map((l) => l.id));

  const removedIds = previous.filter((l) => !currentIds.has(l.id));
  const newIds = current.filter((l) => !prevById.has(l.id));
  const changedDates = current.filter((l) => {
    const prev = prevById.get(l.id);
    return prev && prev.leaseEnd !== l.leaseEnd;
  });

  // Uniqueness counted over the FULL sets -- see the doc comment above for why not the unmatched subset.
  const prevKeyCounts = countKeys(previous);
  const currentKeyCounts = countKeys(current);

  const unmatchedPrevByKey = new Map<string, DriftLeaseView[]>();
  for (const l of removedIds) {
    const k = businessKey(l);
    if (k === null) continue;
    const bucket = unmatchedPrevByKey.get(k);
    if (bucket) bucket.push(l);
    else unmatchedPrevByKey.set(k, [l]);
  }

  const rekeyed: RekeyedLease[] = [];
  const ambiguousByKey = new Map<string, AmbiguousKey>();
  const pairedPrevIds = new Set<string>();
  const genuinelyNew: DriftLeaseView[] = [];

  for (const cur of newIds) {
    const k = businessKey(cur);
    if (k === null) {
      genuinelyNew.push(cur);
      continue;
    }
    const prevCount = prevKeyCounts.get(k) ?? 0;
    const currentCount = currentKeyCounts.get(k) ?? 0;
    if (prevCount > 1 || currentCount > 1) {
      // Ambiguous: report the key once, and let the lease fall through to the conservative reading.
      if (!ambiguousByKey.has(k)) ambiguousByKey.set(k, { key: k, previousCount: prevCount, currentCount });
      genuinelyNew.push(cur);
      continue;
    }
    const candidates = unmatchedPrevByKey.get(k);
    const prev = candidates?.[0];
    if (!prev) {
      genuinelyNew.push(cur);
      continue;
    }
    pairedPrevIds.add(prev.id);
    rekeyed.push({ key: k, previous: prev, current: cur, leaseEndChanged: prev.leaseEnd !== cur.leaseEnd });
  }

  const genuinelyRemoved = removedIds.filter((l) => !pairedPrevIds.has(l.id));

  // Rent moves on RETAINED tenancies: id-matched leases first, then the pairs the business-key
  // pass just established -- the same two populations the leaseEnd comparison covers (changedDates
  // + rekeyed[].leaseEndChanged), so a rent zero-out hidden under an id-scheme migration is seen
  // exactly as one under a stable id is. See rentChangeKind for the incident this closes.
  const rentChanged: RentChange[] = [];
  for (const cur of current) {
    const prev = prevById.get(cur.id);
    if (!prev) continue;
    const kind = rentChangeKind(prev, cur);
    if (kind) rentChanged.push({ previous: prev, current: cur, kind });
  }
  for (const r of rekeyed) {
    const kind = rentChangeKind(r.previous, r.current);
    if (kind) rentChanged.push({ previous: r.previous, current: r.current, kind });
  }

  return {
    newIds,
    removedIds,
    changedDates,
    rekeyed,
    genuinelyNew,
    genuinelyRemoved,
    ambiguous: [...ambiguousByKey.values()],
    rentChanged,
  };
}

/** loadPrevious's result distinguishes a normal "no snapshot yet" first-run state (`corrupt: false`,
 *  `leases: []`) from a genuinely CORRUPT previous file (`corrupt: true`) -- Round-3 REFUTE: these
 *  used to be conflated (both mapped to `[]`), which silently disarmed the anomaly-refusal floor
 *  below (gated on `previous.length > 0`) whenever the previous snapshot happened to be corrupt, and
 *  the newly (possibly bad) written snapshot became the new "previous" with its own small/zero
 *  count -- permanently disarming the floor going forward. Exported so extract-workbook.ts's raw
 *  regen path shares this exact corrupt-previous detection (2026-07-26 -- see evaluateAnomalyFloor
 *  below for why). `path` defaults to SNAPSHOT_PATH; overridable so this is unit-testable against a
 *  real temp file instead of the live snapshot path (2026-07-26 REFUTE finding -- this function had
 *  zero test coverage despite being where the corrupt-previous-snapshot refusal actually lives). */
export interface PreviousSnapshot { leases: DriftLeaseView[]; corrupt: boolean; }

export function loadPrevious(path: string = SNAPSHOT_PATH): PreviousSnapshot {
  if (!existsSync(path)) return { leases: [], corrupt: false }; // normal first-run state, not corruption
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed?.leases)) {
      console.error(`✗ ${path} parsed but has no "leases" array.`);
      return { leases: [], corrupt: true };
    }
    return { leases: parsed.leases, corrupt: false };
  } catch (err) {
    // A truncated/corrupt snapshot (a known OneDrive-sync hazard here) is a genuine corruption, not
    // an empty baseline -- see the main() handling below (refuses to write, leaving the corrupt file
    // exactly where it is).
    console.error(`✗ failed to parse ${path} (${(err as Error).message}).`);
    return { leases: [], corrupt: true };
  }
}

// Discriminated union (2026-07-26 REFUTE finding): the previous `{refuse: boolean; reason?: string;
// warning?: string}` shape let a `refuse: true` with no `reason` compile and print `✗ undefined` --
// both call sites interpolate `reason`/`warning` unconditionally. This makes that combination
// unrepresentable instead of merely unlikely.
export type AnomalyFloorResult =
  | { refuse: true; reason: string }
  | { refuse: false; warning?: string };

/**
 * Decides whether a lease-set write should be refused, given the previous set, the new set, and
 * the RAW id-level removedIds (not the business-key-paired `genuinelyRemoved` -- see
 * computeDrift's doc comment on why the floor must see the raw removal count). Pure: no I/O, no
 * process.exit -- the caller acts on the result.
 *
 * Extracted 2026-07-26 so this file (the protected weekday path) and scripts/extract-workbook.ts
 * (the raw regen / manual `npm run extract` path) share ONE tested refusal decision instead of two
 * copies that can drift apart -- see the 2026-07-26 orphaned-task-forensics finding in
 * event_log.md: a manual `npm run extract` run wrote corrupted lease-end dates for two Sepich
 * Portfolio tenants through extract-workbook.ts, which had no anomaly floor of its own at all.
 *
 * CONSOLIDATED FURTHER 2026-07-26 (Gabriel-directed, same day): the actual 0-lease / >25%-removed
 * threshold decision now lives in ../server/anomaly-floor.ts's evaluateAnomalyFloor -- the same
 * function server/brain.ts's Brain.refresh() calls to guard the live in-memory adoption path
 * (fix/brain-persist-anomaly-floor). This function is now a thin CLI-shaped wrapper: it converts
 * the DriftLeaseView-array inputs to plain counts, delegates the threshold decision, and wraps a
 * refusal in the "Refusing to write <path>: ..." operator-facing framing a CLI run needs (a live
 * server has no file path to report and no operator staring at stdout). All three writers of
 * portfolio.json now share ONE implementation of the actual thresholds instead of two/three
 * independently maintained copies that could drift apart from each other.
 */
export function evaluateAnomalyFloor(
  previous: DriftLeaseView[],
  current: DriftLeaseView[],
  removedIds: DriftLeaseView[],
  snapshotPath: string,
  force: boolean,
): AnomalyFloorResult {
  const core = evaluateAnomalyFloorCore(previous.length, current.length, removedIds.length, force);
  if (core.refuse) {
    const eventKind = current.length === 0 ? 'event' : 'mass-disposition event';
    return {
      refuse: true,
      reason: `Refusing to write ${snapshotPath}: ${core.reason} portfolio.json was NOT modified. Re-run with --force if this is a real, intentional ${eventKind}.`,
    };
  }
  if (core.warning) {
    return { refuse: false, warning: `--force: ${core.warning}` };
  }
  return { refuse: false };
}

/**
 * Dollar-exact reconciliation gate -- closes the anomaly floor's blind spot (2026-08-03 phantom-
 * lease incident, PR #250). The floor above is COUNT-based (0-lease / >25%-removed); it does
 * nothing when a bad parse only ADDS rows, which is exactly what happened when the rent roll's
 * derived "VACANCY & UPCOMING AVAILABILITY" block got ingested as 10 real leases -- nothing was
 * removed, so the floor saw no anomaly at all while annual rent was overstated by $REDACTED-AMT.
 *
 * `server/reconcile-runtime.ts`'s checkSnapshot() already ties parsed lease annualRent (and NOI,
 * property value, cash, and structural invariants) to the workbook's own declared totals -- it is
 * the check that WOULD have caught the incident, and did the moment `npm run reconcile` was run by
 * hand. It was simply never called from either CLI writer, only from server/brain.ts's live-server
 * refresh path (deliberately independent of server uptime -- see this file's header). This function
 * wires it in with the identical "Refusing to write <path>: ..." + --force framing as
 * evaluateAnomalyFloor above, so both writers share ONE tested gate rather than reimplementing the
 * decision twice.
 *
 * Gated on error-severity flags ONLY -- checkSnapshot also emits warn-severity notices (e.g. the
 * Σannual ≠ Σmonthly×12 self-consistency check) that are informational, not a reason to refuse an
 * otherwise-clean write; refusing on every warn would make this gate far too trigger-happy for
 * routine self-consistency noise. Deliberately does NOT reuse scripts/reconcile.ts's own lease-
 * count check, which hardcodes an expected count and would false-fail on the next genuine lease
 * signing -- see that script's own doc comment.
 *
 * Checks the UNION of checkSnapshot(snapshot)'s freshly-computed flags AND any error-severity flag
 * already sitting in snapshot.dataQuality. checkSnapshot() only recomputes its own 6 categories
 * (cash/rent-self-consistency/workbook-totals/empty-sets/dup-ids/dangling-edges) -- it does not
 * read snapshot.dataQuality at all, so a parse-time flag (raised inside parse.ts itself, e.g. the
 * unrecognised-dated-row flag PR #250 added) would be silently invisible to a gate that consulted
 * checkSnapshot() alone. Every parse.ts flag is 'warn'-severity today, so this has no live effect
 * yet -- but "refuse on any error-severity flag" (the design this suspension was lifted on) means
 * ANY source of one, not just the ones this function happens to compute itself.
 */
/**
 * Writer-only precondition (2026-08-09): an authoritative portfolio.json must be written from the
 * LIVE deals pipeline, never from the seed placeholder set.
 *
 * Why this is separate from the dataQuality flag loadDeals/parse.ts now raise: that flag covers the
 * cases where a token IS configured and the fetch fails, but it deliberately stays silent for
 * `not-configured`, because running the dev server without a NOTION_TOKEN is a supported mode and
 * flagging it would leave every credential-less dev session permanently "dirty". For a WRITER the
 * calculus is the opposite -- no token means the deals/counterparties sections get written from ~6
 * seed placeholders over a ~20-deal live pipeline, which is the same wipe as a failed fetch, just
 * from a config regression instead of a network one. Writer policy belongs in the writers.
 *
 * Shared by both CLI writers (this script and scripts/extract-workbook.ts) for the same reason
 * evaluateAnomalyFloor and evaluateReconciliationGate are: two copies drift apart, and the
 * 2026-07-26 forensics showed exactly what an unguarded second writer costs.
 */
export function requireLiveDealsSource(snapshotPath: string, force: boolean): AnomalyFloorResult {
  if (process.env.NOTION_TOKEN) return { refuse: false };
  if (!force) {
    return {
      refuse: true,
      reason:
        `Refusing to write ${snapshotPath}: NOTION_TOKEN is not set, so the deals and counterparties ` +
        `sections would be written from the seed placeholder set, wiping the live pipeline. ` +
        `portfolio.json was NOT modified. Re-run with --force only if a seed-only snapshot is intended.`,
    };
  }
  return { refuse: false, warning: '--force: writing with no NOTION_TOKEN — deals/counterparties come from the seed placeholder set, not the live pipeline.' };
}

/**
 * Config-regression guard for the M365 To-Do source — the tasks-side twin of
 * requireLiveDealsSource, and for exactly the same reason its doc comment gives.
 *
 * WHY THE FLAG GATE IS NOT ENOUGH (refute 2026-09-06). m365TasksDegradationFlag deliberately
 * returns null for `not-configured`, so evaluateReconciliationGate never sees it: flagging it would
 * leave every credential-less dev session permanently "dirty". For a WRITER the calculus inverts —
 * absent Graph credentials mean the tasks section is written from the workbook checklist alone,
 * dropping every live M365 row (115 -> 59 on 2026-09-05), which is the SAME loss as a failed fetch,
 * just sourced from a config regression instead of a network one. A GRAPH_CLIENT_SECRET rotation
 * (24-month expiry) or any .env edit that drops the key trio produces it.
 *
 * Nothing downstream catches that: `not-configured` was the one branch of loadM365Tasks that logged
 * nothing, `tasks` is not among the section-shrink guard's five hardcoded list keys, and that
 * guard's generic half fires only on populated -> empty, so a partial 115 -> 59 is invisible. Exit 0
 * then suppresses both the Notion post and the alert email, and both snapshot tasks auto-push.
 */
export function requireLiveM365Source(
  degraded: M365TasksDegradation | null,
  snapshotPath: string,
  force: boolean,
): AnomalyFloorResult {
  if (degraded === null) return { refuse: false };
  if (!force) {
    return {
      refuse: true,
      reason:
        `Refusing to write ${snapshotPath}: the Microsoft 365 To-Do source is unavailable ` +
        `(${degraded.reason}), so the tasks section would be written from the workbook checklist ` +
        `alone, dropping every live M365 row that was previously present. portfolio.json was NOT ` +
        `modified. Cause: ${degraded.detail}. Re-run with --force only if a checklist-only tasks ` +
        `section is intended.`,
    };
  }
  return {
    refuse: false,
    warning: `--force: writing with the M365 To-Do source unavailable (${degraded.reason}) — the tasks section omits every live M365 row. Cause: ${degraded.detail}.`,
  };
}

export function evaluateReconciliationGate(
  snapshot: PortfolioSnapshot,
  snapshotPath: string,
  force: boolean,
): AnomalyFloorResult {
  const errors = [...snapshot.dataQuality, ...checkSnapshot(snapshot)].filter((f) => f.severity === 'error');
  if (errors.length === 0) return { refuse: false };

  const summary = errors.map((f) => `${f.entity} · ${f.field}: ${f.issue}`).join('; ');
  if (!force) {
    return {
      refuse: true,
      reason: `Refusing to write ${snapshotPath}: reconciliation check failed -- ${errors.length} error-severity flag(s): ${summary}. portfolio.json was NOT modified. Re-run with --force only if this is a known, intentional discrepancy.`,
    };
  }
  return {
    refuse: false,
    warning: `--force: proceeding despite ${errors.length} reconciliation error(s): ${summary}.`,
  };
}

export interface DriftReportResult {
  /** True when anything in `drift` is worth a human's attention (new/removed/re-keyed/date-changed/rent-changed). */
  hasDrift: boolean;
  /** Plain lines, ready to console.log() or join('\n') for a Notion post -- no trailing newlines. */
  lines: string[];
}

/**
 * Formats `computeDrift`'s output as human-readable lines and decides whether any of it counts as
 * "drift worth a look." Pure: no I/O, no process.exit -- extracted 2026-07-26 alongside
 * evaluateAnomalyFloor for the same reason (see that function's doc comment) PLUS one more: the
 * anomaly floor alone (0-lease / >25%-removed) would NOT have caught the incident that prompted
 * this extraction -- the two corrupted tenants (REDACTED-386, REDACTED-421
 * Construction) were never added or removed, only their `leaseEnd` values changed, so
 * `removedIds` stayed empty and the count-based floor saw nothing wrong. This report -- previously
 * only ever generated by lease-snapshot-drift-check.ts, never by extract-workbook.ts -- is what
 * actually surfaces a date-only corruption for human review. It does not REFUSE the write (a
 * legitimate lease renewal changes leaseEnd too, so refusing here would block real, wanted edits);
 * it reports, and the reader/reviewer judges.
 *
 * Takes the raw `previous`/`current` arrays (not a caller-derived `prevById` map / lease count) so
 * the map and count can never silently disagree with `drift` -- a 2026-07-26 REFUTE finding on the
 * first version of this function, which took both as separate args a future caller could mismatch.
 */
export function formatDriftReport(
  drift: DriftResult,
  previous: DriftLeaseView[],
  current: DriftLeaseView[],
): DriftReportResult {
  // A run with no previous snapshot to diff against is establishing a baseline, not detecting
  // drift -- 2026-07-26 REFUTE finding: without this guard, computeDrift([], current) puts EVERY
  // current lease in `genuinelyNew`, so a first run (or any run after the snapshot file is deleted)
  // unconditionally reports "drift" and exits 2, dumping the entire portfolio as a "new leases"
  // list. That is a normal bootstrap, not something for a human to review.
  if (previous.length === 0) {
    return { hasDrift: false, lines: [`✓ Baseline established (${current.length} leases). No previous snapshot to diff against.`] };
  }

  const prevById = new Map(previous.map((l) => [l.id, l]));
  const { removedIds, newIds, changedDates, rekeyed, genuinelyNew, genuinelyRemoved, ambiguous, rentChanged } = drift;
  if (newIds.length === 0 && changedDates.length === 0 && removedIds.length === 0 && rentChanged.length === 0) {
    return { hasDrift: false, lines: [`✓ No lease drift. portfolio.json regenerated (${current.length} leases).`] };
  }

  const label = (l: DriftLeaseView) => `${l.propertyKey}${l.unit ? ` ${l.unit}` : ''} | ${l.company ?? l.tenantName}`;
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const lines: string[] = [`⚠ Lease drift detected — portfolio.json regenerated (${current.length} leases).`];

  if (rentChanged.length) {
    // First, above the date changes: a rent zero-out on a retained lease is the shape no other
    // guard sees (see rentChangeKind), and the 2026-09-07 refresh dropped $REDACTED-AMT of annualized
    // rent this way with no line anywhere. Each row carries the lease's status and its term context
    // (leaseEnd + monthsToExpiry -- the Lease contract has no notice field) next to the prior and
    // current rent, so a reader can tell "Expired, vacated, $0 is right" from "Active with four
    // months left, $0 is a zeroed cell" without opening the workbook.
    lines.push('', `Rent changes on retained leases (${rentChanged.length}) — to/from $0, or >${RENT_CHANGE_MATERIAL_FRACTION * 100}% move:`);
    for (const r of rentChanged) {
      const c = r.current;
      const term = `end ${c.leaseEnd ?? '—'}${c.monthsToExpiry !== null ? ` (${c.monthsToExpiry} mo)` : ''}`;
      lines.push(`  ${label(c)} | ${c.status} | ${term} | ${usd(r.previous.annualRent)} -> ${usd(c.annualRent)}`);
      if (r.previous.id !== c.id) lines.push(`    id: ${r.previous.id} -> ${c.id}`);
    }
  }
  if (changedDates.length) {
    lines.push('', `Lease end date changes (${changedDates.length}):`);
    for (const l of changedDates) {
      const prev = prevById.get(l.id)!;
      lines.push(`  ${l.id} | ${l.company ?? l.tenantName} | ${prev.leaseEnd} -> ${l.leaseEnd}`);
    }
  }
  if (rekeyed.length) {
    // The headline number during an id-scheme migration. Value changes first -- during the
    // 2026-07-24 re-baseline these five rows were the entire signal, and the id-only report
    // buried them under 274 lines of churn.
    const withDateChange = rekeyed.filter((r) => r.leaseEndChanged);
    lines.push('', `Re-keyed leases (${rekeyed.length}) — same property/unit/tenant, new id:`);
    if (withDateChange.length) {
      lines.push(`  ⚠ ${withDateChange.length} with a leaseEnd change:`);
      for (const r of withDateChange) {
        lines.push(`    ${label(r.current)} | ${r.previous.leaseEnd} -> ${r.current.leaseEnd}`);
        lines.push(`      id: ${r.previous.id} -> ${r.current.id}`);
      }
    }
    const unchanged = rekeyed.length - withDateChange.length;
    if (unchanged) lines.push(`  ${unchanged} re-keyed with no value change (ids only).`);
  }
  if (genuinelyNew.length) {
    lines.push('', `Genuinely new leases (${genuinelyNew.length}):`);
    for (const l of genuinelyNew) lines.push(`  ${l.id} | ${l.company ?? l.tenantName} | end: ${l.leaseEnd}`);
  }
  if (genuinelyRemoved.length) {
    lines.push('', `Genuinely removed leases (${genuinelyRemoved.length}):`);
    for (const l of genuinelyRemoved) lines.push(`  ${l.id} | ${l.company ?? l.tenantName} | was end: ${l.leaseEnd}`);
  }
  if (ambiguous.length) {
    // Not paired on purpose -- these fell through to the new/removed lists above. Surfaced so a
    // reader knows the pairing declined to guess rather than silently finding nothing.
    lines.push('', `Ambiguous business keys (${ambiguous.length}) — not paired, listed above as new/removed:`);
    for (const a of ambiguous) lines.push(`  ${a.key} | ${a.previousCount} previous, ${a.currentCount} current`);
  }

  return { hasDrift: true, lines };
}

async function main() {
  const force = process.argv.includes('--force');
  const previousResult = loadPrevious();
  if (previousResult.corrupt) {
    // Refuse to write WITHOUT moving/renaming/deleting the corrupt file -- it stays exactly where it
    // is, at SNAPSHOT_PATH. Round-4 REFUTE: an earlier version of this guard "backed the file aside"
    // (renameSync(SNAPSHOT_PATH, backup)) before refusing, which looked like a reasonable safety
    // gesture but was actually self-defeating -- it moved the corrupt file AWAY from SNAPSHOT_PATH,
    // so the very NEXT run's existsSync(SNAPSHOT_PATH) came back false, loadPrevious() reported the
    // normal first-run state ({ leases: [], corrupt: false }) instead of "corrupt", and the
    // anomaly floor below (gated on `previous.length > 0`) was silently skipped one run later --
    // recreating, one run downstream, the exact "floor disabled" failure this refusal exists to
    // close, now caused BY the fix. Leaving the file in place instead means: (a) the message below is
    // literally true (nothing was modified), and (b) the NEXT run hits this same corrupt file and
    // refuses again -- persistent, not one-shot, detection that stays blocking until a human actually
    // fixes or restores it (matching the overlay-corruption guard below, which never moves anything
    // either). Unconditional -- NOT bypassed by --force, which is reserved for a genuine
    // mass-disposition event, a different failure class from "the baseline file is unreadable".
    console.error(`✗ ${SNAPSHOT_PATH} is corrupt — refusing to write. portfolio.json was NOT modified. Investigate/fix/restore it, then re-run.`);
    process.exit(1);
  }
  const previous = previousResult.leases;

  const { snapshot, m365Degraded } = await parseWorkbook(workbookPath());
  // Round-3 REFUTE finding: loadOverlay() fails OPEN to an empty overlay on corrupt/unparseable
  // JSON — a defensible default for a UI-driven mutation, but this script is an UNATTENDED
  // scheduled/manual writer: silently enriching with an empty overlay would zero real
  // tenantArrears/renewalStages/marketRents/noiBudgets data in the written snapshot with no
  // warning. Mirrors the identical guard in scripts/ar-import-headless.ts (same hazard class).
  // Pre-flight overlay check. loadOverlay() fails OPEN to EMPTY_OVERLAY on anything unreadable — a
  // defensible default for a UI-driven mutation, but this script is an UNATTENDED writer, and
  // enriching with an empty overlay would ZERO real tenantArrears/arBalances/renewalStages/
  // dealComps/marketRents/noiBudgets in the written snapshot with no warning. The shared evaluator
  // in server/overlay.ts covers missing, unparseable AND wrong-top-level-shape overlays; it lives
  // there, tested once, precisely so these three writers can no longer drift out of sync (the
  // missing-file case was absent from all three simultaneously until 2026-09-05).
  const rawOverlayPath = overlayPath();
  // expectEnriched: this writer MERGES the overlay onto a parsed snapshot, so a present-but-empty
  // overlay zeroes enrichment just as surely as a missing one. ar-import does not pass it.
  const overlayCheck = evaluateOverlayPrecondition(rawOverlayPath, { expectEnriched: true });
  if (overlayCheck.refuse) {
    console.error(`✗ ${overlayCheck.reason}`);
    process.exit(1);
  }
  // portfolio.json's canonical content is the OVERLAY-ENRICHED snapshot (see server/brain.ts's
  // refresh(), which persists applyOverlay(snapshot, overlay)), not the raw parse -- writing the
  // raw parse here would silently zero out real tenantArrears/renewalStages/marketRents/noiBudgets
  // data on every scheduled run (a mandatory adversarial review round caught this).
  const overlay = loadOverlay();
  const merged = applyOverlay(snapshot, overlay);
  // quickbooks is SERVER-ATTACHED (server/brain.ts calls loadQuickbooks() itself; parseWorkbook/
  // applyOverlay never touch it), and the contract defaults it to null. Without this step this CLI
  // writer would silently NULL OUT whatever the server path had previously written -- the
  // 2026-08-17 incident (see resolveQuickbooks's doc comment in server/sources/quickbooks.ts).
  // Attached here, before the reconciliation gate below, so that gate sees the same object shape
  // server/brain.ts's checkSnapshot(withQb) does. Same attach point as scripts/extract-workbook.ts
  // -- keep both regeneration tools in sync (see this file's header comment).
  const { quickbooks, preservedFrom } = resolveQuickbooks(merged.properties, SNAPSHOT_PATH);
  if (preservedFrom) console.log(`ℹ quickbooks: no fresh QUICKBOOKS_CSV parse — carried forward the previous snapshot's block (parsedAt ${quickbooks!.parsedAt}) instead of nulling it.`);
  const enriched = { ...merged, quickbooks };
  // No cast: Lease already structurally satisfies DriftLeaseView. Keeping this a plain
  // assignment (not `as unknown as`) means a future Lease shape change that breaks the
  // assumption fails typecheck here instead of silently disabling the check. enriched.leases is
  // identical to snapshot.leases (applyOverlay never touches .leases -- verified by reading its
  // implementation), so reading from `enriched` here is behavior-neutral for the diff itself; it's
  // used for consistency, so a future maintainer never has two "the current leases" variables to
  // pick between.
  const current: DriftLeaseView[] = enriched.leases;

  const drift = computeDrift(previous, current);
  // `drift.removedIds` stays the RAW id-level removal set on purpose: it is the anomaly floor's
  // input below, and the floor must keep tripping on a wholesale id change. Feeding it the
  // business-key-paired `genuinelyRemoved` instead would have let the 2026-07-24 re-baseline write
  // through unattended -- convenient, but it would retire the exact safety property the floor
  // provides.
  const floor = evaluateAnomalyFloor(previous, current, drift.removedIds, SNAPSHOT_PATH, force);
  if (floor.refuse) {
    console.error(`✗ ${floor.reason}`);
    process.exit(1);
  } else if (floor.warning) {
    console.warn(`⚠ ${floor.warning}`);
  }

  // Dollar-exact reconciliation, separate from and in addition to the count-based floor above --
  // see evaluateReconciliationGate's doc comment for why the floor alone missed the 2026-08-03
  // phantom-lease incident (rows only ADDED, nothing removed). Checked against `enriched`, the
  // actual object about to be written, matching server/brain.ts's own checkSnapshot(withQb) call
  // on its post-overlay snapshot.
  const reconciliation = evaluateReconciliationGate(enriched, SNAPSHOT_PATH, force);
  if (reconciliation.refuse) {
    console.error(`✗ ${reconciliation.reason}`);
    process.exit(1);
  } else if (reconciliation.warning) {
    console.warn(`⚠ ${reconciliation.warning}`);
  }

  // Config-regression guards, complementing the flag-based gate above -- see their doc comments.
  const m365Source = requireLiveM365Source(m365Degraded, SNAPSHOT_PATH, force);
  if (m365Source.refuse) {
    console.error(`✗ ${m365Source.reason}`);
    process.exit(1);
  } else if (m365Source.warning) {
    console.warn(`⚠ ${m365Source.warning}`);
  }

  const dealsSource = requireLiveDealsSource(SNAPSHOT_PATH, force);
  if (dealsSource.refuse) {
    console.error(`✗ ${dealsSource.reason}`);
    process.exit(1);
  } else if (dealsSource.warning) {
    console.warn(`⚠ ${dealsSource.warning}`);
  }

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  // Atomic write (temp file + rename), same pattern as scripts/ar-import-headless.ts's
  // patchSnapshot(): a crash mid-write must not leave portfolio.json truncated for the next reader
  // (the daily brief's collections section, server/brain.ts's loadFallback() after a server restart).
  const tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(enriched, null, 2));
  // Retried on the Windows AV/indexer transient lock (EPERM/EBUSY/EACCES) -- see server/lib/rename-retry.
  renameSyncWithRetry(tmp, SNAPSHOT_PATH);

  const report = formatDriftReport(drift, previous, current);
  for (const line of report.lines) console.log(line);
  // Distinguish "ran, found drift worth a look" (2) from "ran clean" (0) and "refused to write" (1)
  // above, so an unattended scheduler can tell these apart instead of every run exiting 0.
  process.exit(report.hasDrift ? 2 : 0);
}

// Run the CLI only when invoked directly (importing for tests -- computeDrift/businessKey -- must
// NOT parse the live workbook, rewrite portfolio.json, or exit the test process). Same guard as
// scripts/migrate-lease-overlay-ids.ts, which was extracted for unit-testability the same way.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/lease-snapshot-drift-check.ts')) {
  main().catch((err) => {
    console.error('drift check failed:', err);
    process.exit(3);
  });
}
