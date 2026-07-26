// scripts/lease-snapshot-drift-check.ts
//
// Regenerates data/snapshots/portfolio.json from the live workbook (same as `npm run extract`),
// then diffs the NEW lease set against what was there immediately before, reporting any lease
// whose id or leaseEnd changed. Run on a schedule so portfolio.json never goes stale for longer
// than the schedule's own interval, independent of whether the interactive dev/prod server is
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, SNAPSHOT_PATH } from '../server/config';
import { loadOverlay, applyOverlay, overlayPath } from '../server/overlay';

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

  return {
    newIds,
    removedIds,
    changedDates,
    rekeyed,
    genuinelyNew,
    genuinelyRemoved,
    ambiguous: [...ambiguousByKey.values()],
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
 */
export function evaluateAnomalyFloor(
  previous: DriftLeaseView[],
  current: DriftLeaseView[],
  removedIds: DriftLeaseView[],
  snapshotPath: string,
  force: boolean,
): AnomalyFloorResult {
  // Refuse to overwrite a known-good snapshot with an EMPTY one: unconditional, regardless of
  // `previous.length` (Round-3 REFUTE -- previously this was gated on `previous.length > 0`, so
  // whenever the previous snapshot was corrupt/missing -- now handled by loadPrevious()'s corrupt
  // flag, but a fresh/legitimate 0-lease previous state reaches here too -- this refusal was
  // bypassed entirely and ANY current parse result, including a genuinely broken 0-lease parse,
  // wrote through unguarded). A workbook that genuinely has zero leases is not a realistic scenario
  // for this portfolio, so refusing and requiring --force is the safe default.
  if (current.length === 0) {
    if (!force) {
      return {
        refuse: true,
        reason: `Refusing to write ${snapshotPath}: this parse produced 0 leases (previous snapshot had ${previous.length}) -- this looks like a bad parse, not a genuine full portfolio wind-down. portfolio.json was NOT modified. Re-run with --force if this is a real, intentional event.`,
      };
    }
    return {
      refuse: false,
      warning: `--force: proceeding despite a 0-lease current parse (previous snapshot had ${previous.length}).`,
    };
  }

  // Refuse to overwrite a known-good snapshot with a suspiciously small one: a parse that goes
  // wrong for a reason OTHER than genuine lease removal (workbook read mid-save, a renamed/missing
  // worksheet section, a wrong WORKBOOK_PATH resolving to the wrong file) must not silently replace
  // real data. Fraction is of the OLD (previous) set that vanished -- removedIds.length /
  // previous.length -- not some other ratio. Gated on `current.length > 0` because the
  // current.length === 0 case is fully handled by the branch above.
  if (previous.length > 0) {
    const removedFraction = removedIds.length / previous.length;
    const anomalous = removedFraction > 0.25;
    if (anomalous) {
      if (!force) {
        return {
          refuse: true,
          reason: `Refusing to write ${snapshotPath}: previous snapshot had ${previous.length} lease(s), this parse produced ${current.length}, ${removedIds.length} (${(removedFraction * 100).toFixed(1)}%) would be removed -- this looks like a bad parse, not a genuine mass disposition. portfolio.json was NOT modified. Re-run with --force if this is a real, intentional mass-disposition event.`,
        };
      }
      return {
        refuse: false,
        warning: `--force: proceeding despite ${removedIds.length}/${previous.length} (${(removedFraction * 100).toFixed(1)}%) leases removed (current count ${current.length}).`,
      };
    }
  }

  return { refuse: false };
}

export interface DriftReportResult {
  /** True when anything in `drift` is worth a human's attention (new/removed/re-keyed/date-changed). */
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
 */
export function formatDriftReport(
  drift: DriftResult,
  prevById: Map<string, DriftLeaseView>,
  currentLeaseCount: number,
): DriftReportResult {
  const { removedIds, newIds, changedDates, rekeyed, genuinelyNew, genuinelyRemoved, ambiguous } = drift;
  if (newIds.length === 0 && changedDates.length === 0 && removedIds.length === 0) {
    return { hasDrift: false, lines: [`✓ No lease drift. portfolio.json regenerated (${currentLeaseCount} leases).`] };
  }

  const label = (l: DriftLeaseView) => `${l.propertyKey}${l.unit ? ` ${l.unit}` : ''} | ${l.company ?? l.tenantName}`;
  const lines: string[] = [`⚠ Lease drift detected — portfolio.json regenerated (${currentLeaseCount} leases).`];

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
  const prevById = new Map(previous.map((l) => [l.id, l]));

  const { snapshot } = await parseWorkbook(workbookPath());
  // Round-3 REFUTE finding: loadOverlay() fails OPEN to an empty overlay on corrupt/unparseable
  // JSON — a defensible default for a UI-driven mutation, but this script is an UNATTENDED
  // scheduled/manual writer: silently enriching with an empty overlay would zero real
  // tenantArrears/renewalStages/marketRents/noiBudgets data in the written snapshot with no
  // warning. Mirrors the identical guard in scripts/ar-import-headless.ts (same hazard class).
  const rawOverlayPath = overlayPath();
  if (existsSync(rawOverlayPath)) {
    try {
      const parsedOverlay: unknown = JSON.parse(readFileSync(rawOverlayPath, 'utf8'));
      // Round-4 REFUTE: a JSON.parse THROW only catches malformed JSON syntax. Content that is
      // syntactically valid JSON but the wrong TOP-LEVEL shape (`null`, `[]`, `0`, `"some string"`)
      // parses successfully, passes a parse-only guard, but still causes loadOverlay() to fall back
      // to EMPTY_OVERLAY internally -- silently zeroing enrichment data exactly as before, just via
      // a different malformed-content shape than a parse error. Reject anything that isn't a
      // non-null, non-array object before letting it through. NOTE: this only catches the wrong-
      // top-level-type case -- a syntactically valid object missing some/all of the expected overlay
      // domain keys (e.g. `{"foo": 1}`, or a file truncated to one surviving key) still passes this
      // check and still yields a partially/fully empty overlay from loadOverlay's per-domain
      // fallbacks. Closing that residual gap would need a keys-overlap check against EMPTY_OVERLAY's
      // shape; left as a known, narrower residual rather than expanding this guard further.
      if (!parsedOverlay || typeof parsedOverlay !== 'object' || Array.isArray(parsedOverlay)) {
        console.error(`✗ ${rawOverlayPath} is valid JSON but not a valid overlay object — refusing to regenerate portfolio.json (would zero enrichment data). Fix or restore it first.`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`✗ ${rawOverlayPath} is corrupt/unparseable — refusing to regenerate portfolio.json (would zero enrichment data). Fix or restore it first. (${e instanceof Error ? e.message : String(e)})`);
      process.exit(1);
    }
  }
  // portfolio.json's canonical content is the OVERLAY-ENRICHED snapshot (see server/brain.ts's
  // refresh(), which persists applyOverlay(snapshot, overlay)), not the raw parse -- writing the
  // raw parse here would silently zero out real tenantArrears/renewalStages/marketRents/noiBudgets
  // data on every scheduled run (a mandatory adversarial review round caught this).
  const overlay = loadOverlay();
  const enriched = applyOverlay(snapshot, overlay);
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

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  // Atomic write (temp file + rename), same pattern as scripts/ar-import-headless.ts's
  // patchSnapshot(): a crash mid-write must not leave portfolio.json truncated for the next reader
  // (the daily brief's collections section, server/brain.ts's loadFallback() after a server restart).
  const tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(enriched, null, 2));
  renameSync(tmp, SNAPSHOT_PATH);

  const report = formatDriftReport(drift, prevById, current.length);
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
