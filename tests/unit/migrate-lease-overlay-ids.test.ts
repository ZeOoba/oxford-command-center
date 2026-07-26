// tests/unit/migrate-lease-overlay-ids.test.ts
//
// Round-2 REFUTE (defects G/H/I/L) found the original single-pass "first old key wins" loop in
// scripts/migrate-lease-overlay-ids.ts unsafe: it could silently overwrite a fresh live-valid
// overlay entry with a stale value, let JSON key order decide which of two competing old keys
// "wins" a shared target, auto-apply a prefix match that can misattach a departed tenant's data
// on suite turnover, and treat a coincidental old-key/live-id string match as proof of correctness.
//
// planMigration() is the pure, two-pass replacement extracted so this logic is unit-testable
// without parsing the live workbook or touching overlay.json (importing this module used to run
// main() at module load — see the entrypoint guard at the bottom of the script under test).
import { describe, expect, it } from 'vitest';
import { partitionMarketRents, planMigration, resolveLiveId } from '../../scripts/migrate-lease-overlay-ids';

describe('planMigration — invariant 1: no overwrite of a live-valid entry', () => {
  it('a live-valid key with data is left untouched when a separate old key resolves (exact) onto it', () => {
    // overlay has a FRESH entry at "prop-acme" (written by the server after this branch deployed)
    // AND a stale old-scheme key "prop-acme-3" whose stripped base "prop-acme" exactly matches the
    // same live id. Pre-fix, the stale key's remap would execute with zero warning and clobber the
    // fresh entry.
    const overlay = { 'prop-acme': { stage: 'Renewal Sent (fresh)' }, 'prop-acme-3': { stage: 'stale value' } };
    const liveIds = new Set(['prop-acme', 'prop-other']);
    const plan = planMigration(overlay, liveIds);
    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toWarn).toHaveLength(1);
    expect(plan.toWarn[0]!.oldKey).toBe('prop-acme-3');
    expect(plan.toWarn[0]!.reason).toMatch(/already has an existing overlay entry/);
    // The live-valid entry's data is provably unchanged: the caller only ever mutates keys named in
    // toMigrate, and "prop-acme" never appears there.
    expect(plan.toMigrate.some((m) => m.newKey === 'prop-acme')).toBe(false);
    expect(overlay['prop-acme'].stage).toBe('Renewal Sent (fresh)');
  });
});

describe('planMigration — invariant 2: symmetric refusal on multi-claimant targets', () => {
  it('two different old keys resolving to the same not-yet-live target are BOTH refused, each naming the other', () => {
    // Two legacy row-suffixed keys ("prop-beta-1", "prop-beta-2") both strip to the SAME base
    // "prop-beta", which is itself live but not yet claimed by any prior migration -- an exact
    // match, so both are genuine migration candidates racing for the same target.
    const overlay = { 'prop-beta-1': { note: 'a' }, 'prop-beta-2': { note: 'b' } };
    const liveIds = new Set(['prop-beta']);
    const plan = planMigration(overlay, liveIds);
    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toWarn).toHaveLength(2);
    const byKey = new Map(plan.toWarn.map((w) => [w.oldKey, w.reason]));
    expect(byKey.get('prop-beta-1')).toMatch(/ALSO claimed by old key\(s\) \[prop-beta-2\]/);
    expect(byKey.get('prop-beta-2')).toMatch(/ALSO claimed by old key\(s\) \[prop-beta-1\]/);
  });
});

describe('planMigration — invariant 3: a prefix-kind resolution is never auto-applied', () => {
  it('an old key resolving via prefix to exactly one live id is warned, not migrated', () => {
    const overlay = { 'prop-gamma-1': { note: 'legacy' } };
    // "prop-gamma-1".replace(/-\d+$/, '') -> "prop-gamma"; no exact live id "prop-gamma", but
    // exactly one live id starts with "prop-gamma-": a prefix match.
    const liveIds = new Set(['prop-gamma-newtenant']);
    const resolved = resolveLiveId('prop-gamma', liveIds);
    expect(resolved.kind).toBe('prefix'); // precondition
    const plan = planMigration(overlay, liveIds);
    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toWarn).toHaveLength(1);
    expect(plan.toWarn[0]!.reason).toMatch(/PREFIX match/);
    expect(plan.toWarn[0]!.reason).toMatch(/suite turnover/);
  });
});

