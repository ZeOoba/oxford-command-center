// tests/unit/debt-snapshot-backfill.test.ts
//
// parseArgs() unit tests for the debt-snapshot-backfill CLI. Pure function, no I/O — added
// 2026-07-24 alongside the --allow-empty-supersede flag (H2a reachability fix, refute-review):
// no coverage existed for this script's argument parsing before this flag was added.
import { describe, expect, it } from 'vitest';
import { parseArgs, selectOutcome } from '../../scripts/debt-snapshot-backfill';

describe('debt-snapshot-backfill parseArgs', () => {
  it('parses --db and --workbook', () => {
    const args = parseArgs(['--db', 'C:/tmp/x.sqlite', '--workbook', 'C:/tmp/wb.xlsx']);
    expect(args.dbPath).toBe('C:/tmp/x.sqlite');
    expect(args.workbook).toBe('C:/tmp/wb.xlsx');
    expect(args.allowEmptySupersede).toBeUndefined();
  });

  it('--allow-empty-supersede is a boolean flag (no value consumed)', () => {
    const args = parseArgs(['--allow-empty-supersede', '--db', 'C:/tmp/x.sqlite']);
    expect(args.allowEmptySupersede).toBe(true);
    expect(args.dbPath).toBe('C:/tmp/x.sqlite');
  });

  it('defaults allowEmptySupersede to undefined (not passed)', () => {
    const args = parseArgs([]);
    expect(args.allowEmptySupersede).toBeUndefined();
  });

  it('throws on --db with no value', () => {
    expect(() => parseArgs(['--db'])).toThrow(/missing value for --db/);
  });
});

// selectOutcome() (round 4, adversarial-review Finding 4): the original inline branch checked
// `written === 0` BEFORE `refusedEmptySupersede`, so a shrinkage-guard refusal printed "No
// borrower-direction active loans found ... check the workbook Loan Index tab" — wrong on both
// counts, since loans WERE found and debt_positions is untouched, not empty. Pinned here so the
// ordering regression cannot silently return.
//
// Round 19e (adversarial refute of round 19d, MEDIUM — reproduced): selectOutcome checked only
// `refusedEmptySupersede` and `written === 0`, so a degraded write, a vanish latch, or a standing
// marker a clean run failed to fully recover all fell through to `null` — this CLI's own caller
// printed nothing beyond the routine "N loan(s) written" line and exited 0 while every governor
// verdict stayed withheld. Widened to match server/index.ts's branches.
function baseResult(overrides: Partial<Parameters<typeof selectOutcome>[0]> = {}): Parameters<typeof selectOutcome>[0] {
  return {
    written: 0,
    refusedEmptySupersede: false,
    degradedRows: 0,
    vanishedIds: [],
    staleMarkerHeld: false,
    ...overrides,
  };
}

describe('debt-snapshot-backfill selectOutcome', () => {
  it('a shrinkage-guard refusal is reported as a refusal, NOT as "no loans found" (the exact bug)', () => {
    const outcome = selectOutcome(baseResult({ written: 0, refusedEmptySupersede: true }), false);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(1);
    expect(outcome!.message).toMatch(/REFUSED/);
    expect(outcome!.message).not.toMatch(/No borrower-direction active loans found/);
  });

  it('a genuinely empty parse (no refusal) still gets the "check the workbook" message', () => {
    const outcome = selectOutcome(baseResult({ written: 0, refusedEmptySupersede: false }), false);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(1);
    expect(outcome!.message).toMatch(/No borrower-direction active loans found/);
  });

  it('a confirmed opt-in supersede reports success, not the workbook-check message', () => {
    const outcome = selectOutcome(baseResult({ written: 3, refusedEmptySupersede: false }), true);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(0);
    expect(outcome!.message).toMatch(/confirmed supersede performed/);
  });

  it('a normal successful write (no refusal, rows written, no opt-in) prints nothing and signals no special outcome', () => {
    expect(selectOutcome(baseResult({ written: 5, refusedEmptySupersede: false }), false)).toBeNull();
  });

  it('the opt-in flag set but NOT needed this run (guard never fired) still reports the confirmed-success message', () => {
    // allowEmptySupersede=true is passed defensively on every CLI invocation with the flag, even
    // when the write would have succeeded anyway (e.g. a normal non-shrinking snapshot). Correction
    // (round 5, second review — this test's own name previously stated the opposite of what it
    // asserts): selectOutcome does NOT distinguish "the opt-in was actually exercised" from "it
    // was armed but moot" — both take this same success branch, since allowEmptySupersedeFlag
    // alone (not whether the guard fired) selects it. refusedEmptySupersede only ever routes to
    // the REFUSED branch below, never back to this one.
    const outcome = selectOutcome(baseResult({ written: 12, refusedEmptySupersede: false }), true);
    expect(outcome!.message).toMatch(/confirmed supersede performed/);
    expect(outcome!.exitCode).toBe(0);
  });

  it('a degraded write (insert failures) is reported, not silently treated as a clean success', () => {
    const outcome = selectOutcome(baseResult({ written: 4, degradedRows: 1 }), false);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(1);
    expect(outcome!.message).toMatch(/DEGRADED/);
  });

  it('a vanish latch is reported and names the vanished loan(s)', () => {
    const outcome = selectOutcome(baseResult({ written: 5, vanishedIds: ['loan-06'] }), false);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(1);
    expect(outcome!.message).toMatch(/VANISHED/);
    expect(outcome!.message).toContain('loan-06');
  });

  it('a standing marker not fully recovered by this run is reported, not treated as quiet success', () => {
    const outcome = selectOutcome(baseResult({ written: 5, staleMarkerHeld: true }), false);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(1);
    expect(outcome!.message).toMatch(/STILL DEGRADED/);
  });

  // Round 19f (adversarial refute of 19e, HIGH — reproduced): --allow-empty-supersede's success
  // branch previously ran FIRST, ahead of all three new checks, so it silently masked the one
  // event class that DESTROYS data rather than freezing it. Reproduced sequence: a loan vanishes
  // -> operator re-runs with --allow-empty-supersede as the CLI's own message instructs -> a
  // DIFFERENT loan's insert fails this same run -> exitCode 0, "confirmed supersede performed" —
  // affirmatively false, since the destroyed row was never confirmed by anyone.
  it('degradedRows wins over --allow-empty-supersede — real data loss is never waived by the flag', () => {
    const outcome = selectOutcome(baseResult({ written: 1, degradedRows: 1 }), true);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(1);
    expect(outcome!.message).toMatch(/DEGRADED/);
    expect(outcome!.message).not.toMatch(/confirmed supersede performed/);
  });

  it('a vanish-only outcome under the flag IS treated as a legitimate, explicitly-confirmed waiver', () => {
    const outcome = selectOutcome(baseResult({ written: 5, vanishedIds: ['loan-06'] }), true);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(0);
    expect(outcome!.message).toMatch(/confirmed supersede performed/);
  });

  it('degradedRows and vanishedIds together: DEGRADED wins, message does not conflate the two', () => {
    const outcome = selectOutcome(
      baseResult({ written: 3, degradedRows: 1, vanishedIds: ['loan-07'] }),
      false,
    );
    expect(outcome).not.toBeNull();
    expect(outcome!.message).toMatch(/DEGRADED/);
    expect(outcome!.message).not.toContain('loan-07');
  });
});
