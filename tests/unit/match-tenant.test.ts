import { describe, it, expect } from 'vitest';
import { matchTenantToLease, normalizeTokens, type LeaseLite } from '../../server/ar/match-tenant';

const leases: LeaseLite[] = [
  { id: 'l-acme', tenantName: 'Acme Industrial', company: 'Acme Industrial, LLC' },
  { id: 'l-bbt', tenantName: 'Building Bridges Therapy Svcs', company: null },
  { id: 'l-foxwell', tenantName: 'Louis W. Foxwell', company: null },
  { id: 'l-hobart', tenantName: 'Hobart Service', company: 'Hobart Service a division of ITW Food Equipment Group, LLC' },
  { id: 'l-zeta', tenantName: 'Zeta Logistics', company: null },
  { id: 'l-imh', tenantName: 'Hanan Malul', company: 'I.M.H LLC' },
];

describe('normalizeTokens', () => {
  it('strips entity suffixes and punctuation', () => {
    expect(normalizeTokens('Acme Industrial, LLC')).toEqual(['acme', 'industrial']);
    expect(normalizeTokens('Hobart Service, Inc.')).toEqual(['hobart', 'service']);
  });
  it('reorders "Last, First" person names', () => {
    expect(normalizeTokens('FOXWELL, LOUIS W.')).toEqual(['louis', 'w', 'foxwell']);
  });
  it('drops an entity suffix that follows a comma (not a person reorder)', () => {
    expect(normalizeTokens('Curtis Elliott Designs, LTD')).toEqual(['curtis', 'elliott', 'designs']);
  });

  // Real defect (found 2026-08-16 reconciling the IMH LLC AR balance against the real lease roster):
  // a dotted initialism like 'I.M.H' tokenized to THREE single-letter tokens ['i','m','h'] instead of
  // one ['imh'], because the generic punctuation strip turns every period into a space regardless of
  // context. The AR export's own spelling ('IMH LLC', no dots) tokenized to ['imh'] -- zero overlap
  // between the two, so a real $32,291.95 balance with an EXACT lease match sitting in the company
  // field ('I.M.H LLC') was reported as 'no match', reading as an orphan balance with no lease at all.
  it('collapses a dotted initialism (2+ single-letter dots) into one token', () => {
    expect(normalizeTokens('I.M.H LLC')).toEqual(['imh']);
    expect(normalizeTokens('I.M.H. LLC')).toEqual(['imh']); // trailing dot on the last initial too
    expect(normalizeTokens('IMH LLC')).toEqual(['imh']); // the AR export's own undotted spelling
  });

  it('does NOT collapse a single dotted initial — only 2+ in a row', () => {
    // Must not regress the existing 'FOXWELL, LOUIS W.' case two tests up: a lone middle initial
    // stays its own token, exactly as a single first/middle initial before a full name always has.
    expect(normalizeTokens('A. Anderson')).toEqual(['a', 'anderson']);
  });

  it('collapses a longer dotted initialism (U.P.S. style)', () => {
    expect(normalizeTokens('P.U.P.S. Dog Obedience Training')).toEqual(['pups', 'dog', 'obedience', 'training']);
  });
});

