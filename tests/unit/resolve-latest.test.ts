import { describe, it, expect } from 'vitest';
import { resolveLatestArrears, filterAgainstPersisted, type DatedArrearsWrite } from '../../server/ar/resolve-latest';
import type { TenantArrears } from '../../src/contracts/index';

const w = (leaseId: string, total: number, asOfDate: Date | null, sourceFile = 'f.pdf'): DatedArrearsWrite => ({
  leaseId,
  tenant: leaseId,
  arrears: { d30: total, d60: 0, d90: 0, d90plus: 0, asOfDate, sourceFile },
});

/** Full bucket-vector variant of `w()` — needed to express an equal-TOTAL, different-DISTRIBUTION
 *  pair (refute round 3: `w()` alone puts everything in d30, so the whole prior test suite was
 *  structurally blind to a same-sum/different-bucket disagreement). */
const wb = (leaseId: string, buckets: Partial<TenantArrears>, asOfDate: Date | null, sourceFile = 'f.pdf'): DatedArrearsWrite => ({
  leaseId,
  tenant: leaseId,
  arrears: { d30: 0, d60: 0, d90: 0, d90plus: 0, ...buckets, asOfDate, sourceFile },
});

describe('resolveLatestArrears — cross-report supersede (never sum)', () => {
  it('passes a single row through unchanged', () => {
    const r = resolveLatestArrears([w('L1', 500, new Date('2026-07-31'))]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]!.arrears.d30).toBe(500);
    expect(r.superseded).toEqual([]);
  });

  it('does NOT sum the same lease across two reports — keeps the latest as-of', () => {
    const june = w('L1', 5000, new Date('2026-06-30'), 'june.pdf');
    const july = w('L1', 5000, new Date('2026-07-31'), 'july.pdf');
    const r = resolveLatestArrears([june, july]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]!.arrears.d30).toBe(5000); // NOT 10000
    expect(r.resolved[0]!.arrears.sourceFile).toBe('july.pdf');
    expect(r.superseded).toEqual(['L1']);
  });

  it('keeps the latest regardless of scan order', () => {
    const r = resolveLatestArrears([w('L1', 1, new Date('2026-07-31'), 'july.pdf'), w('L1', 2, new Date('2026-06-30'), 'june.pdf')]);
    expect(r.resolved[0]!.arrears.sourceFile).toBe('july.pdf');
  });

  it('lets a dated report supersede an undated one regardless of order', () => {
    const r1 = resolveLatestArrears([w('L1', 1, null, 'undated.pdf'), w('L1', 2, new Date('2026-07-31'), 'dated.pdf')]);
    expect(r1.resolved[0]!.arrears.sourceFile).toBe('dated.pdf');
    const r2 = resolveLatestArrears([w('L1', 2, new Date('2026-07-31'), 'dated.pdf'), w('L1', 1, null, 'undated.pdf')]);
    expect(r2.resolved[0]!.arrears.sourceFile).toBe('dated.pdf');
  });

  it('keeps distinct leases separate and reports no supersede', () => {
    const r = resolveLatestArrears([w('L1', 100, new Date('2026-07-31')), w('L2', 200, new Date('2026-07-31'))]);
    expect(r.resolved.map((x) => x.leaseId).sort()).toEqual(['L1', 'L2']);
    expect(r.resolved.find((x) => x.leaseId === 'L1')!.arrears.d30).toBe(100);
    expect(r.superseded).toEqual([]);
  });

  // refute round 2 (determinism lens): an exact as-of tie used to silently pick whichever row was
  // LATER in the array — which on an exact mtime tie (zip extraction, Explorer copy) collapses to
  // filesystem name order, silently persisting a coin-flip dollar amount.
  it('an exact as-of tie with DIFFERING totals is flagged ambiguous, NOT silently resolved', () => {
    const r = resolveLatestArrears([w('L1', 12000, new Date('2026-07-15'), 'original.pdf'), w('L1', 5000, new Date('2026-07-15'), 'corrected.pdf')]);
    expect(r.resolved).toEqual([]); // excluded — neither side is trusted
    expect(r.ambiguousTies).toEqual(['L1']);
    expect(r.superseded).toEqual(['L1']); // still reported as multi-report, just not auto-resolved
  });

  it('an exact as-of tie with EQUAL totals is harmless — resolves normally, not ambiguous', () => {
    const r = resolveLatestArrears([w('L1', 500, new Date('2026-07-15'), 'a.pdf'), w('L1', 500, new Date('2026-07-15'), 'b.pdf')]);
    expect(r.resolved).toHaveLength(1);
    expect(r.ambiguousTies).toEqual([]);
  });

  // refute round 3 (all 3 lenses, repro'd against the actual pre-fix code): an equal-TOTAL,
  // different-DISTRIBUTION pair was previously treated as a "harmless" tie and silently resolved by
  // scan order — but conditions.ts fires CRITICAL only on d90+d90plus dollars, so this was flipping a
  // real collections alert tier on a coin-flip (an invoice re-dated from d60 into d90plus keeps the
  // $5,000 total identical while turning a WARNING into a CRITICAL, or vice versa).
  it('an exact as-of tie with EQUAL totals but DIFFERENT bucket distribution is ambiguous, not harmless', () => {
    const original = wb('L1', { d60: 5000 }, new Date('2026-07-15'), 'original.pdf');
    const corrected = wb('L1', { d90plus: 5000 }, new Date('2026-07-15'), 'corrected.pdf');
    const r1 = resolveLatestArrears([original, corrected]);
    expect(r1.resolved).toEqual([]);
    expect(r1.ambiguousTies).toEqual(['L1']);
    // Must be order-independent: reversing the scan order must NOT silently pick the other bucket.
    const r2 = resolveLatestArrears([corrected, original]);
    expect(r2.resolved).toEqual([]);
    expect(r2.ambiguousTies).toEqual(['L1']);
  });

  // Real defect (2026-09-06 adversarial review, MEDIUM): sameBuckets compared with `===`, so a
  // last-ulp float difference between two reports that actually agree to the cent (produced by
  // summing the same charges in a different row order — see merge-buckets.test.ts /
  // rent-manager-delinquency.test.ts's own float-drift regressions) registered as a genuine
  // "conflicting reports" disagreement and stranded the write behind a false ambiguousTies entry,
  // even though the two totals are the SAME MONEY to the cent.
  it('an exact as-of tie whose buckets differ only by a sub-cent float ulp is harmless, not ambiguous', () => {
    const original = wb('L1', { d30: 752.8599999999999 }, new Date('2026-08-21'), 'a.pdf');
    const reExport = wb('L1', { d30: 752.86 }, new Date('2026-08-21'), 'b.pdf');
    const r = resolveLatestArrears([original, reExport]);
    expect(r.ambiguousTies).toEqual([]);
    expect(r.resolved).toHaveLength(1);
  });

  it('a THIRD, decisively-later row resolves a prior ambiguous tie', () => {
    const r = resolveLatestArrears([
      w('L1', 12000, new Date('2026-07-15'), 'original.pdf'),
      w('L1', 5000, new Date('2026-07-15'), 'corrected.pdf'), // ties with original -> ambiguous
      w('L1', 4000, new Date('2026-07-31'), 'august.pdf'), // decisively later -> resolves it
    ]);
    expect(r.ambiguousTies).toEqual([]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]!.arrears.sourceFile).toBe('august.pdf');
  });
});

