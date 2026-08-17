import { describe, it, expect } from 'vitest';
import { shouldBakeWarehouse } from '../../scripts/bake-mirror';

/**
 * W0 (Eric Live Phase 2). Phase 1b shipped BOTH halves of the Fat Mirror — the bake
 * (scripts/bake-warehouse.ts) and the client fallback (src/lib/warehouse-mirror.ts,
 * src/modules/intel/hooks.ts) — and the bake is covered by warehouse-mirror-bake.test.ts.
 *
 * What was NEVER covered is the WIRING that decides whether the bake runs at all. The result:
 * `public/warehouse.json` has never once been produced. No scheduled task and no
 * deploy-mirror.ps1 invocation passes --warehouse / BAKE_WAREHOUSE=1, so PFI and the
 * Calibration Log have stayed dark on the mirror for two months while every test stayed green
 * — a working engine behind a switch nobody flips.
 *
 * Phase 2 cold-standby makes this load-bearing rather than cosmetic: warehouse.json IS the
 * standby payload the edge proxy falls back to when the workstation is asleep. An unbaked file
 * means the fallback fails closed and Eric sees "offline" every time the laptop sleeps.
 *
 * So the trigger condition gets its own tests, at the exact boundary that was untested.
 */
describe('W0 — warehouse bake trigger wiring', () => {
  it('bakes when --warehouse is passed as a CLI flag', () => {
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts', '--warehouse'], {})).toBe(true);
  });

  it('bakes when BAKE_WAREHOUSE=1 is set in the environment (the scheduled-task path)', () => {
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts'], { BAKE_WAREHOUSE: '1' })).toBe(true);
  });

  it('does NOT bake by default — the hourly snapshot bake must stay light', () => {
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts'], {})).toBe(false);
  });

  /**
   * Cadence decoupling is a hard guardrail (spec §2.2): the warehouse bake is RAM/IO-heavy and
   * contends with the live server's WAL lock. An operator who disables it by setting 0 (rather
   * than unsetting) must actually get it disabled — a truthy-string check would silently keep
   * baking and reintroduce exactly the contention the decoupling exists to prevent.
   */
  it('treats BAKE_WAREHOUSE=0 as OFF, not as a truthy string', () => {
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts'], { BAKE_WAREHOUSE: '0' })).toBe(false);
  });

  it('treats an empty BAKE_WAREHOUSE as OFF', () => {
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts'], { BAKE_WAREHOUSE: '' })).toBe(false);
  });

  /** The flag must work regardless of position — argv order is not the caller's contract. */
  it('finds --warehouse anywhere in argv', () => {
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts', '--warehouse', '--other'], {})).toBe(true);
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts', '--other', '--warehouse'], {})).toBe(true);
  });

  /** Guard against a substring/prefix match quietly enabling the heavy bake. */
  it('does not fire on a merely similar flag', () => {
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts', '--warehouse-dry-run'], {})).toBe(false);
    expect(shouldBakeWarehouse(['node', 'bake-mirror.ts', '--no-warehouse'], {})).toBe(false);
  });
});