describe('planMigration — invariant 4: old-key/live-id coincidence in a genuine collision cluster is ambiguous', () => {
  it('an old key that equals a live disambiguated id, whose base is ALSO live, is flagged ambiguous (not accepted)', () => {
    // "x-2" is itself live (a real disambiguated lease), AND "x" (its stripped base) is ALSO live --
    // the signature of a genuine 2-lease collision cluster. "x-2" being live does NOT prove the old
    // overlay entry keyed "x-2" was recorded for the SAME physical lease that ended up owning it.
    const overlay = { 'x-2': { note: 'ambiguous coincidence' } };
    const liveIds = new Set(['x', 'x-2']);
    const plan = planMigration(overlay, liveIds);
    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toWarn).toHaveLength(1);
    expect(plan.toWarn[0]!.oldKey).toBe('x-2');
    expect(plan.toWarn[0]!.reason).toMatch(/collision cluster/);
  });

  it('a live id NOT part of any collision cluster (no live base) is silently accepted (no warning, no migration)', () => {
    // Contrast case: "prop-unit-3" is live and its stripped base "prop-unit" is NOT live -- no
    // collision cluster is possible, so this is genuinely already-correct.
    const overlay = { 'prop-unit-3': { note: 'genuinely fine' } };
    const liveIds = new Set(['prop-unit-3']);
    const plan = planMigration(overlay, liveIds);
    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toWarn).toHaveLength(0);
  });
});

describe('planMigration — Defect 1 fix: overwrite-protection covers invariant-4-flagged targets too', () => {
  it('a separate old key that exact-matches an invariant-4-ambiguous key is refused, not silently migrated', () => {
    // liveIds = {'x', 'x-2'} is a genuine collision cluster. The overlay holds BOTH 'x-2' (itself
    // live, and flagged invariant-4-ambiguous because it ends in '-2' and its stripped base 'x' is
    // ALSO live) holding FRESH data, AND a separate old-scheme key 'x-2-7' (not live, strips to
    // 'x-2') holding STALE data. Pre-fix, 'x-2' was excluded from `liveValidOverlayKeys` (it got its
    // own invariant-4 warning instead), so the Invariant-1 overwrite guard never fired for 'x-2-7',
    // and its stale data would silently clobber 'x-2's fresh data via an ordinary-looking migration
    // line with no warning about the overwrite itself.
    const FRESH_DATA = { note: 'FRESH — the real, currently-valid entry for the collision-winner lease' };
    const STALE_DATA = { note: 'STALE — an orphaned old-scheme entry that must never land here' };
    const overlay: Record<string, unknown> = { 'x-2': FRESH_DATA, 'x-2-7': STALE_DATA };
    const liveIds = new Set(['x', 'x-2']);

    const plan = planMigration(overlay, liveIds);

    // 'x-2' itself still gets its own invariant-4 ambiguity warning.
    // 'x-2-7' must be warned/skipped, NEVER migrated.
    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toMigrate.some((m) => m.newKey === 'x-2')).toBe(false);
    const warnedKeys = plan.toWarn.map((w) => w.oldKey).sort();
    expect(warnedKeys).toEqual(['x-2', 'x-2-7']);
    const byKey = new Map(plan.toWarn.map((w) => [w.oldKey, w.reason]));
    expect(byKey.get('x-2')).toMatch(/collision cluster/);
    expect(byKey.get('x-2-7')).toMatch(/already has an existing overlay entry/);

    // Simulate applying the plan to a copy of the map, exactly as main() does: mutate only keys
    // named in toMigrate. Since toMigrate is empty here, the map must be byte-for-byte unchanged,
    // and in particular 'x-2' must still hold FRESH_DATA, not STALE_DATA.
    const applied = { ...overlay };
    for (const { oldKey, newKey } of plan.toMigrate) {
      applied[newKey] = applied[oldKey];
      delete applied[oldKey];
    }
    expect(applied['x-2']).toBe(FRESH_DATA);
    expect(applied['x-2']).not.toBe(STALE_DATA);
  });
});

