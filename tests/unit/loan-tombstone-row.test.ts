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

  /**
   * 2026-08-11 integrity sweep, L2 — the one finding in the falsely-CLEARING governor direction.
   *
   * A skipped row's balance leaves aggregate debt, so portfolio LTV reads LOWER than reality, and
   * the Hard-Invariant-4 40% aggregate ceiling is evaluated against an understated numerator. The
   * marker is an ANNOTATION that replaces the name, so `DUPLICATE OF` is anchored to the start of
   * the cell (after any ⚠/whitespace/punctuation). A real counterparty name carrying the phrase
   * mid-string — the shape Gabriel would actually type when consolidating a facility — must survive.
   *
   * `DO NOT USE` is intentionally left matching anywhere and case-insensitively: the tests above
   * deliberately assert that ('Old note — DO NOT USE'), so narrowing it would contradict a
   * documented decision rather than fix a defect.
   */
  it('does not fire on a live loan name carrying "duplicate of" mid-string', () => {
    expect(isTombstonedLoanRow('Fifth Third (consolidated — duplicate of prior facility retired)')).toBe(false);
    expect(isTombstonedLoanRow('Huntington — replaces duplicate of r22 exposure')).toBe(false);
    expect(isTombstonedLoanRow('Note A, a duplicate of the 2019 facility, refinanced')).toBe(false);
  });

  /**
   * REFUTE-PASS REGRESSION (MEDIUM, differential-confirmed). Anchoring with `^\W*` stops at the
   * first WORD character, so every one of these — all caught by the old unanchored regex — became a
   * MISS. A missed tombstone parses as a live loan: its stale balance double-counts the duplicated
   * facility in aggregate debt (the LTV numerator) and it claims a debt_positions warehouse key.
   * And the miss direction is completely SILENT, because the warn only fires when the regex matches.
   * So the first fix traded a flagged false-positive for an unflagged false-negative on a
   * hand-maintained sheet where the marker wording is human-chosen. Both directions must be loud.
   */
  it('still catches a tombstone whose marker is preceded by a retirement word', () => {
    expect(isTombstonedLoanRow('RETIRED — DUPLICATE OF row 9')).toBe(true);
    expect(isTombstonedLoanRow('OLD: DUPLICATE OF Fifth Third note')).toBe(true);
    expect(isTombstonedLoanRow('(VOID) DUPLICATE OF #7')).toBe(true);
    expect(isTombstonedLoanRow('Retired - duplicate of row 12')).toBe(true);
    expect(isTombstonedLoanRow('DEFUNCT DUPLICATE OF ROW 3')).toBe(true);
  });

  it('still rejects a real counterparty name carrying the phrase mid-sentence', () => {
    // The false positive the anchor was introduced for must stay fixed.
    expect(isTombstonedLoanRow('Fifth Third (consolidated — duplicate of prior facility retired)')).toBe(false);
    expect(isTombstonedLoanRow('Note A, a duplicate of the 2019 facility, refinanced')).toBe(false);
  });

  it('still fires when the marker leads the cell, with or without the ⚠ prefix', () => {
    expect(isTombstonedLoanRow('DUPLICATE OF ROW 22')).toBe(true);
    expect(isTombstonedLoanRow('⚠ DUPLICATE OF ROW 22')).toBe(true);
    expect(isTombstonedLoanRow('  duplicate of row 7 — superseded')).toBe(true);
    expect(isTombstonedLoanRow('— DUPLICATE OF ROW 9')).toBe(true);
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(isTombstonedLoanRow('')).toBe(false);
    expect(isTombstonedLoanRow('   ')).toBe(false);
  });
});
