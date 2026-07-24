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
 *  server/ar/match-tenant.ts's own LeaseLite (different shape) to avoid a same-name mixup. */
interface DriftLeaseView { id: string; tenantName: string; company: string | null; leaseEnd: string | null; annualRent: number; }

/** loadPrevious's result distinguishes a normal "no snapshot yet" first-run state (`corrupt: false`,
 *  `leases: []`) from a genuinely CORRUPT previous file (`corrupt: true`) -- Round-3 REFUTE: these
 *  used to be conflated (both mapped to `[]`), which silently disarmed the anomaly-refusal floor
 *  below (gated on `previous.length > 0`) whenever the previous snapshot happened to be corrupt, and
 *  the newly (possibly bad) written snapshot became the new "previous" with its own small/zero
 *  count -- permanently disarming the floor going forward. */
interface PreviousSnapshot { leases: DriftLeaseView[]; corrupt: boolean; }

function loadPrevious(): PreviousSnapshot {
  if (!existsSync(SNAPSHOT_PATH)) return { leases: [], corrupt: false }; // normal first-run state, not corruption
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
    if (!Array.isArray(parsed?.leases)) {
      console.error(`✗ ${SNAPSHOT_PATH} parsed but has no "leases" array.`);
      return { leases: [], corrupt: true };
    }
    return { leases: parsed.leases, corrupt: false };
  } catch (err) {
    // A truncated/corrupt snapshot (a known OneDrive-sync hazard here) is a genuine corruption, not
    // an empty baseline -- see the main() handling below (refuses to write, leaving the corrupt file
    // exactly where it is).
    console.error(`✗ failed to parse ${SNAPSHOT_PATH} (${(err as Error).message}).`);
    return { leases: [], corrupt: true };
  }
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

  const currentIds = new Set(current.map((l) => l.id));
  const removedIds = previous.filter((l) => !currentIds.has(l.id));

  const newIds = current.filter((l) => !prevById.has(l.id));
  const changedDates = current.filter((l) => {
    const prev = prevById.get(l.id);
    return prev && prev.leaseEnd !== l.leaseEnd;
  });

  // Refuse to overwrite a known-good snapshot with an EMPTY one: unconditional, regardless of
  // `previous.length` (Round-3 REFUTE -- previously this was gated on `previous.length > 0`, so
  // whenever the previous snapshot was corrupt/missing -- now handled above, but a fresh/legitimate
  // 0-lease previous state reaches here too -- this refusal was bypassed entirely and ANY current
  // parse result, including a genuinely broken 0-lease parse, wrote through unguarded at exit 0). A
  // workbook that genuinely has zero leases is not a realistic scenario for this portfolio, so
  // refusing and requiring --force is the safe default.
  if (current.length === 0) {
    if (!force) {
      console.error(
        `✗ Refusing to write ${SNAPSHOT_PATH}: this parse produced 0 leases (previous snapshot had ${previous.length}) -- this looks like a bad parse, not a genuine full portfolio wind-down. portfolio.json was NOT modified. Re-run with --force if this is a real, intentional event.`,
      );
      process.exit(1);
    }
    console.warn(`⚠ --force: proceeding despite a 0-lease current parse (previous snapshot had ${previous.length}).`);
  }

  // Refuse to overwrite a known-good snapshot with a suspiciously small one: a parse that goes wrong
  // for a reason OTHER than genuine lease removal (workbook read mid-save, a renamed/missing
  // worksheet section, a wrong WORKBOOK_PATH resolving to the wrong file) must not silently replace
  // real data, get a fresh meta.generatedAt stamp, and have this branch's OWN staleness guard vouch
  // for it as "fresh". Fraction is of the OLD (previous) set that vanished -- removedIds.length /
  // previous.length -- not some other ratio. Gated on `current.length > 0` because the
  // current.length === 0 case is fully handled by the unconditional check above already.
  if (previous.length > 0 && current.length > 0) {
    const removedFraction = removedIds.length / previous.length;
    const anomalous = removedFraction > 0.25;
    if (anomalous && !force) {
      console.error(
        `✗ Refusing to write ${SNAPSHOT_PATH}: previous snapshot had ${previous.length} lease(s), this parse produced ${current.length}, ` +
          `${removedIds.length} (${(removedFraction * 100).toFixed(1)}%) would be removed -- this looks like a bad parse, not a genuine mass ` +
          `disposition. portfolio.json was NOT modified. Re-run with --force if this is a real, intentional mass-disposition event.`,
      );
      process.exit(1);
    }
    if (anomalous && force) {
      console.warn(
        `⚠ --force: proceeding despite ${removedIds.length}/${previous.length} (${(removedFraction * 100).toFixed(1)}%) leases removed (current count ${current.length}).`,
      );
    }
  }

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  // Atomic write (temp file + rename), same pattern as scripts/ar-import-headless.ts's
  // patchSnapshot(): a crash mid-write must not leave portfolio.json truncated for the next reader
  // (the daily brief's collections section, server/brain.ts's loadFallback() after a server restart).
  const tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(enriched, null, 2));
  renameSync(tmp, SNAPSHOT_PATH);

  if (newIds.length === 0 && changedDates.length === 0 && removedIds.length === 0) {
    console.log(`✓ No lease drift. portfolio.json regenerated (${current.length} leases).`);
    process.exit(0);
  }

  console.log(`⚠ Lease drift detected — portfolio.json regenerated (${current.length} leases).`);
  if (newIds.length) {
    console.log(`\nNew/changed-id leases (${newIds.length}):`);
    for (const l of newIds) console.log(`  ${l.id} | ${l.company ?? l.tenantName} | end: ${l.leaseEnd}`);
  }
  if (changedDates.length) {
    console.log(`\nLease end date changes (${changedDates.length}):`);
    for (const l of changedDates) {
      const prev = prevById.get(l.id)!;
      console.log(`  ${l.id} | ${l.company ?? l.tenantName} | ${prev.leaseEnd} -> ${l.leaseEnd}`);
    }
  }
  if (removedIds.length) {
    console.log(`\nRemoved leases (${removedIds.length}):`);
    for (const l of removedIds) console.log(`  ${l.id} | ${l.company ?? l.tenantName} | was end: ${l.leaseEnd}`);
  }
  // Distinguish "ran, found drift worth a look" (2) from "ran clean" (0) and "refused to write" (1)
  // above, so an unattended scheduler can tell these apart instead of every run exiting 0.
  process.exit(2);
}

main().catch((err) => {
  console.error('drift check failed:', err);
  process.exit(3);
});