describe('filterAgainstPersisted — NaN-safety of the underlying as-of comparison', () => {
  it('an invalid Date on the PERSISTED side does not poison every future write (NaN -> -Infinity)', () => {
    const persisted = { L1: persist({ asOfDate: new Date('not-a-date') }) }; // corrupt/invalid Date
    const r = filterAgainstPersisted([w('L1', 100, new Date('2026-07-01'))], persisted);
    expect(r.toWrite.map((x) => x.leaseId)).toEqual(['L1']);
    expect(r.rejectedStale).toEqual([]);
  });
});

const persist = (over: Partial<TenantArrears> = {}): TenantArrears => ({ d30: 0, d60: 0, d90: 0, d90plus: 0, ...over });

describe('filterAgainstPersisted — cross-SWEEP guard (refute 2026-07-22, all 3 lenses)', () => {
  it('writes a lease with no persisted entry (first-ever import)', () => {
    const r = filterAgainstPersisted([w('L1', 100, new Date('2026-07-15'))], {});
    expect(r.toWrite.map((x) => x.leaseId)).toEqual(['L1']);
    expect(r.rejectedStale).toEqual([]);
  });

  it('REJECTS a stale report processed alone in a later sweep — the exact scenario resolveLatestArrears cannot see across sweeps', () => {
    // Sweep 1 already persisted July's $2,000 (paid down from June's $5,000). Sweep 2 processes ONLY
    // the missed June file — with no competing row in THIS sweep, resolveLatestArrears would trivially
    // keep it; this guard must catch it by comparing against what's already on disk.
    const persisted = { L1: persist({ d30: 2000, asOfDate: new Date('2026-07-15') }) };
    const incoming = [w('L1', 5000, new Date('2026-06-30'), 'june-missed.pdf')];
    const r = filterAgainstPersisted(incoming, persisted);
    expect(r.toWrite).toEqual([]);
    expect(r.rejectedStale).toEqual([{ leaseId: 'L1', incomingAsOf: new Date('2026-06-30'), persistedAsOf: new Date('2026-07-15') }]);
  });

  it('writes an incoming report newer than what is persisted', () => {
    const persisted = { L1: persist({ d30: 5000, asOfDate: new Date('2026-06-30') }) };
    const r = filterAgainstPersisted([w('L1', 2000, new Date('2026-07-15'), 'july.pdf')], persisted);
    expect(r.toWrite.map((x) => x.leaseId)).toEqual(['L1']);
    expect(r.rejectedStale).toEqual([]);
  });

  it('an exact as-of tie favors the incoming row (allows a same-day correction to update)', () => {
    const persisted = { L1: persist({ d30: 1000, asOfDate: new Date('2026-07-15') }) };
    const r = filterAgainstPersisted([w('L1', 900, new Date('2026-07-15'), 'corrected.pdf')], persisted);
    expect(r.toWrite.map((x) => x.leaseId)).toEqual(['L1']);
  });

  // refute round 3: the >= tie deliberately still writes (that's the correction channel), but the
  // write was previously indistinguishable in the log from a routine newer-date write.
  it('flags equalDateOverwrite when an exact as-of tie WRITES a differing bucket vector', () => {
    const persisted = { L1: persist({ d30: 1000, asOfDate: new Date('2026-07-15') }) };
    const r = filterAgainstPersisted([w('L1', 900, new Date('2026-07-15'), 'corrected.pdf')], persisted);
    expect(r.equalDateOverwrite).toEqual([{ leaseId: 'L1', asOf: new Date('2026-07-15') }]);
  });
  it('does NOT flag equalDateOverwrite when the tie agrees on every bucket (no real change)', () => {
    const persisted = { L1: persist({ d30: 1000, asOfDate: new Date('2026-07-15') }) };
    const r = filterAgainstPersisted([w('L1', 1000, new Date('2026-07-15'), 're-run.pdf')], persisted);
    expect(r.equalDateOverwrite).toEqual([]);
  });
  it('does NOT flag equalDateOverwrite for a genuinely newer (non-tied) write', () => {
    const persisted = { L1: persist({ d30: 5000, asOfDate: new Date('2026-06-01') }) };
    const r = filterAgainstPersisted([w('L1', 2000, new Date('2026-07-15'), 'july.pdf')], persisted);
    expect(r.equalDateOverwrite).toEqual([]);
  });

  // refute round 3: incomingUndated used to check only `=== null || undefined`, so an unparseable
  // STRING date (asOfMs -Infinity, same as null) fell into rejectedStale — the exact "staleness is
  // unproven, not established" mislabel the undatedConflict split was built to eliminate.
  it('an unparseable STRING asOfDate is an undatedConflict, not a rejectedStale mislabel (defined via asOfMs, not a null/undefined literal check)', () => {
    // Static TenantArrears types asOfDate as Date|null|undefined (post-Zod-coercion), but this
    // module's own asOfMs handles a raw string too — the realistic shape of unparsed/pre-Zod data.
    // Cast to construct that intentionally-malformed fixture directly.
    const persisted = { L1: persist({ d30: 1000, asOfDate: new Date('2026-07-15') }) };
    const corrupt = {
      leaseId: 'L1',
      tenant: 'L1',
      arrears: { d30: 900, d60: 0, d90: 0, d90plus: 0, asOfDate: 'not-a-real-date', sourceFile: 'x.pdf' },
    } as unknown as DatedArrearsWrite;
    const r = filterAgainstPersisted([corrupt], persisted);
    expect(r.toWrite).toEqual([]);
    expect(r.rejectedStale).toEqual([]);
    expect(r.undatedConflict.map((x) => x.leaseId)).toEqual(['L1']);
  });

  // refute round 2 (correctness+determinism lenses): the original 2-way split treated this as
  // "stale" and rejected it FOREVER — self-reinforcing, and factually wrong when the undated file was
  // actually the fresher one. It's now its own distinct, honestly-labeled outcome.
  it('an undated incoming row vs a DATED persisted entry is an undatedConflict, NOT a rejectedStale mislabel', () => {
    const persisted = { L1: persist({ d30: 1000, asOfDate: new Date('2026-07-15') }) };
    const r = filterAgainstPersisted([w('L1', 900, null, 'undated.pdf')], persisted);
    expect(r.toWrite).toEqual([]);
    expect(r.rejectedStale).toEqual([]);
    expect(r.undatedConflict).toEqual([{ leaseId: 'L1', persistedAsOf: new Date('2026-07-15') }]);
  });
  it('an undated incoming row vs an undated/legacy persisted entry is allowed through (no dated record to protect)', () => {
    const persisted = { L1: persist({ d30: 1000 }) }; // no asOfDate key — legacy, never dated
    const r = filterAgainstPersisted([w('L1', 900, null, 'undated.pdf')], persisted);
    expect(r.toWrite.map((x) => x.leaseId)).toEqual(['L1']);
    expect(r.undatedConflict).toEqual([]);
  });

  it('a dated incoming row beats an undated (legacy) persisted entry', () => {
    const persisted = { L1: persist({ d30: 1000 }) }; // no asOfDate key at all — legacy record
    const r = filterAgainstPersisted([w('L1', 900, new Date('2026-07-15'))], persisted);
    expect(r.toWrite.map((x) => x.leaseId)).toEqual(['L1']);
  });

  it('handles a mixed batch: some leases write, some are rejected stale', () => {
    const persisted = {
      L1: persist({ d30: 100, asOfDate: new Date('2026-07-20') }), // newer than incoming -> reject
      L2: persist({ d30: 200, asOfDate: new Date('2026-06-01') }), // older than incoming -> write
    };
    const r = filterAgainstPersisted(
      [w('L1', 999, new Date('2026-07-01')), w('L2', 999, new Date('2026-07-01')), w('L3', 999, new Date('2026-07-01'))],
      persisted,
    );
    expect(r.toWrite.map((x) => x.leaseId).sort()).toEqual(['L2', 'L3']);
    expect(r.rejectedStale.map((x) => x.leaseId)).toEqual(['L1']);
  });
});
