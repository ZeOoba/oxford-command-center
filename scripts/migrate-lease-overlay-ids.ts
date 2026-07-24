// scripts/migrate-lease-overlay-ids.ts
//
// One-time migration: server/workbook/parse.ts's lease.id scheme changed from
// `slug-slug-{rowNumber}` to a stable `slug-slug` (disambiguated only on genuine collision).
// Any data/overlay.json entry keyed by a lease id under the OLD scheme is now orphaned.
// This script re-parses the live workbook (new scheme), strips any trailing `-{digits}` from
// each OLD overlay key, and remaps it to the live lease whose id starts with that stripped
// base — printing what it would change. Run with --apply to write data/overlay.json.
//
// Usage: npx tsx scripts/migrate-lease-overlay-ids.ts [--apply]
import { existsSync, readFileSync } from 'node:fs';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath } from '../server/config';
import { loadOverlay, saveOverlay, overlayPath } from '../server/overlay';

loadEnvFile();

/**
 * Resolve one old-scheme key's stripped base against the live id set.
 *  - Exact match wins outright, even if some OTHER live id also happens to start with
 *    `${strippedBase}-` (Bug C1: a single `find(id === x || id.startsWith(...))` let Set
 *    iteration order decide whether a prefix match could beat an exact match).
 *  - Only when there is NO exact match do we fall back to prefix matches; more than one
 *    candidate there is a genuine ambiguity, not a match.
 */
export function resolveLiveId(
  strippedBase: string,
  liveIds: ReadonlySet<string>,
): { kind: 'exact' | 'prefix'; id: string } | { kind: 'none' } | { kind: 'ambiguous'; candidates: string[] } {
  if (liveIds.has(strippedBase)) return { kind: 'exact', id: strippedBase };
  // .sort() -- Round-3 REFUTE (LOW): `prefixMatches` is built from a Set, which preserves insertion
  // (worksheet row) order, so an unsorted candidates array made the `ambiguous` warning text (and
  // this single-match `prefix` id, moot with only one element but sorted for consistency) vary
  // across runs if the worksheet were re-sorted, even though the underlying refuse-it-as-ambiguous
  // DECISION never changes. Purely cosmetic (dry-run diff noise), but this file's own stated goal is
  // determinism.
  const prefixMatches = [...liveIds].filter((id) => id.startsWith(`${strippedBase}-`)).sort();
  if (prefixMatches.length === 0) return { kind: 'none' };
  if (prefixMatches.length === 1) return { kind: 'prefix', id: prefixMatches[0]! };
  return { kind: 'ambiguous', candidates: prefixMatches };
}

export interface MarketRentsPartition {
  /** Keys to feed into planMigration -- NOT currently a valid live-propertyKey-keyed entry. */
  forMigration: Record<string, unknown>;
  /** Keys that already exactly match a live lease's RAW propertyKey -- valid as-is per the
   *  documented mixed-key contract, never fed to planMigration / never migrated. */
  validPropertyKeyed: string[];
}

/**
 * `overlay.marketRents` is a MIXED-key domain BY DESIGN (see server/overlay.ts's Overlay.marketRents
 * doc comment: "Keyed by leaseId (precedence) or propertyKey"). The only application write path
 * (server/brain.ts's setMarketRent) writes keys as the RAW `propertyKey` string (never a lease id),
 * and the read path (src/analytics/lease-forecast.ts) does `marketRents[l.id] ?? marketRents[l.propertyKey]`.
 * Round-3 REFUTE (2 independent reviewers): planMigration was previously run over the ENTIRE
 * marketRents map with `liveIds` = lease ids only, so every legitimate, currently-correct
 * propertyKey-keyed entry was misdiagnosed as an orphaned old-scheme key needing "manual review" (a
 * raw propertyKey like "1100 Rarig Ave" -> `kind: 'none'`; a slug-shaped or digit-suffixed
 * propertyKey could even prefix-match some lease and warn "ambiguous"). An operator following the
 * tool's own "needs manual review" instruction could then manually remap a correct property-level
 * fallback rent onto one specific lease -- silently removing the market-rent fallback for every
 * OTHER lease at that property.
 *
 * This partitions marketRents' keys BEFORE planMigration ever sees them: any key that exactly
 * equals a live lease's RAW propertyKey is valid-as-is and excluded entirely from migration
 * planning. Only the remaining keys (genuinely not a live propertyKey) go through the normal
 * old-scheme-key resolution. renewalStages/tenantArrears are genuinely lease-id-only domains and
 * are unaffected -- this partitioning is scoped to marketRents alone.
 */