describe('planMigration — invariant 5: determinism under key-order permutation', () => {
  it('produces identical migrate/warn decisions regardless of the on-disk key insertion order', () => {
    // Build the SAME logical overlay content with keys inserted in two different orders:
    //  - "prop-delta-1" migrates cleanly (exact, solo claimant)
    //  - "prop-acme-5" would clobber the live-valid "prop-acme" (invariant 1)
    //  - "prop-zeta-1" / "prop-zeta-2" race each other for the same target (invariant 2), combined
    //    with invariant 5: the SAME two racers must both be refused regardless of key order.
    const forward: Record<string, unknown> = {};
    forward['prop-acme'] = { note: 'live-valid, fresh' };
    forward['prop-acme-5'] = { note: 'stale' };
    forward['prop-delta-1'] = { note: 'clean migration candidate' };
    forward['prop-zeta-1'] = { note: 'racer A' };
    forward['prop-zeta-2'] = { note: 'racer B' };

    const reversed: Record<string, unknown> = {};
    for (const k of Object.keys(forward).reverse()) reversed[k] = forward[k];

    const liveIds2 = new Set(['prop-acme', 'prop-delta', 'prop-zeta']);
    const planForward = planMigration(forward, liveIds2);
    const planReversed = planMigration(reversed, liveIds2);

    const normalize = (p: ReturnType<typeof planMigration>) => ({
      toMigrate: [...p.toMigrate].sort((a, b) => (a.oldKey < b.oldKey ? -1 : 1)),
      toWarnKeys: [...p.toWarn.map((w) => w.oldKey)].sort(),
    });
    expect(normalize(planForward)).toEqual(normalize(planReversed));
    // And confirm the actual expected outcome (not just forward===reversed):
    expect(planForward.toMigrate).toEqual([{ oldKey: 'prop-delta-1', newKey: 'prop-delta' }]);
    const warnKeys = planForward.toWarn.map((w) => w.oldKey).sort();
    expect(warnKeys).toEqual(['prop-acme-5', 'prop-zeta-1', 'prop-zeta-2']);
  });
});

describe('planMigration — positive path: a clean, unambiguous exact match migrates', () => {
  it('a single old key resolving (exact) to exactly one not-yet-live target migrates', () => {
    const overlay = { 'prop-omega-1': { note: 'clean' } };
    const liveIds = new Set(['prop-omega']);
    const plan = planMigration(overlay, liveIds);
    expect(plan.toWarn).toHaveLength(0);
    expect(plan.toMigrate).toEqual([{ oldKey: 'prop-omega-1', newKey: 'prop-omega' }]);
  });

  it('a key that is already exactly the live id, with no collision-cluster shape, is a silent no-op', () => {
    const overlay = { 'prop-plain': { note: 'already correct' } };
    const liveIds = new Set(['prop-plain']);
    const plan = planMigration(overlay, liveIds);
    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toWarn).toHaveLength(0);
  });
});

