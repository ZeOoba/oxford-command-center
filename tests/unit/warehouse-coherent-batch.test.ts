import { describe, expect, it } from 'vitest';
import { selectCoherentBatch } from '../../server/warehouse/metrics';

// selectCoherentBatch resolves a (property, period) group that contains rows from more than one
// active import down to ONE coherent batch. Drive the tie-break directly with synthetic single-row
// batches (only importId/grainHint/periodEnd matter to the selector).
type Row = Parameters<typeof selectCoherentBatch>[0][number];
const r = (importId: number, grainHint: string | null, periodEnd: string | null): Row =>
  ({ importId, grainHint, periodEnd } as unknown as Row);

describe('selectCoherentBatch tie-break (G1)', () => {
  it('full-year beats a same-year YTD regardless of arg order', () => {
    const year = r(1, 'year', '2026-12-31');
    const ytd = r(2, 'ytd', '2026-06-30');
    expect(selectCoherentBatch([ytd, year])[0]).toBe(year);
    expect(selectCoherentBatch([year, ytd])[0]).toBe(year);
  });

  it('among same-grain batches with BOTH ends known, the later period_end wins', () => {
    const q1 = r(1, 'ytd', '2026-03-31');
    const h1 = r(2, 'ytd', '2026-06-30');
    expect(selectCoherentBatch([q1, h1])[0]).toBe(h1);
    expect(selectCoherentBatch([h1, q1])[0]).toBe(h1);
  });

  it('G1-null: a NEWER restatement with a null period_end (header parse miss) beats a staler dated batch', () => {
    // Defect: null period_end was coalesced to '' (sorts lowest) so the staler dated batch always won.
    // A null end = unknown scope ⇒ defer to import_id; the later import (restatement) wins.
    const staleDatedQ1 = r(1, 'ytd', '2026-03-31');
    const newerNullEnd = r(2, 'ytd', null);
    expect(selectCoherentBatch([staleDatedQ1, newerNullEnd])[0]).toBe(newerNullEnd);
    expect(selectCoherentBatch([newerNullEnd, staleDatedQ1])[0]).toBe(newerNullEnd);
  });

  it('both ends null ⇒ latest import wins', () => {
    const older = r(1, 'ytd', null);
    const newer = r(2, 'ytd', null);
    expect(selectCoherentBatch([older, newer])[0]).toBe(newer);
  });

  it('is order-invariant for 3+ same-grain batches mixing a null end with two dated ends (transitive total order)', () => {
    // The intransitive pairwise rule (period_end vs importId switched on null-ness) made the winner
    // depend on Map/SQLite row order. A=(id1,Dec31), B=(id2,null), C=(id3,Mar31), all YTD form a
    // 3-cycle under the old rule. A total order must pick the SAME batch for all 6 input permutations.
    const A = r(1, 'ytd', '2026-12-31');
    const B = r(2, 'ytd', null);
    const C = r(3, 'ytd', '2026-03-31');
    const perms = [
      [A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A],
    ];
    const winners = perms.map((p) => selectCoherentBatch(p)[0]!.importId);
    expect(new Set(winners).size).toBe(1); // identical winner regardless of order
    // null end = unknown scope, treated as most-recent (restatement) ⇒ B wins; dated partials lose.
    expect(winners[0]).toBe(2);
  });

  it('a single import passes through unchanged', () => {
    const only = r(5, 'year', '2025-12-31');
    const out = selectCoherentBatch([only]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(only);
  });
});
