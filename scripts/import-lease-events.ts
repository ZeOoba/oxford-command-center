// scripts/import-lease-events.ts
//
// Populates lease_events (migration 011), the vacate/commence log that leasingVelocity
// (server/warehouse/lease-velocity.ts) reads. Before this importer nothing wrote the table, so
// leasing velocity was always empty.
//
// SOURCE OF RECORD: the Master Workbook rent roll, as captured in PortfolioSnapshot files. Events are
// DERIVED from the whole series of captures, not abstracted from leases. The capture set is:
//   1. every committed version of data/snapshots/portfolio.json in git (tracked until 2026-11-10);
//   2. every capture in the archive, data/snapshots/history/ (local, gitignored real data);
//   3. the current data/snapshots/portfolio.json (or --snapshot files).
// Every readable capture, git ones included, is written to the archive on each successful run, so
// the series is durable: it no longer depends on which git refs exist.
//
// MODEL: TENANCY CHAINS (refute rounds wf_0e8573e6-c57, wf_d7dfc6cb-dc6, wf_12470799-a63). Within a
// property, each rent-roll line is linked to the tenancy it continues, searched across ALL earlier
// captures, not just the previous one. Linking runs per capture in four passes of falling match
// strength: the exact line (same suite, tenant and leaseStart); same tenant (normalised) in the same
// suite; same leaseStart in the same suite (tenant rename); same tenant with the same leaseStart in
// another suite (suite relabel). So a
// multi-suite tenant's lines keep their own suites. A tenancy is not re-linked across a different
// tenancy that occupied its suite in between (the same tenant and start there is not different).
// Vacancy placeholder lines (isVacantPlaceholder, mirroring parse.ts) are not leases. A line that continues nothing starts a new tenancy. So a
// renewal, a one-capture data gap, or a property missing from one capture never starts or ends
// anything.
//
//   CONFIRMED  a tenancy seen in two or more captures, or first seen in the EARLIEST capture (the
//              series starts there, so its earlier sightings simply were not captured). Any other
//              tenancy seen in a single capture emits nothing: held when that is the newest capture
//              (commence-unconfirmed), dropped as a phantom otherwise. A real lease sits on a weekly
//              rent roll for many captures.
//   commence   per confirmed tenancy with a leaseStart, in the suite it was first seen in, dated its
//              earliest leaseStart when that is on or before its first sighting      'lease_start'
//              else its first sighting (listed ahead of its start, or first keyed with a blank start
//              and given one later: it was on the rent roll from then)                'first_seen'
//              So every commence is a LOWER bound on occupancy (refute round 6, wf_24523df2-4fd). A
//              leaseStart after the newest capture is not yet an event.
//   vacate     per confirmed tenancy whose last sighting is not the newest capture. The departure
//              window is (lo, hi]: lo = asOf of its last sighting, hi = asOf of the first LATER capture
//              holding any line of that property (a capture missing the whole property is skipped).
//              Held (vacate-unconfirmed) unless a capture after hi also holds the property.
//              Dated, in order:
//                leaseEnd when it falls in (lo, hi] AND hi - lo <= LEASE_END_WINDOW_DAYS (14)  'lease_end'
//                else hi, the first capture it is missing from                    'first_absent'
//              then S, when S is earlier than the date above                    'successor_start'
//              where S = the earliest commence date of a REAL REPLACEMENT in the suite it was last seen
//              in: another confirmed, non-renewal tenancy that emits a commence, began after this one
//              (or, with no start of its own, was first seen after it), and is still listed after this
//              tenancy's last sighting, a replacement listed beside it included (rounds 6-7).
//              A line still listed past its lease end is a possible month-to-month holdover and is
//              never backdated to the expired lease end (refute rounds 3-5: wf_12470799-a63,
//              wf_4d9846fe-f7c, wf_2a1ff182-4c1). 'first_absent' and 'successor_start' are UPPER bounds
//              on departure. 'lease_end' is a point estimate: an unseen holdover inside its window makes
//              it early by at most the window (14 days), the only way a gap can read long, and by no
//              more than that. A vacate is never dated after a later occupant's commence, so it never
//              pairs with a later, unrelated commence (round 6).
//   renewal    the same tenant's later lease in the suite it was last seen in, listed beside it or first
//              listed by the next capture holding the property: no vacate, no second commence.
//   presence   a property is on the rent roll in a capture when it has ANY line there, vacancy
//              placeholders included, so a fully vacant single-suite property keeps its dark period.
//   ambiguous  a property with two or more concurrent no-unit leases cannot be paired by suite; its
//              no-unit leases emit nothing (data_quality_issues 'lease-event-ambiguous-suite').
//   Known limit: a renewal signed under a different entity name AND a new leaseStart in the same suite
//              is indistinguishable from an instant re-let; it reads as a 0-1 day turnover (fast bias).
//
// Captures: sorted by asOf; same asOf keeps the later meta.generatedAt, then the larger label; a
// capture holding under half the last kept capture's leases is a defective parse and is left out; two
// in a row fail the run. Leases inside a capture are re-sorted by a total key in the derivation itself,
// so neither file order nor a hand-built capture's array order decides.
//
// OWNERSHIP, IDEMPOTENCY, NO SHRINK: every row written here carries [DERIVED:<basis>] in source_file,
// and source_file / abstract_date name capture days, never files or git shas, so they are stable. A run
// REPLACES all such rows with the derivation of the full capture set in one transaction, so the table
// is a function of the capture set, not of run history, and a re-run reports 0 added / 0 removed.
// Every row is re-inserted on each run, so MAX(created_at) of the [DERIVED: rows is the last
// successful run (the freshness contract PR #592 reads); nothing else reads lease_events.created_at.
// A run is REFUSED (nothing written) when an existing derived row's abstract_date names a capture day
// missing from the new capture set: history only grows, and a degenerate set (another checkout, a
// moved archive, a purged ref) cannot wipe it. --allow-shrink overrides, deliberately.
//
// Rejected vs persisted: a lease with no propertyId or tenant is not a lease. A non-ISO leaseStart
// yields no commence. A propertyId missing from property_master is never inserted:
// data_quality_issues 'lease-event-unknown-property'. A DB error on one row:
// 'lease-event-check-violation', and its siblings still land. Identical open DQ rows are not re-filed.
//
// Opens the warehouse with openWarehouseNoMigrate: a DB behind this code is refused, never migrated.
//
// Usage:
//   npx tsx scripts/import-lease-events.ts [--snapshot <portfolio.json>]... [--repo <dir>]
//                                         [--archive <dir>] [--db <path>] [--allow-shrink] [--dry-run]
//   --snapshot      current capture(s); repeatable. Default data/snapshots/portfolio.json.
//   --repo          git repo whose history holds data/snapshots/portfolio.json (default cwd).
//   --archive       capture archive directory (default data/snapshots/history).
//   --allow-shrink  accept a capture set missing days the warehouse already derived from.
//   --dry-run       derive and print counts; open no DB, archive nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouseNoMigrate } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { isIsoCalendarDate } from '../server/warehouse/placeholder-data';
import { refuseIfSynthetic } from '../server/real-data-status';