describe('partitionMarketRents — Round-3 REFUTE Defect N: marketRents mixed-key handling', () => {
  it('a key that exactly matches a live propertyKey is excluded from migration planning, no warning', () => {
    // "1100 Rarig Ave" is the RAW propertyKey server/brain.ts's setMarketRent writes -- not a lease
    // id. Pre-fix, feeding this straight into planMigration (liveIds = lease ids only) misdiagnosed
    // it as an orphaned old-scheme key ("no live lease matches...", or worse, an ambiguous prefix
    // match), inviting an operator to manually remap it onto one specific lease -- silently removing
    // the property-level market-rent fallback for every OTHER lease at that property.
    const marketRents = { '1100 Rarig Ave': 12.5 };
    const livePropertyKeys = new Set(['1100 Rarig Ave', 'Other Property']);
    const { forMigration, validPropertyKeyed } = partitionMarketRents(marketRents, livePropertyKeys);
    expect(validPropertyKeyed).toEqual(['1100 Rarig Ave']);
    expect(forMigration).toEqual({});

    // Feeding the partitioned-out forMigration set into planMigration produces ZERO warnings for
    // this domain -- the whole point of partitioning before planning.
    const plan = planMigration(forMigration, new Set(['some-lease-id']));
    expect(plan.toWarn).toHaveLength(0);
    expect(plan.toMigrate).toHaveLength(0);
  });

  it('a key that does NOT match any live propertyKey still goes through normal old-scheme resolution', () => {
    const marketRents = { 'prop-omega-1': 15.0 };
    const livePropertyKeys = new Set(['Other Property']);
    const { forMigration, validPropertyKeyed } = partitionMarketRents(marketRents, livePropertyKeys);
    expect(validPropertyKeyed).toEqual([]);
    expect(forMigration).toEqual({ 'prop-omega-1': 15.0 });

    const plan = planMigration(forMigration, new Set(['prop-omega']));
    expect(plan.toMigrate).toEqual([{ oldKey: 'prop-omega-1', newKey: 'prop-omega' }]);
  });

  it('a mixed marketRents map partitions propertyKey-keyed and lease-id-shaped entries independently', () => {
    const marketRents = {
      '1100 Rarig Ave': 12.5, // valid propertyKey entry
      'prop-omega-1': 15.0, // orphaned old-scheme lease-id entry
    };
    const livePropertyKeys = new Set(['1100 Rarig Ave']);
    const { forMigration, validPropertyKeyed } = partitionMarketRents(marketRents, livePropertyKeys);
    expect(validPropertyKeyed).toEqual(['1100 Rarig Ave']);
    expect(forMigration).toEqual({ 'prop-omega-1': 15.0 });
  });
});