export function partitionMarketRents(
  marketRents: Record<string, unknown>,
  livePropertyKeys: ReadonlySet<string>,
): MarketRentsPartition {
  const forMigration: Record<string, unknown> = {};
  const validPropertyKeyed: string[] = [];
  for (const key of Object.keys(marketRents).sort()) {
    if (livePropertyKeys.has(key)) validPropertyKeyed.push(key);
    else forMigration[key] = marketRents[key];
  }
  return { forMigration, validPropertyKeyed };
}

export interface MigrationPlanItem {
  oldKey: string;
  newKey: string;
}
export interface MigrationWarning {
  oldKey: string;
  reason: string;
}
export interface MigrationPlan {
  toMigrate: MigrationPlanItem[];
  toWarn: MigrationWarning[];
}

/**
 * Pure, order-independent planner for ONE overlay domain map (renewalStages / tenantArrears /
 * marketRents all share this shape: leaseId-keyed). Round-2 REFUTE (3 independent reviewers, plus
 * 2 more on a determinism/prefix follow-up) found the original single-pass "first old key wins"
 * loop unsafe on several fronts; this two-pass design (resolve every key's disposition FIRST, THEN
 * decide) is what makes all five required invariants hold simultaneously:
 *
 *  1. No overwrite of ANY pre-existing overlay entry — a target that is already a key in
 *     `existingKeysMap` (regardless of WHY it's there — plain live-valid data, or a key the
 *     invariant-4 check below flagged as an ambiguous collision-cluster coincidence) is NEVER a
 *     migration destination, solo claimant or not (see the `hasOwnProperty(existingKeysMap, target)`
 *     branch below). This is checked directly against `existingKeysMap` (which defaults to
 *     `oldKeysMap` itself, but see the `existingKeysMap` doc below for why marketRents needs a
 *     different map here), not a derived subset — a derived "live-valid" set that deliberately
 *     excludes invariant-4-flagged keys (so they get their OWN ambiguity warning) must never be
 *     reused as "the set of destinations safe to overwrite", or those very keys lose overwrite
 *     protection precisely because they were flagged. See Defect 1 in
 *     docs/superpowers/sdd/refute-fix-3-report.md for the concrete collision this closes.
 *  2. Symmetric refusal on multi-claimant targets — 2+ old keys resolving to the same target are
 *     ALL refused, each warning naming the full set of competing claimants.
 *  3. Only an EXACT resolveLiveId match is ever eligible to migrate — a `prefix` resolution always
 *     warns (a prefix match on a legacy, pre-tenant-aware key can't rule out suite turnover).
 *  4. An old key that's already a live id but whose shape (`-\d+` suffix) AND stripped base being
 *     ALSO live puts it inside a genuine collision cluster is treated as ambiguous, not
 *     "already correct".
 *  5. Determinism — every key is visited in sorted order, every grouping/decision keys off the
 *     RESOLVED TARGET (not visit order), and every claimant list is sorted before use, so permuting
 *     `oldKeysMap`'s on-disk key order can never change which entries migrate or which are refused.
 *
 * Note on invariant 1 never over-refusing: a migration target (`resolved.kind === 'exact'`) is by
 * construction always a live id (`liveIds.has(target)` is what "exact" means), while every
 * `exactClaimants` SOURCE is by construction NOT live (only oldKeys that fail the
 * `liveIds.has(oldKey)` check below ever reach `resolveLiveId`). A live string and a non-live string
 * can never be the same string, so a target can never equal one of the old keys migrating away in
 * this same pass — the `hasOwnProperty` check below can therefore never wrongly block a key from
 * landing on its own, legitimately-vacated former slot; that case is structurally impossible here.
 *
 * Never mutates `oldKeysMap`, `liveIds`, or `existingKeysMap` — callers apply `toMigrate`
 * themselves (see main()).
 *
 * `existingKeysMap` (Round-4 REFUTE, Defect 3) is the map the invariant-1 overwrite guard checks
 * for "does something already live at this target key" — defaults to `oldKeysMap` itself, which is
 * correct for renewalStages/tenantArrears (planned and applied against the SAME map) but NOT for
 * marketRents: main() calls this with `oldKeysMap` set to `partitionMarketRents`'s `forMigration`
 * subset (propertyKey-keyed entries already filtered out), while the actual apply step in main()
 * mutates the FULL original overlay.marketRents map (which still has those propertyKey-keyed
 * entries). If the guard read `oldKeysMap` in that case, a migration target that happens to
 * coincide with a propertyKey-keyed entry (invisible to the guard, since it was partitioned out)
 * could be silently overwritten by the apply step despite the guard existing specifically to
 * prevent that. Passing the FULL map as `existingKeysMap` keeps the guard's view of "what already
 * exists at this key" consistent with the apply step's view of the same map, for every domain.
 */
