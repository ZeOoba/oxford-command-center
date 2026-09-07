// Real defect (2026-09-06 adversarial review): the AR ingest only ever WRITES rows present in a
// report. A tenant who paid off and no longer appears on the newer same-property delinquency
// report keeps its old, stale arrears record forever -- and because conditions.ts's staleness
// gate suppresses ALL per-lease AR alerts once ANY stamped record exceeds 35 days, a handful of
// paid-off ghosts silently disabled collections alerting portfolio-wide. This module supplies the
// missing "tenant dropped off a newer report of the same series -> zero it out" step.
//
// v1 of this module (same-day) was itself found defective by a follow-up adversarial pass (5/5
// lenses, HIGH): it equated "not written this sweep" with "absent from the report", which zeroes
// a still-genuinely-delinquent tenant whenever their row lands in review/skip instead of a write.
// v2 (tested here) fails closed: an entire series is exempted from clearing if it had ANY
// unresolved row this sweep, and a write only protects a lease against clearing when it came from
// that series' NEWEST report specifically (not merely "somewhere in the sweep").
import { describe, it, expect } from 'vitest';
import { reportSeriesKey, computeDroppedLeaseClears, applyWritesAndClears } from '../../server/ar/clear-dropped-leases';
import type { TenantArrears } from '../../src/contracts/index';

function rec(
  partial: Omit<Partial<TenantArrears>, 'asOfDate' | 'sourceFile'> & { asOfDate: string | null; sourceFile: string | null },
): TenantArrears {
  return { d30: 0, d60: 0, d90: 0, d90plus: 0, ...partial } as unknown as TenantArrears;
}

describe('reportSeriesKey', () => {
  it('strips a trailing M.D.YYYY date and the extension', () => {
    expect(reportSeriesKey('1100 Rarig Delinquency 8.21.2026.xlsx')).toBe('1100 rarig delinquency');
    expect(reportSeriesKey('Sepich Portfolio Delinquency 8.21.2026.xlsx')).toBe('sepich portfolio delinquency');
  });

  it('two dated exports of the same recurring report share a series key', () => {
    expect(reportSeriesKey('1100 Rarig Delinquency 8.21.2026.xlsx')).toBe(
      reportSeriesKey('1100 Rarig Delinquency 9.18.2026.xlsx'),
    );
  });

  // Real defect (2026-09-06 self-review, LOW): only the dot-date form was recognized, so every
  // PDF/QuickBooks export (the ISO YYYY-MM-DD convention extractAsOfDateFromFilename also accepts)
  // was silently its own series and could never be cleared.
  it('also strips a trailing ISO (YYYY-MM-DD) date, matching extractAsOfDateFromFilename', () => {
    expect(reportSeriesKey('AR_2026-07-15.pdf')).toBe(reportSeriesKey('AR_2026-08-21.pdf'));
    expect(reportSeriesKey('AR_2026-07-15.pdf')).toBe('ar');
  });

  it('falls back to the whole basename (no extension) when no date pattern is found', () => {
    expect(reportSeriesKey('weird-export.xlsx')).toBe('weird-export');
  });

  // Real defect (2026-09-06 self-review, LOW): stripping a Windows auto-dedup "(1)" suffix let two
  // DIFFERENT properties whose default export filenames collided on the same day share a series
  // key and clear each other. Not stripping it means an unrecognized filename keys to itself --
  // always the safe (missed-clear, never wrong-clear) direction.
  it('does NOT collapse a filename carrying a Windows "(1)" duplicate suffix onto its un-suffixed sibling', () => {
    expect(reportSeriesKey('Delinquency 8.21.2026 (1).xlsx')).not.toBe(reportSeriesKey('Delinquency 8.21.2026.xlsx'));
  });
});

