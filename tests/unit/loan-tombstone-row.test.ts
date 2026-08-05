import { describe, it, expect } from 'vitest';
import { isTombstonedLoanRow } from '../../server/workbook/parse';

/**
 * OI-093 residual. The Loan Index carries deliberately-retired rows that Gabriel annotates
 * in place rather than deleting, so the workbook keeps its own audit trail. Live example
 * (Loan Index r24, 2026-08-05):
 *
 *   idx 13 | "⚠ DUPLICATE OF ROW 22 — DO NOT USE" | REDACTED-493 (EGFLLC) | 0
 *
 * The parser ingested that as a real loan, giving it a snapshot id
 * (`internal-duplicate-of-row-22-do-not-use`) and therefore a key in `debt_positions`,
 * which is keyed ON CONFLICT(id, snapshot_date). A tombstone must never claim a warehouse
 * key or inflate the loan count.
 */

describe('isTombstonedLoanRow', () => {
  it('rejects the live tombstone row verbatim', () => {
    expect(isTombstonedLoanRow('⚠ DUPLICATE OF ROW 22 — DO NOT USE')).toBe(true);
  });

  it('rejects the DO NOT USE marker regardless of case or surrounding text', () => {
    expect(isTombstonedLoanRow('do not use')).toBe(true);
    expect(isTombstonedLoanRow('Old note — DO NOT USE')).toBe(true);
    expect(isTombstonedLoanRow('DO  NOT  USE')).toBe(true); // tolerate extra spacing
  });

  it('rejects a DUPLICATE OF <row> marker', () => {
    expect(isTombstonedLoanRow('DUPLICATE OF ROW 22')).toBe(true);
    expect(isTombstonedLoanRow('duplicate of row 7 — superseded')).toBe(true);
  });

  it('keeps every real loan name currently in the workbook', () => {
    for (const name of [
      '3540 E. Fifth Ave',
      '9050 Red Branch Road',
      '29000 Information Lane',
      'Banwick / Morrison',
      '3883 from Oxford',
      'REDACTED-378',
      'REDACTED-306',
      'REDACTED-415',
      'REDACTED-337',
      'REDACTED-438',
      'REDACTED-409',
      'REDACTED-372',
      '2203-2207 Northwood',
    ]) {
      expect(isTombstonedLoanRow(name), `${name} must NOT be treated as a tombstone`).toBe(false);
    }
  });

  it('does not fire on legitimate names that merely contain the word duplicate', () => {
    // Guard against over-matching: "duplicate" alone is not a tombstone marker.
    expect(isTombstonedLoanRow('Duplicate Bridge Holdings LLC')).toBe(false);
    expect(isTombstonedLoanRow('Useful Capital Partners')).toBe(false);
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(isTombstonedLoanRow('')).toBe(false);
    expect(isTombstonedLoanRow('   ')).toBe(false);
  });
});