describe('matchTenantToLease', () => {
  it('exact match (modulo entity suffix) → exact confidence', () => {
    const m = matchTenantToLease('Acme Industrial', leases);
    expect(m.leaseId).toBe('l-acme');
    expect(m.confidence).toBe('exact');
  });

  it('matches against the company field, not just tenantName', () => {
    const m = matchTenantToLease('ITW Food Equipment Group', leases);
    expect(m.leaseId).toBe('l-hobart'); // overlaps the company string
    expect(['high', 'low']).toContain(m.confidence);
  });

  it('a wrapped/truncated report name that is a subset still matches high', () => {
    // PDF extraction dropped "Svcs" — the report name is a subset of the rent-roll name.
    const m = matchTenantToLease('Building Bridges Therapy', leases);
    expect(m.leaseId).toBe('l-bbt');
    expect(m.confidence).toBe('high');
    expect(m.score).toBe(1); // subset → 1.0 via smaller-set overlap
  });

  it('reordered person name matches', () => {
    const m = matchTenantToLease('Foxwell, Louis W.', leases);
    expect(m.leaseId).toBe('l-foxwell');
    expect(['exact', 'high']).toContain(m.confidence);
  });

  it('no plausible match → none + null leaseId (human must map)', () => {
    const m = matchTenantToLease('Completely Different Tenant XYZ', leases);
    expect(m.leaseId).toBeNull();
    expect(m.confidence).toBe('none');
  });

  it('a single shared token among multi-token names stays below the floor (no false high)', () => {
    // "Zeta Holdings" shares only "zeta" with "Zeta Logistics" → 0.5 overlap → low, not high.
    const m = matchTenantToLease('Zeta Holdings', leases);
    expect(m.confidence).toBe('low');
  });

  it('flags ambiguity when two leases tie at the top score', () => {
    const dup: LeaseLite[] = [
      { id: 'l-1', tenantName: 'Summit Storage', company: null },
      { id: 'l-2', tenantName: 'Summit Storage', company: null },
    ];
    const m = matchTenantToLease('Summit Storage', dup);
    expect(m.ambiguous).toBe(true);
  });

  it('empty / junk report name → none, never throws', () => {
    expect(matchTenantToLease('', leases).confidence).toBe('none');
    expect(matchTenantToLease('   ,  ', leases).confidence).toBe('none');
  });

  it('matches a dotted-initialism company field against an undotted AR spelling — real case', () => {
    // The company field ('I.M.H LLC') carries the dots; the PM export's own name ('IMH LLC') doesn't.
    // Real balance: $32,291.95, previously reported as an orphan with no lease at all.
    const m = matchTenantToLease('IMH LLC', leases);
    expect(m.leaseId).toBe('l-imh');
    expect(m.confidence).toBe('exact');
  });

  // Real defect (2026-09-06 adversarial review): overlap() counted a report-name token once PER
  // OCCURRENCE instead of once, so a report name with a repeated token ("Syed" appears twice in
  // "Ahmed Kareem Syed & Karishma Syed") produced an intersection count larger than either side's
  // token-set size, pushing the score above 1.0. That let a SHORTER, non-exact candidate ("Karishma
  // Syed") outscore the true EXACT candidate (score exactly 1) and WIN OUTRIGHT (no ambiguity flag
  // at all), silently attributing the report row's balance to the wrong lease.
  //
  // A same-day self-review of the FIRST fix attempt (which additionally made "exact" strictly
  // dominate any tied non-exact candidate) found that dominance rule itself introduces a DIFFERENT
  // silent mis-attribution: a report name that is exactly one lease's name and also a genuine
  // token-subset of a different lease's longer name (the real "Hobart" vs "Hobart Service" wrap
  // case this scorer exists to handle) is precisely the coin-flip the ambiguity flag is designed to
  // catch, and forcing exact to win regardless bypasses that human-review gate entirely. The correct
  // fix is narrower: bound the score to [0,1] so a non-exact candidate can at most TIE an exact
  // match (never beat it outright); a tie between two DIFFERENT leases already sets `ambiguous` via
  // the pre-existing tie-detection logic below, which is what actually prevents the wrong-lease
  // write (partitionArRows requires `!ambiguous` to auto-accept).
  it('bounds a repeated report-name token to score <=1 and flags the tie ambiguous (never silently picks a side)', () => {
    const dup: LeaseLite[] = [
      { id: 'l-exact', tenantName: 'Ahmed Kareem Syed & Karishma Syed', company: null },
      { id: 'l-wrong', tenantName: 'Karishma Syed', company: null },
    ];
    const m = matchTenantToLease('Ahmed Kareem Syed & Karishma Syed', dup);
    expect(m.score).toBeLessThanOrEqual(1);
    expect(m.ambiguous).toBe(true); // a human must confirm — never auto-written either way
  });

  it('the same tie is flagged ambiguous regardless of roster order (order affects the label only, never the safety outcome)', () => {
    const forward: LeaseLite[] = [
      { id: 'l-exact', tenantName: 'Ahmed Kareem Syed & Karishma Syed', company: null },
      { id: 'l-wrong', tenantName: 'Karishma Syed', company: null },
    ];
    const reversed = [...forward].reverse();
    for (const roster of [forward, reversed]) {
      const m = matchTenantToLease('Ahmed Kareem Syed & Karishma Syed', roster);
      expect(m.score).toBeLessThanOrEqual(1);
      expect(m.ambiguous).toBe(true);
    }
  });

  it('minimal repeated-token case: a duplicated-word report name still bounds at 1.0 and is flagged ambiguous', () => {
    const dup: LeaseLite[] = [
      { id: 'l-exact', tenantName: 'Syed Syed Consulting', company: null },
      { id: 'l-wrong', tenantName: 'Syed', company: null },
    ];
    const m = matchTenantToLease('Syed Syed Consulting', dup);
    expect(m.score).toBeLessThanOrEqual(1);
    expect(m.ambiguous).toBe(true);
  });

  // Real defect in an EARLIER version of this same-day fix (2026-09-06 self-review, HIGH): the
  // overlap() denominator was changed to use the DEDUPED candidate-side size, which shrinks for a
  // candidate whose own name repeats a token — silently promoting a genuinely low-confidence match
  // to high-confidence and auto-writing it unattended. The denominator must stay the RAW candidate
  // length (matching the original, pre-fix code) — only the intersection COUNT is deduped.
  it('a repeated token in the CANDIDATE (lease) name does not shrink the denominator and inflate the score', () => {
    const leases: LeaseLite[] = [{ id: 'l-smith-smith', tenantName: 'Smith & Smith LLC', company: null }];
    const m = matchTenantToLease('John Smith', leases);
    expect(m.score).toBe(0.5); // NOT 1.0 — "smith" is 1 of 2 report tokens vs the true 2-token candidate name
    expect(m.confidence).toBe('low');
  });

  // Real defect in the SAME earlier fix attempt (MEDIUM): making "exact" strictly dominate silently
  // removed the ambiguity flag for an exact-vs-genuine-subset tie between two DIFFERENT leases — the
  // real wrap/truncation case (e.g. a PDF-truncated "Hobart" matching both "Hobart" exactly and
  // "Hobart Service" as a 1.0 subset). That case must stay a human decision.
  it('an exact match for one lease that also subset-matches a DIFFERENT lease at 1.0 stays ambiguous, never auto-resolved', () => {
    const roster: LeaseLite[] = [
      { id: 'l-short', tenantName: 'Hobart', company: null },
      { id: 'l-long', tenantName: 'Hobart Service', company: null },
    ];
    for (const leases of [roster, [...roster].reverse()]) {
      const m = matchTenantToLease('Hobart', leases);
      expect(m.ambiguous).toBe(true);
    }
  });
});