describe('planMigration — Round-4 REFUTE Defect 3: overwrite guard must see the map the apply step actually mutates', () => {
  it('a migration target that already exists in existingKeysMap (but NOT in oldKeysMap) is refused, not migrated', () => {
    // Synthetic/contrived shapes on purpose (this is a structural correctness test, not a realism
    // test -- per the task brief, a propertyKey string coinciding with a live lease id is
    // effectively impossible today given the codebase's slug/id conventions).
    //
    // `oldKeysMap` mirrors main()'s `planInput` for marketRents: the PARTITIONED subset fed to the
    // planner, containing only the one genuinely-orphaned old-scheme key.
    const oldKeysMap: Record<string, unknown> = { 'contrived-1': { note: 'orphaned old-scheme entry' } };
    // `existingKeysMap` mirrors main()'s `map`: the FULL original overlay[domain] map, which also
    // still holds a partitioned-out entry that happens to already sit at "contrived" -- the exact
    // key "contrived-1" would resolve to (strip the `-\d+` suffix). This entry is invisible to
    // `oldKeysMap` (it was filtered out before planMigration ever saw it), but it IS what main()'s
    // apply step (`map[newKey] = map[oldKey]; delete map[oldKey]`) would actually overwrite.
    const FRESH_DATA = { note: 'FRESH -- a partitioned-out entry the guard must protect' };
    const existingKeysMap: Record<string, unknown> = { 'contrived-1': oldKeysMap['contrived-1'], contrived: FRESH_DATA };
    const liveIds = new Set(['contrived']);

    // Precondition: the target really is invisible to a guard that only looks at oldKeysMap.
    expect(Object.prototype.hasOwnProperty.call(oldKeysMap, 'contrived')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(existingKeysMap, 'contrived')).toBe(true);

    const planWithoutExistingMap = planMigration(oldKeysMap, liveIds);
    // Pre-fix behavior (existingKeysMap defaults to oldKeysMap): the guard is blind to the
    // partitioned-out "contrived" entry and would auto-migrate onto it.
    expect(planWithoutExistingMap.toMigrate).toEqual([{ oldKey: 'contrived-1', newKey: 'contrived' }]);

    const planWithExistingMap = planMigration(oldKeysMap, liveIds, existingKeysMap);
    // Post-fix behavior: passing the FULL map as existingKeysMap makes the guard see the
    // partitioned-out entry and refuse, exactly like invariant 1's ordinary same-map case.
    expect(planWithExistingMap.toMigrate).toHaveLength(0);
    expect(planWithExistingMap.toWarn).toHaveLength(1);
    expect(planWithExistingMap.toWarn[0]!.oldKey).toBe('contrived-1');
    expect(planWithExistingMap.toWarn[0]!.reason).toMatch(/already has an existing overlay entry/);

    // Simulate main()'s actual apply step against a copy of the full map: with the fixed plan
    // (toMigrate empty), FRESH_DATA at "contrived" must survive untouched.
    const applied = { ...existingKeysMap };
    for (const { oldKey, newKey } of planWithExistingMap.toMigrate) {
      applied[newKey] = applied[oldKey];
      delete applied[oldKey];
    }
    expect(applied['contrived']).toBe(FRESH_DATA);
  });

  it('renewalStages/tenantArrears (no partitioning) are unaffected — existingKeysMap defaults to oldKeysMap', () => {
    // For domains where main() never partitions (renewalStages, tenantArrears), `existingKeysMap` is
    // omitted at the call site, so it defaults to `oldKeysMap` itself — identical to pre-fix
    // behavior. Confirmed by re-running an existing invariant-1 scenario without the third argument.
    const overlay = { 'prop-acme': { stage: 'Renewal Sent (fresh)' }, 'prop-acme-3': { stage: 'stale value' } };
    const liveIds = new Set(['prop-acme', 'prop-other']);
    const plan = planMigration(overlay, liveIds);
    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toWarn[0]!.reason).toMatch(/already has an existing overlay entry/);
  });
});

describe('resolveLiveId — sanity (already covered indirectly above, pinned directly here too)', () => {
  it('exact match wins even when another live id also has that prefix', () => {
    const liveIds = new Set(['base', 'base-9']);
    expect(resolveLiveId('base', liveIds)).toEqual({ kind: 'exact', id: 'base' });
  });
  it('no candidates -> none', () => {
    expect(resolveLiveId('nope', new Set(['other']))).toEqual({ kind: 'none' });
  });
  it('multiple prefix candidates -> ambiguous', () => {
    const liveIds = new Set(['base-1', 'base-2']);
    const r = resolveLiveId('base', liveIds);
    expect(r.kind).toBe('ambiguous');
  });

  it('Round-3 REFUTE Defect R — ambiguous candidates are sorted, independent of Set insertion order', () => {
    // Same logical candidate set, inserted in two different orders (simulating a re-sorted
    // worksheet). Set iteration order preserves insertion order, so the pre-fix `candidates` array
    // (and therefore the warning text built from it) varied across runs even though the underlying
    // refuse-it-as-ambiguous DECISION never changes.
    const forward = new Set(['base-2', 'base-1', 'base-3']);
    const reversed = new Set(['base-3', 'base-1', 'base-2']);
    const rForward = resolveLiveId('base', forward);
    const rReversed = resolveLiveId('base', reversed);
    expect(rForward.kind).toBe('ambiguous');
    expect(rReversed.kind).toBe('ambiguous');
    if (rForward.kind === 'ambiguous' && rReversed.kind === 'ambiguous') {
      expect(rForward.candidates).toEqual(['base-1', 'base-2', 'base-3']);
      expect(rForward.candidates).toEqual(rReversed.candidates);
    }
  });
});