export const SNAPSHOT_REPO_PATH = 'data/snapshots/portfolio.json';
export const DEFAULT_ARCHIVE_DIR = join('data', 'snapshots', 'history');
/** A capture holding fewer than this share of the last kept capture's leases is a defective parse. */
export const MIN_CAPTURE_LEASE_RATIO = 0.5;
/** The ownership tag: rows whose source_file contains it are replaced on every run. */
export const DERIVED_TAG = '[DERIVED:';

export interface CaptureLease {
  propertyId: string;
  suiteKey: string; // normalised suite, '' = no unit
  tenant: string; // display name as captured
  tenantKey: string; // normalised tenant for continuity checks
  leaseStart: string | null; // valid ISO or null
  leaseEnd: string | null; // valid ISO or null
}

export interface Capture {
  asOf: string; // ISO day the rent roll describes
  generatedAt: string; // meta.generatedAt ('' when absent): breaks same-asOf ties
  label: string; // where it was read from (notes only; never persisted)
  leases: CaptureLease[];
  /**
   * Every propertyId with any rent-roll line in this capture, vacancy placeholders included (sorted).
   * Presence decides the vacate window; a property whose only line is a placeholder is still on the
   * rent roll, so its dark period is kept. Optional for hand-built captures: then derived from leases.
   */
  presentProperties?: string[];
}

export type EventBasis = 'lease_start' | 'first_seen' | 'lease_end' | 'first_absent' | 'successor_start';

/** A lease end is a usable vacate date only inside a departure window this tight (days). */
export const LEASE_END_WINDOW_DAYS = 14;
const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface LeaseEventRow {
  propertyId: string;
  suite: string | null;
  tenant: string;
  eventKind: 'vacate' | 'commence';
  eventDate: string;
  basis: EventBasis;
  sourceFile: string;
  abstractDate: string;
}

export interface DeriveNote {
  kind: 'capture-defective' | 'capture-duplicate' | 'future-commence' | 'property-gone'
    | 'vacate-unconfirmed' | 'commence-unconfirmed' | 'phantom-tenancy' | 'ambiguous-suite';
  propertyId?: string;
  detail: string;
}

export function normaliseSuite(unit: unknown): string {
  if (typeof unit !== 'string') return '';
  return unit.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normaliseTenant(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|l\.l\.c\.|inc|incorporated|corp|corporation|co|company|ltd|lp|llp)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && isIsoCalendarDate(v) ? v : null;
}