export function planMigration(
  oldKeysMap: Record<string, unknown>,
  liveIds: ReadonlySet<string>,
  existingKeysMap: Record<string, unknown> = oldKeysMap,
): MigrationPlan {
  const toWarn: MigrationWarning[] = [];
  // target newKey -> old keys that resolved to it via an EXACT match. Only exact-kind resolutions
  // are ever eligible to auto-migrate (Invariant 3), so only they compete for a target here.
  const exactClaimants = new Map<string, string[]>();

  for (const oldKey of Object.keys(oldKeysMap).sort()) {
    if (liveIds.has(oldKey)) {
      // Invariant 4: an old row-suffixed key can coincidentally equal a live disambiguated id.
      // Only genuinely ambiguous when oldKey's own shape could be EITHER an old row-suffix OR a new
      // disambiguation suffix (ends in `-\d+`) AND its stripped base is ALSO live — the signature of
      // a real collision cluster (disambiguateLeaseIds), where "oldKey is live" does not prove it's
      // attached to the SAME physical lease the overlay entry was originally recorded for.
      const strippedBase = oldKey.replace(/-\d+$/, '');
      if (/-\d+$/.test(oldKey) && liveIds.has(strippedBase)) {
        toWarn.push({
          oldKey,
          reason: `"${oldKey}" is already a live id, but it ends in a numeric suffix and its base "${strippedBase}" is ALSO live — this is the shape of a genuine collision cluster, so being live does not prove "${oldKey}" is attached to the correct physical lease — left as-is, needs manual review`,
        });
      }
      // Else: unambiguously already correct — a genuine no-op. Nothing to add to any tracking set;
      // Invariant 1's overwrite guard below checks `existingKeysMap` directly (this key is already
      // IN it), so this key stays protected as a migration destination without needing its own set.
      continue;
    }
    const strippedBase = oldKey.replace(/-\d+$/, '');
    const resolved = resolveLiveId(strippedBase, liveIds);
    if (resolved.kind === 'none') {
      toWarn.push({ oldKey, reason: `no live lease matches old key "${oldKey}" (stripped base "${strippedBase}") — left as-is, needs manual review` });
      continue;
    }
    if (resolved.kind === 'ambiguous') {
      toWarn.push({
        oldKey,
        reason: `old key "${oldKey}" (stripped base "${strippedBase}") matches multiple live leases [${resolved.candidates.join(', ')}] — ambiguous, left as-is, needs manual review`,
      });
      continue;
    }
    if (resolved.kind === 'prefix') {
      // Invariant 3: never auto-applied, even though it resolves to exactly one live id — a prefix
      // match on a legacy key can't distinguish "same tenant, unit still occupied" from "different
      // tenant now occupies the same unit" (suite turnover between when the overlay entry was
      // written and when this migration runs).
      toWarn.push({
        oldKey,
        reason: `old key "${oldKey}" (stripped base "${strippedBase}") resolves only via a PREFIX match to "${resolved.id}" — a prefix match cannot rule out suite turnover (a different tenant may now occupy that unit); never auto-applied, left as-is, needs manual review`,
      });
      continue;
    }
    // kind === 'exact' — a genuine migration candidate. Don't decide yet; group by target first.
    const list = exactClaimants.get(resolved.id);
    if (list) list.push(oldKey);
    else exactClaimants.set(resolved.id, [oldKey]);
  }

  const toMigrate: MigrationPlanItem[] = [];
  for (const target of [...exactClaimants.keys()].sort()) {
    const claimants = [...exactClaimants.get(target)!].sort();
    if (Object.prototype.hasOwnProperty.call(existingKeysMap, target)) {
      // Invariant 1: NOTHING overwrites a pre-existing overlay entry — not a solo claimant, not any
      // of a multi-claimant group. Checked against `existingKeysMap` (defaults to `oldKeysMap`, but
      // see the planMigration doc comment above for why marketRents passes the FULL map here, not
      // the partitioned subset) so this also protects keys the invariant-4 check above flagged as
      // ambiguous — those keys were deliberately excluded from a "silently fine" bucket precisely
      // because they need their OWN review, which means they need overwrite protection MORE, not
      // less. (Not `liveIds.has(target)` — that's true for every exact match and would refuse ALL of
      // them; see the planMigration doc comment above for why this specific check can never
      // over-refuse.)
      for (const oldKey of claimants) {
        const others = claimants.filter((k) => k !== oldKey);
        toWarn.push({
          oldKey,
          reason: `old key "${oldKey}" resolves (exact) to "${target}", which already has an existing overlay entry — auto-migrating would silently overwrite it — left as-is, needs manual review${others.length ? ` (also contested by: ${others.join(', ')})` : ''}`,
        });
      }
      continue;
    }
    if (claimants.length === 1) {
      toMigrate.push({ oldKey: claimants[0]!, newKey: target });
      continue;
    }
    // Invariant 2: 2+ distinct old keys resolve to the SAME (not-yet-live) target — none auto-apply;
    // each warning names the shared target and the FULL set of competing claimants.
    for (const oldKey of claimants) {
      const others = claimants.filter((k) => k !== oldKey);
      toWarn.push({
        oldKey,
        reason: `old key "${oldKey}" resolves (exact) to "${target}", which is ALSO claimed by old key(s) [${others.join(', ')}] in this run — ambiguous multi-claimant target, NONE auto-migrated, left as-is, needs manual review`,
      });
    }
  }

  toWarn.sort((a, b) => (a.oldKey < b.oldKey ? -1 : a.oldKey > b.oldKey ? 1 : 0));
  toMigrate.sort((a, b) => (a.oldKey < b.oldKey ? -1 : a.oldKey > b.oldKey ? 1 : 0));
  return { toMigrate, toWarn };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { snapshot } = await parseWorkbook(workbookPath());
  const liveIds = new Set(snapshot.leases.map((l) => l.id));
  const livePropertyKeys = new Set(snapshot.leases.map((l) => l.propertyKey));

  // Round-5 REFUTE (4th copy of this guard -- see the identical checks in extract-workbook.ts,
  // lease-snapshot-drift-check.ts, and ar-import-headless.ts): loadOverlay() fails OPEN to an
  // empty overlay on corrupt/wrong-shape JSON. A total-shape corruption is inert here (every
  // domain empties, nothing migrates, saveOverlay never fires) -- but a --apply run also writes
  // the FULL overlay object back once ANY domain has a legitimate migration, so a corrupt
  // overlay.json read successfully as {} would silently commit the loss of every OTHER domain's
  // data. Refuse loudly up front rather than rely on that inertness.
  const rawOverlayPath = overlayPath();
  if (existsSync(rawOverlayPath)) {
    try {
      const parsedOverlay: unknown = JSON.parse(readFileSync(rawOverlayPath, 'utf8'));
      if (!parsedOverlay || typeof parsedOverlay !== 'object' || Array.isArray(parsedOverlay)) {
        console.error(`✗ ${rawOverlayPath} is valid JSON but not a valid overlay object — refusing to run (would risk committing data loss on --apply). Fix or restore it first.`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`✗ ${rawOverlayPath} is corrupt/unparseable — refusing to run (would risk committing data loss on --apply). Fix or restore it first. (${e instanceof Error ? e.message : String(e)})`);
      process.exit(1);
    }
  }

  const overlay = loadOverlay();
  let changed = false;

  // marketRents is leaseId-keyed too (with precedence over propertyKey — see server/overlay.ts /
  // src/analytics/lease-forecast.ts) — an old-scheme entry there orphans silently if omitted here.
  // It is ALSO propertyKey-keyed (see partitionMarketRents' doc comment above) — those entries are
  // partitioned out below and never fed to planMigration, so they're never misdiagnosed as orphaned.
  for (const domain of ['renewalStages', 'tenantArrears', 'marketRents'] as const) {
    const map = overlay[domain] as Record<string, unknown>;
    let planInput = map;
    if (domain === 'marketRents') {
      const { forMigration, validPropertyKeyed } = partitionMarketRents(map, livePropertyKeys);
      for (const key of validPropertyKeyed) console.log(`[marketRents] "${key}" is a propertyKey-keyed entry — valid as-is, not migrated`);
      planInput = forMigration;
    }
    // Round-4 REFUTE Defect 3: pass `map` (the FULL original overlay[domain] map, the same one the
    // apply step below mutates) as the overwrite-check's `existingKeysMap` — for renewalStages/
    // tenantArrears this equals `planInput` (no partitioning happens) so it's a no-op change; for
    // marketRents, `planInput` is the partitioned `forMigration` subset while `map` still includes
    // the propertyKey-keyed entries partitioned out above, so the guard's view of "what already
    // exists at this key" now matches what the apply step below actually sees.
    const plan = planMigration(planInput, liveIds, map);
    for (const w of plan.toWarn) console.warn(`[${domain}] ${w.reason}`);
    for (const { oldKey, newKey } of plan.toMigrate) {
      console.log(`[${domain}] "${oldKey}" -> "${newKey}"`);
      if (apply) {
        map[newKey] = map[oldKey];
        delete map[oldKey];
        changed = true;
      }
    }
  }

  if (apply && changed) {
    const ok = await saveOverlay(overlay);
    if (!ok) {
      console.error('✗ overlay.json write FAILED — see server/overlay.ts saveOverlay for the swallowed error detail. Migration NOT applied; re-run after resolving the write failure.');
      process.exit(1);
    }
    console.log('overlay.json updated.');
  } else if (!apply) {
    console.log('\nDry run only — re-run with --apply to write changes.');
  } else {
    console.log('No changes needed.');
  }
}

// Run the CLI only when invoked directly (importing for tests — e.g. planMigration/resolveLiveId —
// must NOT parse the live workbook, touch overlay.json, or exit the test process).
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/migrate-lease-overlay-ids.ts')) {
  main().catch((err) => {
    console.error('migration failed:', err);
    process.exit(1);
  });
}