describe('computeDroppedLeaseClears', () => {
  const property = '9050 Red Branch Delinquency';
  const oldFile = `${property} 7.15.2026.xlsx`;
  const newFile = `${property} 8.21.2026.xlsx`;
  const report = (sourceFile: string, asOfDate: Date | null, hadUnresolvedRow = false) => ({ sourceFile, asOfDate, hadUnresolvedRow });

  it('zero-stamps a persisted lease whose tenant is absent from a newer same-series report', () => {
    const persisted: Record<string, TenantArrears> = {
      'mlc-academy': rec({ d30: 5780.38, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    const clears = computeDroppedLeaseClears(persisted, [report(newFile, new Date('2026-08-21'))], []);
    expect(clears['mlc-academy']).toEqual({
      d30: 0, d60: 0, d90: 0, d90plus: 0, asOfDate: new Date('2026-08-21'), sourceFile: newFile,
    });
  });

  it('does NOT clear a lease this sweep actually wrote a fresh balance for FROM the series’ newest report', () => {
    const persisted: Record<string, TenantArrears> = {
      'xpo-foods': rec({ d30: 1000, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    const clears = computeDroppedLeaseClears(
      persisted,
      [report(newFile, new Date('2026-08-21'))],
      [{ leaseId: 'xpo-foods', sourceFile: newFile }], // written from the newest report -- still delinquent
    );
    expect(clears['xpo-foods']).toBeUndefined();
  });

  // Real defect (2026-09-06 self-review, HIGH — confirmed by all 5 adversarial lenses): a tenant
  // PRESENT on the newer report whose row was routed to review (Expired lease excluded from the
  // roster, a roster-drift ambiguous tie, an unresolved Format-B unit) was previously treated as
  // "dropped off" and zero-stamped -- silently retracting a real, still-owed balance with only a
  // resolver-less review-queue row as trace. Note this is REVIEW specifically, not a cached SKIP —
  // a follow-up round found treating a SKIP the same way permanently blocks clearing for any series
  // with a standing SKIP entry (see the "SKIP" describe block below).
  it('does NOT clear ANY lease in a series that had an unresolved (review) row this sweep', () => {
    const persisted: Record<string, TenantArrears> = {
      'still-owes': rec({ d90plus: 5000, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    // The newer report also carries a row this sweep could not attribute (e.g. the same tenant's
    // lease flipped Expired and the name match fell to 'none' -> review) -- so the whole series is
    // exempted from clearing this sweep, even for a DIFFERENT lease's stale record.
    const clears = computeDroppedLeaseClears(
      persisted,
      [report(newFile, new Date('2026-08-21'), /* hadUnresolvedRow */ true)],
      [], // 'still-owes' itself produced no write this sweep either -- it's the one that went to review
    );
    expect(clears['still-owes']).toBeUndefined();
  });

  // Real defect (2026-09-06 self-review, MEDIUM — confirmed by 4/5 lenses): a catch-up sweep
  // processing BOTH an older and a newer report of one series in a single run wrote the tenant's
  // stale balance from the OLDER file and then protected it from clearing merely for having been
  // written "somewhere in the sweep" -- reproducing the exact ghost this fix exists to remove.
  it('clears a lease whose only write this sweep came from an OLDER report of a series that also ran a newer report', () => {
    // The write already landed via the normal write path (filterAgainstPersisted), sourced from the
    // OLDER file in a catch-up sweep that also processed the newer file. This module only decides
    // whether that now-PERSISTED record should be retracted, given both reports ran this sweep.
    const persisted: Record<string, TenantArrears> = {
      'paid-between': rec({ d30: 5000, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    const clears = computeDroppedLeaseClears(
      persisted,
      [report(oldFile, new Date('2026-07-15')), report(newFile, new Date('2026-08-21'))],
      [{ leaseId: 'paid-between', sourceFile: oldFile }], // written, but from the OLDER file -- not protected
    );
    expect(clears['paid-between']).toEqual({
      d30: 0, d60: 0, d90: 0, d90plus: 0, asOfDate: new Date('2026-08-21'), sourceFile: newFile,
    });
  });

  it('does NOT clear a lease whose persisted record is already current or newer than this series run', () => {
    const persisted: Record<string, TenantArrears> = {
      'already-current': rec({ d30: 200, asOfDate: '2026-08-21', sourceFile: newFile }),
    };
    const clears = computeDroppedLeaseClears(persisted, [report(newFile, new Date('2026-08-21'))], []);
    expect(clears['already-current']).toBeUndefined();
  });

  it('never reaches across an unrelated report series (a different property this sweep did not touch)', () => {
    const persisted: Record<string, TenantArrears> = {
      'other-property-tenant': rec({ d30: 900, asOfDate: '2026-07-15', sourceFile: 'Morrison 390 Delinquency 7.15.2026.xlsx' }),
    };
    const clears = computeDroppedLeaseClears(
      persisted,
      [report(newFile, new Date('2026-08-21'))], // only 9050 Red Branch ran this sweep
      [],
    );
    expect(clears['other-property-tenant']).toBeUndefined();
  });

  it('never touches a manually-entered record with no sourceFile provenance', () => {
    const persisted: Record<string, TenantArrears> = {
      'manual-entry': rec({ d30: 50, asOfDate: '2026-01-01', sourceFile: null }),
    };
    const clears = computeDroppedLeaseClears(persisted, [report(newFile, new Date('2026-08-21'))], []);
    expect(clears['manual-entry']).toBeUndefined();
  });

  it('is a no-op once a lease has already been cleared at the current series as-of', () => {
    const persisted: Record<string, TenantArrears> = {
      'already-cleared': rec({ d30: 0, d60: 0, d90: 0, d90plus: 0, asOfDate: '2026-08-21', sourceFile: newFile }),
    };
    const clears = computeDroppedLeaseClears(persisted, [report(newFile, new Date('2026-08-21'))], []);
    expect(clears['already-cleared']).toBeUndefined();
  });

  it('skips a series with no dated report processed this sweep (never clears against an unknown date)', () => {
    const persisted: Record<string, TenantArrears> = {
      'undated-series': rec({ d30: 400, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    const clears = computeDroppedLeaseClears(persisted, [report(newFile, null)], []);
    expect(clears['undated-series']).toBeUndefined();
  });

  // Real defect (2026-09-06 self-review, LOW): an UNDATED persisted record was cleared against any
  // dated same-series report, contradicting filterAgainstPersisted's own doctrine that an undated
  // record's vintage is unproven, not "older" -- staleness must never be inferred from absence of a
  // date.
  it('never clears an UNDATED persisted record, regardless of a newer dated report in its series', () => {
    const persisted: Record<string, TenantArrears> = {
      'undated-persisted': rec({ d30: 900, asOfDate: null, sourceFile: oldFile }),
    };
    const clears = computeDroppedLeaseClears(persisted, [report(newFile, new Date('2026-08-21'))], []);
    expect(clears['undated-persisted']).toBeUndefined();
  });
});

describe('applyWritesAndClears (correct write-then-clear ordering)', () => {
  const property = '3034 Westerville Delinquency';
  const oldFile = `${property} 7.15.2026.xlsx`;
  const newFile = `${property} 8.21.2026.xlsx`;
  const report = (sourceFile: string, asOfDate: Date | null, hadUnresolvedRow = false) => ({ sourceFile, asOfDate, hadUnresolvedRow });

  // Real defect (2026-09-06 round-3 self-review, MEDIUM — confirmed end-to-end against real
  // archived exports in an isolated sandbox): the caller previously computed clears against the
  // PRE-write persisted map, then applied `toWrite` on top afterward — so a catch-up sweep's write
  // sourced from an OLDER report of a series silently overrode a correctly-computed clear, and the
  // console falsely logged the lease as "cleared" while the stale balance survived untouched.
  it('a same-sweep write from an OLDER report of a series does NOT survive a clear from that series’ newest report', () => {
    const persisted: Record<string, TenantArrears> = {
      lamar: rec({ d60: 500, d90plus: 500, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    // lamar is on the 7.15 report (auto-written) but absent from the 8.21 report this same sweep.
    const toWrite = [{ leaseId: 'lamar', arrears: rec({ d60: 500, d90plus: 500, asOfDate: '2026-07-15', sourceFile: oldFile }) }];
    const { newArrears, clearedLeaseIds } = applyWritesAndClears(
      persisted,
      [report(oldFile, new Date('2026-07-15')), report(newFile, new Date('2026-08-21'))],
      toWrite,
    );
    expect(clearedLeaseIds).toContain('lamar');
    expect(newArrears.lamar).toEqual({
      d30: 0, d60: 0, d90: 0, d90plus: 0, asOfDate: new Date('2026-08-21'), sourceFile: newFile,
    });
  });

  it('a fresh write from the series’ newest report this sweep is preserved (not clobbered by an unrelated clear)', () => {
    const persisted: Record<string, TenantArrears> = {
      'xpo-foods': rec({ d30: 1000, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    const freshWrite = rec({ d30: 1200, asOfDate: '2026-08-21', sourceFile: newFile });
    const { newArrears, clearedLeaseIds } = applyWritesAndClears(
      persisted,
      [report(newFile, new Date('2026-08-21'))],
      [{ leaseId: 'xpo-foods', arrears: freshWrite }],
    );
    expect(clearedLeaseIds).toEqual([]);
    expect(newArrears['xpo-foods']).toEqual(freshWrite);
  });

  it('a lease with no write this sweep and absent from the newer report is still cleared', () => {
    const persisted: Record<string, TenantArrears> = {
      'mlc-academy': rec({ d30: 5780.38, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    const { newArrears, clearedLeaseIds } = applyWritesAndClears(persisted, [report(newFile, new Date('2026-08-21'))], []);
    expect(clearedLeaseIds).toContain('mlc-academy');
    expect(newArrears['mlc-academy']).toEqual({
      d30: 0, d60: 0, d90: 0, d90plus: 0, asOfDate: new Date('2026-08-21'), sourceFile: newFile,
    });
  });
});

describe('hadUnresolvedRow: a cached SKIP must not exempt a series (unlike a genuine review row)', () => {
  // Real defect (2026-09-06 round-3 self-review, MEDIUM — confirmed on live data): a SKIP is a
  // durable, ALREADY-RESOLVED human decision, not an unattributed row. Real data has a standing
  // SKIP for a perpetually-reappearing non-tenant name on the "1900 Broadway + 9050 Red Branch"
  // series; treating it as "unresolved" would exempt that whole series from clearing on every
  // future sweep, permanently blocking 3 of the 7 real ghosts this fix exists to close. This test
  // asserts the CALLER-facing contract: a SweepReportInfo with hadUnresolvedRow=false (because the
  // only non-write row this sweep was a SKIP, not a review) still allows clearing.
  it('a series whose only non-write row this sweep was a cached SKIP (hadUnresolvedRow=false) still clears', () => {
    const property = '1900 Broadway Delinquency';
    const oldFile = `${property} 7.15.2026.xlsx`;
    const newFile = `${property} 8.21.2026.xlsx`;
    const persisted: Record<string, TenantArrears> = {
      'mlc-academy': rec({ d30: 5780.38, asOfDate: '2026-07-15', sourceFile: oldFile }),
    };
    // '(Past) Chesapeake Bay Movers, Inc.' is a cached SKIP on this report -- NOT counted toward
    // hadUnresolvedRow (only genuine review rows are).
    const clears = computeDroppedLeaseClears(
      persisted,
      [{ sourceFile: newFile, asOfDate: new Date('2026-08-21'), hadUnresolvedRow: false }],
      [],
    );
    expect(clears['mlc-academy']).toEqual({
      d30: 0, d60: 0, d90: 0, d90plus: 0, asOfDate: new Date('2026-08-21'), sourceFile: newFile,
    });
  });
});