/**
 * A rent-roll line that is a vacancy placeholder, not a lease. Mirrors server/workbook/parse.ts
 * (rowIsVacant): status Vacant, or a tenant name starting "Vacant" when the Status cell was blank,
 * which parse.ts maps to 'Unknown'. Any other status (Active, Expiring Soon, Expired) keeps the line a
 * lease, as parse.ts does: an expired line may be a real holdover tenant.
 */
export function isVacantPlaceholder(status: unknown, tenantName: string): boolean {
  if (status === 'Vacant') return true;
  return (status === 'Unknown' || status === undefined || status === null) && /^\s*vacant\b/i.test(tenantName);
}

const leaseOrder = (l: CaptureLease): string =>
  [l.propertyId, l.suiteKey, l.leaseStart ?? '', l.tenantKey, l.tenant, l.leaseEnd ?? ''].join('\u0000');
const byLeaseOrder = (a: CaptureLease, b: CaptureLease): number => (leaseOrder(a) < leaseOrder(b) ? -1 : leaseOrder(a) > leaseOrder(b) ? 1 : 0);

/**
 * One PortfolioSnapshot payload to a Capture. Pure. Returns an error (never throws) when the
 * payload is not a snapshot: no meta.asOf ISO day, or no leases array. Leases come back in a total
 * order, so file order never reaches the derivation.
 */
export function captureFromSnapshot(payload: unknown, label: string): { capture: Capture } | { error: string } {
  if (typeof payload !== 'object' || payload === null) return { error: `${label}: not a JSON object` };
  const p = payload as { meta?: { asOf?: unknown; generatedAt?: unknown }; leases?: unknown };
  const asOf = isoOrNull(p.meta?.asOf);
  if (asOf === null) return { error: `${label}: meta.asOf is not an ISO YYYY-MM-DD day` };
  if (!Array.isArray(p.leases)) return { error: `${label}: no leases array` };
  const leases: CaptureLease[] = [];
  const present = new Set<string>();
  for (const raw of p.leases) {
    if (typeof raw !== 'object' || raw === null) continue;
    const l = raw as Record<string, unknown>;
    const propertyId = typeof l.propertyId === 'string' ? l.propertyId.trim() : '';
    const tenant = typeof l.tenantName === 'string' ? l.tenantName.trim() : '';
    if (propertyId !== '') present.add(propertyId);
    if (propertyId === '' || tenant === '') continue;
    // A vacant placeholder line is a suite with no tenancy, not a lease.
    if (isVacantPlaceholder(l.status, tenant)) continue;
    leases.push({
      propertyId,
      suiteKey: normaliseSuite(l.unit),
      tenant,
      tenantKey: normaliseTenant(tenant),
      leaseStart: isoOrNull(l.leaseStart),
      leaseEnd: isoOrNull(l.leaseEnd),
    });
  }
  leases.sort(byLeaseOrder);
  const generatedAt = typeof p.meta?.generatedAt === 'string' ? p.meta.generatedAt : '';
  return { capture: { asOf, generatedAt, label, leases, presentProperties: [...present].sort() } };
}

const sameStart = (a: CaptureLease, b: CaptureLease): boolean => a.leaseStart !== null && a.leaseStart === b.leaseStart;

/**
 * The continuity rule, as four passes in falling match strength (refute wf_12470799-a63 H1): a line
 * is linked by the strongest pass that finds a candidate, so a multi-suite tenant's exact suite lines
 * claim their own tenancies before any cross-suite relabel is considered. Tenancies are per property.
 */
const LINK_PASSES: Array<(prev: CaptureLease, line: CaptureLease) => boolean> = [
  (p, l) => p.suiteKey === l.suiteKey && p.tenantKey === l.tenantKey && sameStart(p, l), // the exact line
  (p, l) => p.suiteKey === l.suiteKey && p.tenantKey === l.tenantKey, // same suite, same tenant (renewal)
  (p, l) => p.suiteKey === l.suiteKey && sameStart(p, l), // same suite, same start (tenant rename)
  (p, l) => p.tenantKey === l.tenantKey && sameStart(p, l), // same tenant, same start (suite relabel)
];

