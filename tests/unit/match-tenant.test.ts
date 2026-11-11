import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchTenantToLease, normalizeTokens, type LeaseLite } from '../../server/ar/match-tenant';
import { partitionArRows } from '../../server/ar/partition-confidence';

const leases: LeaseLite[] = [
  { id: 'l-acme', tenantName: 'Acme Industrial', company: 'Acme Industrial, LLC' },
  { id: 'l-bbt', tenantName: 'Building Bridges Therapy Svcs', company: null },
  { id: 'l-foxwell', tenantName: 'Louis W. Foxwell', company: null },
  { id: 'l-kelvar', tenantName: 'Kelvar Service', company: 'Kelvar Service a division of Kelvar Food Equipment Group, LLC' },
  { id: 'l-zeta', tenantName: 'Zeta Logistics', company: null },
  { id: 'l-qrt', tenantName: 'Dana Quill', company: 'Q.R.T LLC' },
];

describe('normalizeTokens', () => {
  it('strips entity suffixes and punctuation', () => {
    expect(normalizeTokens('Acme Industrial, LLC')).toEqual(['acme', 'industrial']);
    expect(normalizeTokens('Kelvar Service, Inc.')).toEqual(['kelvar', 'service']);
  });
  it('reorders "Last, First" person names', () => {
    expect(normalizeTokens('FOXWELL, LOUIS W.')).toEqual(['louis', 'w', 'foxwell']);
  });
  it('drops an entity suffix that follows a comma (not a person reorder)', () => {
    expect(normalizeTokens('Harbor Lane Designs, LTD')).toEqual(['harbor', 'lane', 'designs']);
  });

  // Real defect (found 2026-08-16 reconciling the a tenant's AR balance against the real lease roster):
  // a dotted initialism like 'Q.R.T' tokenized to THREE single-letter tokens ['i','m','h'] instead of
  // one ['qrt'], because the generic punctuation strip turns every period into a space regardless of
  // context. The AR export's own spelling ('QRT LLC', no dots) tokenized to ['qrt'] -- zero overlap
  // between the two, so a real $32,291.95 balance with an EXACT lease match sitting in the company
  // field ('Q.R.T LLC') was reported as 'no match', reading as an orphan balance with no lease at all.
  it('collapses a dotted initialism (2+ single-letter dots) into one token', () => {
    expect(normalizeTokens('Q.R.T LLC')).toEqual(['qrt']);
    expect(normalizeTokens('Q.R.T. LLC')).toEqual(['qrt']); // trailing dot on the last initial too
    expect(normalizeTokens('QRT LLC')).toEqual(['qrt']); // the AR export's own undotted spelling
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
    const m = matchTenantToLease('Kelvar Food Equipment Group', leases);
    expect(m.leaseId).toBe('l-kelvar'); // overlaps the company string
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
    // The company field ('Q.R.T LLC') carries the dots; the PM export's own name ('QRT LLC') doesn't.
    // Real balance: $32,291.95, previously reported as an orphan with no lease at all.
    const m = matchTenantToLease('QRT LLC', leases);
    expect(m.leaseId).toBe('l-qrt');
    expect(m.confidence).toBe('exact');
  });

  // Real defect (2026-09-06 adversarial review): overlap() counted a report-name token once PER
  // OCCURRENCE instead of once, so a report name with a repeated token ("Pell" appears twice in
  // "Avery Jon Pell & Morgan Pell") produced an intersection count larger than either side's
  // token-set size, pushing the score above 1.0. That let a SHORTER, non-exact candidate ("Karishma
  // Pell") outscore the true EXACT candidate (score exactly 1) and WIN OUTRIGHT (no ambiguity flag
  // at all), silently attributing the report row's balance to the wrong lease.
  //
  // A same-day self-review of the FIRST fix attempt (which additionally made "exact" strictly
  // dominate any tied non-exact candidate) found that dominance rule itself introduces a DIFFERENT
  // silent mis-attribution: a report name that is exactly one lease's name and also a genuine
  // token-subset of a different lease's longer name (the real "Kelvar" vs "Kelvar Service" wrap
  // case this scorer exists to handle) is precisely the coin-flip the ambiguity flag is designed to
  // catch, and forcing exact to win regardless bypasses that human-review gate entirely. The correct
  // fix is narrower: bound the score to [0,1] so a non-exact candidate can at most TIE an exact
  // match (never beat it outright); a tie between two DIFFERENT leases already sets `ambiguous` via
  // the pre-existing tie-detection logic below, which is what actually prevents the wrong-lease
  // write (partitionArRows requires `!ambiguous` to auto-accept).
  it('bounds a repeated report-name token to score <=1 and flags the tie ambiguous (never silently picks a side)', () => {
    const dup: LeaseLite[] = [
      { id: 'l-exact', tenantName: 'Avery Jon Pell & Morgan Pell', company: null },
      { id: 'l-wrong', tenantName: 'Morgan Pell', company: null },
    ];
    const m = matchTenantToLease('Avery Jon Pell & Morgan Pell', dup);
    expect(m.score).toBeLessThanOrEqual(1);
    expect(m.ambiguous).toBe(true); // a human must confirm — never auto-written either way
  });

  it('the same tie is flagged ambiguous regardless of roster order (order affects the label only, never the safety outcome)', () => {
    const forward: LeaseLite[] = [
      { id: 'l-exact', tenantName: 'Avery Jon Pell & Morgan Pell', company: null },
      { id: 'l-wrong', tenantName: 'Morgan Pell', company: null },
    ];
    const reversed = [...forward].reverse();
    for (const roster of [forward, reversed]) {
      const m = matchTenantToLease('Avery Jon Pell & Morgan Pell', roster);
      expect(m.score).toBeLessThanOrEqual(1);
      expect(m.ambiguous).toBe(true);
    }
  });

  it('minimal repeated-token case: a duplicated-word report name still bounds at 1.0 and is flagged ambiguous', () => {
    const dup: LeaseLite[] = [
      { id: 'l-exact', tenantName: 'Pell Pell Consulting', company: null },
      { id: 'l-wrong', tenantName: 'Pell', company: null },
    ];
    const m = matchTenantToLease('Pell Pell Consulting', dup);
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
  // real wrap/truncation case (e.g. a PDF-truncated "Kelvar" matching both "Kelvar" exactly and
  // "Kelvar Service" as a 1.0 subset). That case must stay a human decision.
  it('an exact match for one lease that also subset-matches a DIFFERENT lease at 1.0 stays ambiguous, never auto-resolved', () => {
    const roster: LeaseLite[] = [
      { id: 'l-short', tenantName: 'Kelvar', company: null },
      { id: 'l-long', tenantName: 'Kelvar Service', company: null },
    ];
    for (const leases of [roster, [...roster].reverse()]) {
      const m = matchTenantToLease('Kelvar', leases);
      expect(m.ambiguous).toBe(true);
    }
  });
});

// 2026-09-14 weekly financial-code sweep, Fix C: tie-break determinism. `ambiguous` (topCount > 1)
// was already order-independent -- a tie between two different leases is flagged whatever order
// the roster arrives in, and both consumers (partitionArRows, scripts/ar-import.ts) require
// `!ambiguous` to auto-write, so this was never a safety hole. What WAS order-dependent is which
// candidate got REPORTED alongside `ambiguous: true`: `best` (leaseId / candidate / exact, hence
// `confidence`) was whichever tied lease the loop met first, so the same report name produced a
// different review-queue row ("exact -> 401-sunburst..." vs "high -> 29000-information-lane...")
// depending on snapshot array order. The fix is a secondary tie-break to the lexicographically
// smaller leaseId for the REPORTED best only -- the exact-vs-subset rule (PR #320) and the
// ambiguity computation are untouched, and a tie can never stop being flagged.
describe('matchTenantToLease — tie-break determinism against the committed lease roster (Fix C)', () => {
  // Regression guard over the whole committed roster, not a hand-built fixture. The committed snapshot
  // is SYNTHETIC (real firm data is never tracked, ruling 2026-11-10): tenant names are aliased, so the
  // identical-name pair is derived from the roster, and the exact-vs-1.0-subset company pair (two
  // distinct names whose tokens nest) is injected with made-up names. Read directly by path --
  // tests/setup.ts redirects SNAPSHOT_PATH to a tmp sandbox for WRITERS; this never writes.
  const snapshot = JSON.parse(readFileSync(join(process.cwd(), 'data', 'snapshots', 'portfolio.json'), 'utf8')) as {
    leases: Array<{ id: string; tenantName: string; company: string | null }>;
  };
  const SUBSET_EXACT = 'THE HARBOR VIEW CORPORATION';
  const SUBSET_WIDER = 'Harbor View Exteriors LLC';
  const roster: LeaseLite[] = [
    ...snapshot.leases.map((l) => ({ id: l.id, tenantName: l.tenantName, company: l.company ?? null })),
    { id: 'zz-synthetic-harbor-view-corporation', tenantName: 'Synthetic Contact A', company: SUBSET_EXACT },
    { id: 'zz-synthetic-harbor-view-exteriors-llc', tenantName: 'Synthetic Contact B', company: SUBSET_WIDER },
  ];
  // A tenantName that appears on two or more leases (the real roster has one such pair; aliasing keeps it).
  const counts = new Map<string, number>();
  for (const l of roster) counts.set(l.tenantName, (counts.get(l.tenantName) ?? 0) + 1);
  const DUP_NAME = [...counts].filter(([, n]) => n >= 2).map(([name]) => name).sort()[0] ?? '';

  // Deterministic PRNG (mulberry32) + Fisher-Yates so the shuffles are reproducible from the seed.
  function seededShuffle<T>(items: readonly T[], seed: number): T[] {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  const orderings = (): Array<[string, LeaseLite[]]> => [
    ['forward', roster],
    ['reversed', [...roster].reverse()],
    ...[1, 2, 3, 4, 5].map((seed): [string, LeaseLite[]] => [`shuffle seed ${seed}`, seededShuffle(roster, seed)]),
  ];

  it('the roster carries the two tie shapes this guard depends on (fails loudly if the snapshot drifts)', () => {
    expect(DUP_NAME, 'no tenantName appears on two leases').not.toBe('');
    expect(roster.filter((l) => l.tenantName === DUP_NAME).length).toBeGreaterThanOrEqual(2);
    expect(roster.some((l) => l.company === SUBSET_EXACT)).toBe(true);
    expect(roster.some((l) => l.company === SUBSET_WIDER)).toBe(true);
  });

  for (const [label, name] of [['identical-name pair', () => DUP_NAME], ['exact company', () => SUBSET_EXACT], ['subset company', () => SUBSET_WIDER]] as const) {
    it(`${label}: forward, reversed, and five seeded shuffles of the roster return DEEP-EQUAL results`, () => {
      const reference = matchTenantToLease(name(), roster);
      for (const [order, ordered] of orderings()) {
        expect(matchTenantToLease(name(), ordered), order).toEqual(reference);
      }
    });
  }

  it('the identical-name pair (two leases, identical tenantName) is ambiguous and reports the smaller leaseId in every order', () => {
    const ids = roster.filter((l) => l.tenantName === DUP_NAME).map((l) => l.id).sort();
    for (const [label, ordered] of orderings()) {
      const m = matchTenantToLease(DUP_NAME, ordered);
      expect(m.ambiguous, label).toBe(true);
      expect(m.leaseId, label).toBe(ids[0]);
    }
  });

  it('an exact company name that is also a 1.0 subset of another stays ambiguous (PR #320) and routes to review in every order', () => {
    for (const [label, ordered] of orderings()) {
      const m = matchTenantToLease(SUBSET_EXACT, ordered);
      expect(m.ambiguous, label).toBe(true);
      const p = partitionArRows([{ tenant: SUBSET_EXACT, property: null, d30: 1, d60: 0, d90: 0, d90plus: 0 }], ordered);
      expect(p.write, label).toEqual([]);
      expect(p.review, label).toHaveLength(1);
    }
  });

  it('synthetic: tied candidates report the lexicographically smaller leaseId as best, whichever is met first', () => {
    const a: LeaseLite = { id: 'l-aaa', tenantName: 'Summit Storage', company: null };
    const z: LeaseLite = { id: 'l-zzz', tenantName: 'Summit Storage', company: null };
    for (const leases of [[a, z], [z, a]]) {
      const m = matchTenantToLease('Summit Storage', leases);
      expect(m).toEqual({ leaseId: 'l-aaa', confidence: 'exact', score: 1, candidate: 'Summit Storage', ambiguous: true });
    }
  });

  it('synthetic: the tie-break carries the winning candidate\'s own exact flag (confidence follows the reported lease, deterministically)', () => {
    // 'l-a' is a 1.0 SUBSET match (not exact), 'l-b' is the exact match. Smaller id wins the
    // REPORT ('l-a', confidence 'high'), and the tie is still flagged -- exact does NOT dominate.
    const subset: LeaseLite = { id: 'l-a', tenantName: 'Kelvar Service', company: null };
    const exact: LeaseLite = { id: 'l-b', tenantName: 'Kelvar', company: null };
    for (const leases of [[subset, exact], [exact, subset]]) {
      const m = matchTenantToLease('Kelvar', leases);
      expect(m).toEqual({ leaseId: 'l-a', confidence: 'high', score: 1, candidate: 'Kelvar Service', ambiguous: true });
    }
  });

  it('synthetic: a strictly better later candidate still wins outright and clears the tie (tie-break never overrides a real winner)', () => {
    // Neither smaller-id candidate reaches 1.0 ('Delta Widgets' = 0.5, 'Delta Force Holdings
    // Group' = 2/3) -- NOT a subset tie like 'Delta Force LLC' would be. Only 'l-z' is exact.
    const roster2: LeaseLite[] = [
      { id: 'l-a', tenantName: 'Delta Widgets', company: null },
      { id: 'l-b', tenantName: 'Delta Force Holdings Group', company: null },
      { id: 'l-z', tenantName: 'Delta Force Services', company: null },
    ];
    for (const leases of [roster2, [...roster2].reverse()]) {
      const m = matchTenantToLease('Delta Force Services', leases);
      expect(m).toEqual({ leaseId: 'l-z', confidence: 'exact', score: 1, candidate: 'Delta Force Services', ambiguous: false });
    }
  });
});
