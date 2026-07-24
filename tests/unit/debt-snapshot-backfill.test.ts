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
describe('debt-snapshot-backfill selectOutcome', () => {
  it('a shrinkage-guard refusal is reported as a refusal, NOT as "no loans found" (the exact bug)', () => {
    const outcome = selectOutcome({ written: 0, refusedEmptySupersede: true }, false);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(1);
    expect(outcome!.message).toMatch(/REFUSED/);
    expect(outcome!.message).not.toMatch(/No borrower-direction active loans found/);
  });

  it('a genuinely empty parse (no refusal) still gets the "check the workbook" message', () => {
    const outcome = selectOutcome({ written: 0, refusedEmptySupersede: false }, false);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(1);
    expect(outcome!.message).toMatch(/No borrower-direction active loans found/);
  });

  it('a confirmed opt-in supersede reports success, not the workbook-check message', () => {
    const outcome = selectOutcome({ written: 3, refusedEmptySupersede: false }, true);
    expect(outcome).not.toBeNull();
    expect(outcome!.exitCode).toBe(0);
    expect(outcome!.message).toMatch(/confirmed supersede performed/);
  });

  it('a normal successful write (no refusal, rows written, no opt-in) prints nothing and signals no special outcome', () => {
    expect(selectOutcome({ written: 5, refusedEmptySupersede: false }, false)).toBeNull();
  });

  it('the opt-in flag set but NOT needed this run (guard never fired) still reports the confirmed-success message', () => {
    // allowEmptySupersede=true is passed defensively on every CLI invocation with the flag, even
    // when the write would have succeeded anyway (e.g. a normal non-shrinking snapshot). Correction
    // (round 5, second review — this test's own name previously stated the opposite of what it
    // asserts): selectOutcome does NOT distinguish "the opt-in was actually exercised" from "it
    // was armed but moot" — both take this same success branch, since allowEmptySupersedeFlag
    // alone (not whether the guard fired) selects it. refusedEmptySupersede only ever routes to
    // the REFUSED branch below, never back to this one.
    const outcome = selectOutcome({ written: 12, refusedEmptySupersede: false }, true);
    expect(outcome!.message).toMatch(/confirmed supersede performed/);
    expect(outcome!.exitCode).toBe(0);
  });
});