/** Sort, de-duplicate and screen captures. Throws when two captures in a row are defective. */
function sequence(input: Capture[], notes: DeriveNote[]): Capture[] {
  // Same asOf: the later meta.generatedAt wins; ties fall to the label, so input order never decides.
  const rank = (c: Capture): string => `${c.generatedAt}\u0000${c.label}`;
  const byDay = new Map<string, Capture>();
  for (const raw of input) {
    // Total lease order and presence, whatever the caller built (captureFromSnapshot already does both).
    const c: Capture = {
      ...raw,
      leases: [...raw.leases].sort(byLeaseOrder),
      presentProperties: raw.presentProperties ?? [...new Set(raw.leases.map((l) => l.propertyId))].sort(),
    };
    const held = byDay.get(c.asOf);
    if (held === undefined) { byDay.set(c.asOf, c); continue; }
    const keep = rank(c) > rank(held) ? c : held;
    const drop = keep === c ? held : c;
    notes.push({ kind: 'capture-duplicate', detail: `${drop.label} superseded by ${keep.label} (asOf ${c.asOf})` });
    byDay.set(c.asOf, keep);
  }
  const sorted = [...byDay.values()].sort((a, b) => a.asOf.localeCompare(b.asOf));

  const caps: Capture[] = [];
  let rejectedInRow = 0;
  for (const c of sorted) {
    const prev = caps[caps.length - 1];
    if (prev && prev.leases.length > 0 && c.leases.length < prev.leases.length * MIN_CAPTURE_LEASE_RATIO) {
      rejectedInRow += 1;
      notes.push({ kind: 'capture-defective', detail: `${c.label} (asOf ${c.asOf}) holds ${c.leases.length} leases vs ${prev.leases.length} in ${prev.label}; left out` });
      if (rejectedInRow >= 2) {
        throw new Error(`two consecutive captures collapsed against ${prev.label} (asOf ${prev.asOf}); the baseline itself is suspect. Inspect the captures before importing.`);
      }
      continue;
    }
    rejectedInRow = 0;
    caps.push(c);
  }
  return caps;
}

/** Properties with two or more concurrent no-unit leases in any capture: suite pairing is meaningless there. */
function ambiguousSuiteProperties(caps: Capture[]): Set<string> {
  const out = new Set<string>();
  for (const c of caps) {
    const n = new Map<string, number>();
    for (const l of c.leases) if (l.suiteKey === '') n.set(l.propertyId, (n.get(l.propertyId) ?? 0) + 1);
    for (const [p, k] of n) if (k >= 2) out.add(p);
  }
  return out;
}

interface Sighting { idx: number; lease: CaptureLease }
interface Tenancy { propertyId: string; sightings: Sighting[] }

const first = (t: Tenancy): Sighting => t.sightings[0]!;
const last = (t: Tenancy): Sighting => t.sightings[t.sightings.length - 1]!;
const startOf = (t: Tenancy): string | null =>
  t.sightings.map((s) => s.lease.leaseStart).filter((d): d is string => d !== null).sort()[0] ?? null;

/** Link every lease line to the tenancy it continues, across all earlier captures. */
function buildTenancies(caps: Capture[], skip: (l: CaptureLease) => boolean): Map<string, Tenancy[]> {
  const byProp = new Map<string, Tenancy[]>();
  caps.forEach((c, idx) => {
    const claimed = new Set<Tenancy>();
    const lines = c.leases.filter((l) => !skip(l));
    const linked = new Set<CaptureLease>();
    for (const pass of LINK_PASSES) {
      for (const lease of lines) {
        if (linked.has(lease)) continue;
        const list = byProp.get(lease.propertyId) ?? [];
        // Candidates: tenancies not yet sighted in this capture whose latest line this one continues
        // under this pass, and whose suite was not taken by a DIFFERENT tenancy since that sighting.
        // A sighting of the same lease (same tenant, same start) in between is the same occupant
        // under another tenancy record, not a different tenancy, so it does not block.
        const candidates = list.filter((t) => {
          if (claimed.has(t) || !pass(last(t).lease, lease)) return false;
          const lastIdx = last(t).idx;
          return !list.some((o) => o !== t && o.sightings.some((s) => s.idx > lastIdx && s.idx < idx
            && s.lease.suiteKey === lease.suiteKey && !(s.lease.tenantKey === lease.tenantKey && sameStart(s.lease, lease))));
        });
        // Most recently sighted wins; ties fall to creation order (deterministic: captures and leases are ordered).
        candidates.sort((a, b) => last(b).idx - last(a).idx);
        const t = candidates[0];
        if (t) { t.sightings.push({ idx, lease }); claimed.add(t); linked.add(lease); }
      }
    }
    // A line no pass linked starts a new tenancy.
    for (const lease of lines) {
      if (linked.has(lease)) continue;
      const list = byProp.get(lease.propertyId) ?? [];
      byProp.set(lease.propertyId, list);
      list.push({ propertyId: lease.propertyId, sightings: [{ idx, lease }] });
    }
  });
  return byProp;
}

/**
 * Captures (any order) to lease events. Pure: no DB, no I/O, and independent of input order.
 * Returns the kept capture days (the no-shrink check compares them with what is stored).
 */
export function deriveLeaseEvents(input: Capture[]): { rows: LeaseEventRow[]; notes: DeriveNote[]; captureDays: string[] } {
  const notes: DeriveNote[] = [];
  const caps = sequence(input, notes);
  const captureDays = caps.map((c) => c.asOf);
  if (caps.length === 0) return { rows: [], notes, captureDays };
  const newestIdx = caps.length - 1;
  const newestAsOf = caps[newestIdx]!.asOf;

  const ambiguous = ambiguousSuiteProperties(caps);
  for (const p of [...ambiguous].sort()) {
    notes.push({ kind: 'ambiguous-suite', propertyId: p, detail: `${p} has two or more concurrent leases with no unit; its no-unit leases emit no events` });
  }
  const skip = (l: CaptureLease): boolean => l.suiteKey === '' && ambiguous.has(l.propertyId);
  const byProp = buildTenancies(caps, skip);
  const propPresent = (propertyId: string, idx: number): boolean => caps[idx]!.presentProperties!.includes(propertyId);
  const nextPresent = (propertyId: string, idx: number): number => {
    for (let j = idx + 1; j < caps.length; j++) if (propPresent(propertyId, j)) return j;
    return -1;
  };

  const rows: LeaseEventRow[] = [];
  const seen = new Set<string>();
  const suiteOut = (s: string): string | null => (s === '' ? null : s);

  for (const propertyId of [...byProp.keys()].sort()) {
    const tenancies = byProp.get(propertyId)!;
    // Seen twice, or first seen in the earliest capture (the series starts there; the lease's earlier
    // existence is simply not captured, so one sighting there is not evidence of a phantom).
    const confirmed = tenancies.filter((t) => first(t).idx === 0 || new Set(t.sightings.map((s) => s.idx)).size >= 2);
    for (const t of tenancies) {
      if (confirmed.includes(t)) continue;
      const f = first(t);
      notes.push(f.idx === newestIdx
        ? { kind: 'commence-unconfirmed', propertyId, detail: `${propertyId} suite '${f.lease.suiteKey}' tenancy seen only in the newest capture (${caps[f.idx]!.asOf}); held` }
        : { kind: 'phantom-tenancy', propertyId, detail: `${propertyId} suite '${f.lease.suiteKey}' tenancy seen in one capture only (${caps[f.idx]!.asOf}); dropped` });
    }

    // RENEWALS: the same tenant's later lease in the suite it was last seen in, already listed beside it
    // or first listed by the next capture holding the property. A renewal starts and ends nothing: the
    // renewed tenancy emits no vacate, the renewal no commence.
    const renewed = new Set<Tenancy>();
    const renewal = new Set<Tenancy>();
    for (const t of confirmed) {
      const lt = last(t);
      const by = nextPresent(propertyId, lt.idx);
      const reach = by < 0 ? newestIdx : by;
      const tStart = startOf(t);
      for (const o of confirmed) {
        if (o === t || first(o).idx <= first(t).idx || first(o).idx > reach) continue;
        const os = startOf(o);
        if (first(o).lease.suiteKey !== lt.lease.suiteKey || first(o).lease.tenantKey !== lt.lease.tenantKey) continue;
        if (os === null || (tStart !== null && os <= tStart)) continue;
        renewed.add(t); renewal.add(o);
      }
    }

    // OCCUPANCY BOUND (refute round 6, wf_24523df2-4fd): a tenancy was on the rent roll from its first
    // sighting, so its commence is dated no later than that, whatever leaseStart is keyed later (a line
    // first listed with a blank start). It is null only for a tenancy first seen in the earliest capture
    // with no leaseStart: then nothing bounds when it began. Every commence is a LOWER bound.
    const occOf = (t: Tenancy): { date: string; basis: EventBasis } | null => {
      const start = startOf(t);
      const seenAt = caps[first(t).idx]!.asOf;
      if (start !== null && start <= seenAt) return { date: start, basis: 'lease_start' };
      if (start !== null) return { date: seenAt, basis: 'first_seen' };
      return first(t).idx === 0 ? null : { date: seenAt, basis: 'first_seen' };
    };

    for (const t of confirmed) {
      const f = first(t);
      const start = startOf(t);
      const occ = occOf(t);
      // Commence: dated the lease start when the tenancy was first listed on or after it, else its first
      // sighting (listed ahead of its start, or keyed with a blank start). A lease start after the newest
      // capture is not yet an event.
      if (occ !== null && start !== null && !renewal.has(t)) {
        const key = `c|${propertyId}|${f.lease.suiteKey}|${occ.date}`;
        if (start > newestAsOf) {
          notes.push({ kind: 'future-commence', propertyId, detail: `${propertyId} suite '${f.lease.suiteKey}' commences ${start}, after the newest capture (${newestAsOf}); not yet an event` });
        } else if (!seen.has(key)) {
          seen.add(key);
          rows.push({
            propertyId, suite: suiteOut(f.lease.suiteKey), tenant: last(t).lease.tenant, eventKind: 'commence',
            eventDate: occ.date, basis: occ.basis,
            sourceFile: `rent-roll ${caps[f.idx]!.asOf} [DERIVED:${occ.basis}]`, abstractDate: caps[f.idx]!.asOf,
          });
        }
      }

      // Vacate.
      const l = last(t);
      if (l.idx === newestIdx || renewed.has(t)) continue;
      const hiIdx = nextPresent(propertyId, l.idx);
      if (hiIdx < 0) {
        notes.push({ kind: 'property-gone', propertyId, detail: `${propertyId} has no leases in any capture after ${caps[l.idx]!.asOf}; no vacate derived` });
        continue;
      }
      let confirmedGone = false;
      for (let j = hiIdx + 1; j < caps.length; j++) if (propPresent(propertyId, j)) { confirmedGone = true; break; }
      if (!confirmedGone) {
        notes.push({ kind: 'vacate-unconfirmed', propertyId, detail: `${propertyId} suite '${l.lease.suiteKey}' missing only from the newest capture holding this property (${caps[hiIdx]!.asOf}); held` });
        continue;
      }
      const lo = caps[l.idx]!.asOf;
      const hi = caps[hiIdx]!.asOf;
      const leaseEnd = l.lease.leaseEnd;
      // The lease end dates the vacate only inside a TIGHT window (round 6): a holdover past it is unseen
      // there, so the date can be early by at most the window. A wider window is dated hi, an upper bound.
      const tight = dayDiff(lo, hi) <= LEASE_END_WINDOW_DAYS;
      let basis: EventBasis = tight && leaseEnd !== null && leaseEnd > lo && leaseEnd <= hi ? 'lease_end' : 'first_absent';
      let date = basis === 'lease_end' ? leaseEnd! : hi;

      // Clamp to S, the earliest occupancy bound of ANY other confirmed tenancy in this suite that began
      // after this one (round 6: a replacement listed beside the departing tenant counts too, so no vacate
      // is ever left dated after a later occupant's commence). Never back to an expired lease end before
      // the last sighting: a line listed past its lease end may be a month-to-month holdover (rounds 3-5:
      // wf_12470799-a63, wf_4d9846fe-f7c, wf_2a1ff182-4c1).
      // Only a REAL REPLACEMENT counts (round 7, wf_02d58977-4bc): one that emits a commence (same
      // predicate as the commence loop, so the clamped vacate always has a commence on S to pair with)
      // and is still listed after this tenancy's last sighting (a co-tenant that came and went earlier
      // never qualifies). With no occupancy bound of its own, only a tenancy first seen later counts.
      const tOcc = occ?.date ?? null;
      const S = confirmed
        .filter((o) => {
          if (o === t || renewal.has(o) || first(o).lease.suiteKey !== l.lease.suiteKey) return false;
          const os = startOf(o);
          if (os === null || os > newestAsOf || last(o).idx <= l.idx) return false;
          return tOcc !== null || first(o).idx > first(t).idx;
        })
        .map((o) => occOf(o)?.date ?? null)
        .filter((d): d is string => d !== null && (tOcc === null || d > tOcc))
        .sort()[0];
      if (S !== undefined && S < date) { date = S; basis = 'successor_start'; }
      if (tOcc !== null && date < tOcc) continue; // never vacate before the tenancy began
      const key = `v|${propertyId}|${l.lease.suiteKey}|${date}|${l.lease.tenantKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        propertyId, suite: suiteOut(l.lease.suiteKey), tenant: l.lease.tenant, eventKind: 'vacate',
        eventDate: date, basis,
        sourceFile: `rent-roll-diff ${lo} -> ${hi} [DERIVED:${basis}]`, abstractDate: hi,
      });
    }
  }

  return { rows, notes, captureDays };
}

export interface ReplaceResult {
  added: number; // rows in the new derivation that were not present before
  removed: number; // previously derived rows the new derivation no longer produces
  unchanged: number;
  rejected: number;
}

export class CaptureSetShrankError extends Error {}

const rowKey = (r: { property_id: string; suite: string | null; tenant: string | null; event_kind: string; event_date: string; source_file: string | null; abstract_date: string | null }): string =>
  [r.property_id, r.suite ?? '', r.tenant ?? '', r.event_kind, r.event_date, r.source_file ?? '', r.abstract_date ?? ''].join('|');

export interface ReplaceOptions {
  /** Capture days of this derivation. When given, a stored derived row from a day not in it refuses the run. */
  captureDays?: string[];
  allowShrink?: boolean;
}

/**
 * Replace every [DERIVED: row with `rows`, in one transaction. Per-row try/catch inside it. Throws
 * CaptureSetShrankError (writing nothing) when the stored rows came from capture days this set lacks.
 */
export function replaceDerivedLeaseEvents(db: WarehouseDb, rows: LeaseEventRow[], notes: DeriveNote[] = [], opts: ReplaceOptions = {}): ReplaceResult {
  const known = new Set((db.prepare('SELECT id FROM property_master').all() as { id: string }[]).map((r) => r.id));
  const like = `%${DERIVED_TAG}%`;
  const insert = db.prepare(`
    INSERT INTO lease_events (property_id, suite, tenant, event_kind, event_date, source_file, abstract_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const dqInsert = db.prepare("INSERT INTO data_quality_issues (property_id, kind, detail, severity) VALUES (?, ?, ?, 'warn')");
  const dqOpen = db.prepare("SELECT 1 FROM data_quality_issues WHERE property_id IS ? AND kind = ? AND detail = ? AND status = 'open'");
  // An identical open issue is not re-filed on every run.
  const dq = { run: (pid: string, kind: string, detail: string): void => { if (!dqOpen.get(pid, kind, detail)) dqInsert.run(pid, kind, detail); } };

  let rejected = 0;
  let before = new Set<string>();
  const after = new Set<string>();

  db.transaction(() => {
    const stored = db.prepare('SELECT property_id, suite, tenant, event_kind, event_date, source_file, abstract_date FROM lease_events WHERE source_file LIKE ?')
      .all(like) as Parameters<typeof rowKey>[0][];
    if (opts.captureDays !== undefined && !opts.allowShrink) {
      const have = new Set(opts.captureDays);
      const missing = [...new Set(stored.map((r) => r.abstract_date).filter((d): d is string => d !== null && !have.has(d)))].sort();
      if (missing.length > 0) {
        throw new CaptureSetShrankError(
          `refusing to replace: ${missing.length} capture day(s) already in lease_events are missing from this capture set `
          + `(${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}). Point --repo/--archive at the canonical history, `
          + 'or pass --allow-shrink if the loss is deliberate.',
        );
      }
    }
    before = new Set(stored.map(rowKey));
    db.prepare('DELETE FROM lease_events WHERE source_file LIKE ?').run(like);

    const unknownLogged = new Set<string>();
    for (const r of rows) {
      if (!known.has(r.propertyId)) {
        rejected += 1;
        if (!unknownLogged.has(r.propertyId)) {
          unknownLogged.add(r.propertyId);
          dq.run(r.propertyId, 'lease-event-unknown-property', `import-lease-events: property_id '${r.propertyId}' not in property_master; its lease events were skipped`);
        }
        continue;
      }
      try {
        insert.run(r.propertyId, r.suite, r.tenant, r.eventKind, r.eventDate, r.sourceFile, r.abstractDate);
        after.add(rowKey({ property_id: r.propertyId, suite: r.suite, tenant: r.tenant, event_kind: r.eventKind, event_date: r.eventDate, source_file: r.sourceFile, abstract_date: r.abstractDate }));
      } catch (e) {
        rejected += 1;
        dq.run(r.propertyId, 'lease-event-check-violation',
          `import-lease-events: ${r.eventKind} ${r.eventDate} (suite '${r.suite ?? ''}') was skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const n of notes) {
      if (n.kind === 'ambiguous-suite' && n.propertyId !== undefined && known.has(n.propertyId)) {
        dq.run(n.propertyId, 'lease-event-ambiguous-suite', `import-lease-events: ${n.detail}`);
      }
    }
  })();

  let unchanged = 0;
  for (const k of after) if (before.has(k)) unchanged += 1;
  return { added: after.size - unchanged, removed: before.size - unchanged, unchanged, rejected };
}

/** Derive + replace, for tests and the CLI. */
export function importLeaseEvents(db: WarehouseDb, captures: Capture[], opts: { allowShrink?: boolean } = {}): ReplaceResult & { notes: DeriveNote[]; derived: number } {
  const { rows, notes, captureDays } = deriveLeaseEvents(captures);
  return { ...replaceDerivedLeaseEvents(db, rows, notes, { captureDays, allowShrink: opts.allowShrink }), notes, derived: rows.length };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export interface CliArgs {
  snapshots: string[];
  repo: string | undefined;
  archive: string | undefined;
  db: string | undefined;
  allowShrink: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { snapshots: [], repo: undefined, archive: undefined, db: undefined, allowShrink: false, dryRun: false };
  const value = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`missing value for ${flag}`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--snapshot') { out.snapshots.push(value(i, a)); i += 1; }
    else if (a === '--db') { out.db = value(i, a); i += 1; }
    else if (a === '--repo') { out.repo = value(i, a); i += 1; }
    else if (a === '--archive') { out.archive = value(i, a); i += 1; }
    else if (a === '--allow-shrink') out.allowShrink = true;
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown argument '${a}'. Usage: npx tsx scripts/import-lease-events.ts [--snapshot <file>]... [--repo <dir>] [--archive <dir>] [--db <path>] [--allow-shrink] [--dry-run]`);
  }
  if (out.dryRun && (out.db !== undefined || out.allowShrink)) throw new Error('--dry-run is mutually exclusive with --db and --allow-shrink (a dry run opens no DB)');
  if (out.snapshots.length === 0) out.snapshots.push(join('data', 'snapshots', 'portfolio.json'));
  return out;
}

/** Every committed version of the snapshot, as (label, text). Real data: read locally, never printed. */
function readGitHistory(repo: string): Array<{ label: string; text: string }> {
  const shas = execFileSync('git', ['-C', repo, 'log', '--all', '--diff-filter=AM', '--format=%h', '--', SNAPSHOT_REPO_PATH], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  return shas.map((sha) => ({
    label: `git:${sha}`,
    text: execFileSync('git', ['-C', repo, 'show', `${sha}:${SNAPSHOT_REPO_PATH}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
  }));
}

function readArchive(dir: string): Array<{ label: string; text: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ label: `archive:${f}`, text: readFileSync(join(dir, f), 'utf8') }));
}

/** Archive name for a capture: the snapshot stem plus asOf and generatedAt, so the real-data scan recognises it. */
export function archiveName(c: Capture): string {
  return `portfolio_${c.asOf}_${(c.generatedAt || 'unknown').replace(/[^0-9A-Za-z]/g, '')}.json`;
}

function main(argv: string[]): number {
  let args: CliArgs;
  try { args = parseArgs(argv); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 1; }
  if (!args.dryRun) refuseIfSynthetic('import-lease-events');
  const archiveDir = args.archive ?? DEFAULT_ARCHIVE_DIR;

  const sources: Array<{ label: string; text: string }> = [];
  try {
    sources.push(...readGitHistory(args.repo ?? process.cwd()));
    sources.push(...readArchive(archiveDir));
    for (const p of args.snapshots) sources.push({ label: p, text: readFileSync(p, 'utf8') });
  } catch (e) {
    console.error(`import-lease-events: cannot read input: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const captures: Array<{ capture: Capture; text: string }> = [];
  let unreadable = 0;
  for (const s of sources) {
    let payload: unknown;
    try { payload = JSON.parse(s.text); }
    catch { console.error(`  ${s.label}: not JSON, skipped`); unreadable += 1; continue; }
    const res = captureFromSnapshot(payload, s.label);
    if ('error' in res) { console.error(`  ${res.error}, skipped`); unreadable += 1; continue; }
    captures.push({ capture: res.capture, text: s.text });
  }
  if (captures.length < 2) { console.error(`import-lease-events: ${captures.length} readable capture(s); a diff needs at least 2`); return 1; }

  let derived: ReturnType<typeof deriveLeaseEvents>;
  try { derived = deriveLeaseEvents(captures.map((c) => c.capture)); }
  catch (e) { console.error(`import-lease-events: ${e instanceof Error ? e.message : String(e)}`); return 1; }
  const v = derived.rows.filter((r) => r.eventKind === 'vacate').length;
  const summary = `${derived.captureDays.length} capture day(s), ${derived.rows.length} event(s) derived (${derived.rows.length - v} commence, ${v} vacate)`;

  if (args.dryRun) {
    console.log(`import-lease-events (dry-run): ${summary}`);
    console.log(`  ${unreadable} unreadable capture(s); notes: ${summariseNotes(derived.notes)}`);
    return 0;
  }

  const dbPath = args.db ?? process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
  let db: WarehouseDb;
  // Never the schema migrator (tests/unit/warehouse-open-sites.test.ts).
  try { db = openWarehouseNoMigrate(dbPath); }
  catch (e) { console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`); return 1; }
  try {
    const r = replaceDerivedLeaseEvents(db, derived.rows, derived.notes, { captureDays: derived.captureDays, allowShrink: args.allowShrink });
    console.log(`import-lease-events: ${r.added} added, ${r.removed} removed, ${r.unchanged} unchanged, ${r.rejected} rejected; ${summary}`);
    console.log(`  ${unreadable} unreadable capture(s); notes: ${summariseNotes(derived.notes)}`);
  } catch (e) {
    console.error(`import-lease-events: ${e instanceof CaptureSetShrankError ? '' : 'database error: '}${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }

  // Archive every readable capture after a successful import, so the series no longer depends on git refs.
  try {
    mkdirSync(archiveDir, { recursive: true });
    let written = 0;
    for (const { capture, text } of captures) {
      const target = join(archiveDir, archiveName(capture));
      if (!existsSync(target)) { writeFileSync(target, text); written += 1; }
    }
    if (written > 0) console.log(`  archived ${written} capture(s) in ${archiveDir}`);
  } catch (e) {
    console.error(`import-lease-events: imported, but archiving captures failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return 0;
}

function summariseNotes(notes: DeriveNote[]): string {
  if (notes.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const n of notes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${k}`).join(', ');
}

// Run the CLI only when invoked directly: importing for tests must never open a db or write.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/import-lease-events.ts')) {
  process.exit(main(process.argv.slice(2)));
}
