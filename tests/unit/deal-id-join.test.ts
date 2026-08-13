// tests/unit/deal-id-join.test.ts
//
// The id-based seed↔Notion join (Gabriel-approved 2026-08-12; plan:
// docs/superpowers/plans/2026-08-12-deal-id-join.md).
//
// These tests are stated over the INVARIANT — "two rows are the same deal iff they carry the same
// opaque Deal ID" — rather than over any mechanism that could imply it. That is the lesson PR #271
// paid for three times: every guard phrased over a mechanism (the locality strip, then the alias
// path, then dealJoinKey-equality-as-"exact") left a path that violated the invariant it was meant
// to protect.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DataQualityFlag, Deal } from '../../src/contracts/index';
import { mapNotionPage, mergeDeals } from '../../server/sources/notion-deals';

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

const page = (over: Record<string, unknown> = {}) => ({
  properties: {
    'Deal Name': { type: 'title', title: [{ plain_text: 'Maple Logistics' }] },
    'Deal ID': { type: 'unique_id', unique_id: { prefix: 'DEAL', number: 7 } },
    ...over,
  },
});

afterEach(() => vi.restoreAllMocks());

describe('mapNotionPage — the Deal ID property', () => {
  it('reads Notion’s unique_id into notionDealId as "<prefix>-<number>"', () => {
    expect(mapNotionPage(page())!.notionDealId).toBe('DEAL-7');
  });

  it('renders a bare number when the property carries no prefix', () => {
    const p = page({ 'Deal ID': { type: 'unique_id', unique_id: { prefix: null, number: 12 } } });
    expect(mapNotionPage(p)!.notionDealId).toBe('12');
  });

  it('is null when the property is absent — the row is UNJOINABLE, never name-matched', () => {
    const p = { properties: { 'Deal Name': { type: 'title', title: [{ plain_text: 'Maple' }] } } };
    expect(mapNotionPage(p)!.notionDealId).toBeNull();
  });
});

describe('mergeDeals — the id is the whole join', () => {
  it('JOINS rows whose names are completely different, because the ids agree', () => {
    // The alias map existed for exactly this and was a standing source of defects. The id makes the
    // names irrelevant: NOTION_DEALS_NAME_ALIASES is retired, not replaced.
    const seed = [deal({ id: 'seed-fulton', name: 'E. Fulton Street Industrial', notionDealId: 'DEAL-3' })];
    const live = [deal({ id: 'n', name: 'E Fulton Street Portfolio — Columbus, OH', notionDealId: 'DEAL-3', estPrice: 4_200_000 })];
    const flags: DataQualityFlag[] = [];
    const out = mergeDeals(seed, live, flags);

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('seed-fulton');
    expect(out[0]!.name).toBe('E. Fulton Street Industrial'); // seed identity preserved
    expect(out[0]!.estPrice).toBe(4_200_000); // live economics merged
    expect(flags).toHaveLength(0);
  });

  it('does NOT join two rows with IDENTICAL names when the ids differ', () => {
    // The CRITICAL cross-side wrong merge, stated as an invariant. Under the name key this merged
    // one deal's economics into the other's identity and published it under the seed's public flag.
    const seed = [deal({ id: 'seed-a', name: '470 McCormick Blvd', notionDealId: 'DEAL-1', confidential: false })];
    const live = [deal({ id: 'n', name: '470 McCormick Blvd', notionDealId: 'DEAL-99', estPrice: 9_000_000 })];
    const flags: DataQualityFlag[] = [];
    const out = mergeDeals(seed, live, flags);

    expect(out).toHaveLength(2); // both survive — nothing is destroyed in either direction
    expect(out.find((d) => d.id === 'seed-a')!.estPrice).toBeNull(); // seed NOT enriched
    expect(out.find((d) => d.id === 'n')!.confidential).toBe(true); // live row fails closed
  });

  it('preserves the seed id, confidential flag, and shortName through a merge', () => {
    const seed = [deal({ id: 'seed-x', name: 'X', shortName: 'XX', confidential: true, notionDealId: 'DEAL-5' })];
    const live = [deal({ id: 'n', name: 'X — Columbus, OH', notionDealId: 'DEAL-5', stage: 'Closing', confidential: false })];
    const out = mergeDeals(seed, live, []);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'seed-x', shortName: 'XX', confidential: true, stage: 'Closing' });
  });
});

describe('mergeDeals — a missing or duplicate id REFUSES; it never falls back to names', () => {
  it('holds an idless live row out of the merge, failing it closed to confidential', () => {
    const seed = [deal({ id: 'seed-a', name: 'Same Name', notionDealId: 'DEAL-1' })];
    const live = [deal({ id: 'n', name: 'Same Name', notionDealId: null, estPrice: 5_000_000 })];
    const flags: DataQualityFlag[] = [];
    const out = mergeDeals(seed, live, flags);

    expect(out.find((d) => d.id === 'seed-a')!.estPrice).toBeNull();
    expect(out.find((d) => d.id === 'n')!.confidential).toBe(true);
    expect(flags.filter((f) => f.severity === 'error')).toHaveLength(1);
  });

  it('aggregates idless live rows into ONE flag rather than one per row', () => {
    // A deleted/renamed Deal ID property makes EVERY row idless. Twenty identical error flags is
    // noise that buries the cause; the count is the diagnostic.
    const live = [1, 2, 3].map((i) => deal({ id: `n${i}`, name: `N${i}`, notionDealId: null }));
    const flags: DataQualityFlag[] = [];
    mergeDeals([], live, flags);

    const errs = flags.filter((f) => f.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.issue).toContain('3');
  });

  it('refuses every live row sharing a duplicated id, and fails them all closed', () => {
    const seed = [deal({ id: 'seed-a', name: 'A', notionDealId: 'DEAL-1' })];
    const live = [
      deal({ id: 'n1', name: 'First', notionDealId: 'DEAL-1', estPrice: 1 }),
      deal({ id: 'n2', name: 'Second', notionDealId: 'DEAL-1', estPrice: 2 }),
    ];
    const flags: DataQualityFlag[] = [];
    const out = mergeDeals(seed, live, flags);

    expect(out).toHaveLength(3); // nothing dropped
    expect(out.find((d) => d.id === 'seed-a')!.estPrice).toBeNull();
    expect(out.filter((d) => d.id.startsWith('n')).every((d) => d.confidential)).toBe(true);
    expect(flags.some((f) => f.severity === 'error')).toBe(true);
  });

  it('refuses every SEED row sharing a duplicated id', () => {
    // Ambiguity on the seed side is unmergeable on the seed side — one seed must not claim the live
    // row while its twin reports the row was "kept separate". (PR #271, fourth pass, LOW.)
    const seed = [
      deal({ id: 'seed-a', name: 'A', notionDealId: 'DEAL-1' }),
      deal({ id: 'seed-b', name: 'B', notionDealId: 'DEAL-1' }),
    ];
    const live = [deal({ id: 'n', name: 'N', notionDealId: 'DEAL-1', estPrice: 7 })];
    const flags: DataQualityFlag[] = [];
    const out = mergeDeals(seed, live, flags);

    expect(out.find((d) => d.id === 'seed-a')!.estPrice).toBeNull();
    expect(out.find((d) => d.id === 'seed-b')!.estPrice).toBeNull();
    expect(out.find((d) => d.id === 'n')!.confidential).toBe(true);
    expect(flags.some((f) => f.severity === 'error')).toBe(true);
  });

  it('leaves a seed whose id matches nothing live unenriched, WITHOUT an error', () => {
    // Legitimate steady state: a seed deal that has left the pipeline. Erroring here would block
    // every write with no remedy short of deleting the seed row.
    const seed = [deal({ id: 'seed-a', name: 'Closed Deal', notionDealId: 'DEAL-1' })];
    const flags: DataQualityFlag[] = [];
    const out = mergeDeals(seed, [deal({ id: 'n', name: 'Other', notionDealId: 'DEAL-2' })], flags);

    expect(out).toHaveLength(2);
    expect(flags.filter((f) => f.severity === 'error')).toHaveLength(0);
  });
});

describe('mergeDeals — the migration tripwire: names are evidence for DETECTION, never for merging', () => {
  it('warns when an unjoined seed and an unjoined live row look like one deal', () => {
    const seed = [deal({ id: 'seed-pendleton', name: 'Pendleton Trade Center', notionDealId: null })];
    const live = [deal({ id: 'n', name: 'Pendleton Trade Center — Pendleton, IN', notionDealId: 'DEAL-8' })];
    const flags: DataQualityFlag[] = [];
    const out = mergeDeals(seed, live, flags);

    // Detected, but NOT merged: both rows survive and the live one still fails closed.
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.id === 'n')!.confidential).toBe(true);
    const warn = flags.find((f) => f.severity === 'warn')!;
    expect(warn).toBeDefined();
    expect(warn.issue).toContain('DEAL-8'); // the id is opaque — safe and actionable in a flag
  });

  it('stays silent when the unjoined rows are genuinely different deals', () => {
    const seed = [deal({ id: 'seed-a', name: '100 Main St', notionDealId: null })];
    const live = [deal({ id: 'n', name: '200 Main St — Columbus, OH', notionDealId: 'DEAL-9' })];
    const flags: DataQualityFlag[] = [];
    mergeDeals(seed, live, flags);

    expect(flags.filter((f) => f.severity === 'warn')).toHaveLength(0);
  });
});

describe('mergeDeals — flags reach the PUBLIC mirror, so they must not carry deal names', () => {
  it('names no deal in any flag text or rawValue, while logging the names LOCALLY', () => {
    // Hard Invariant 3. snapshot.dataQuality is published by scripts/bake-mirror.ts and
    // redactConfidential does not sweep it. (PR #271 refute pass — the CRITICAL.)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const SECRET = 'Zephyr Logistics Portfolio';
    const seed = [
      deal({ id: 'seed-a', name: SECRET, notionDealId: 'DEAL-1', confidential: true }),
      deal({ id: 'seed-b', name: `${SECRET} II`, notionDealId: 'DEAL-1', confidential: true }),
    ];
    const live = [
      deal({ id: 'n1', name: `${SECRET} — Columbus, OH`, notionDealId: 'DEAL-2' }),
      deal({ id: 'n2', name: `${SECRET} — Madison, WI`, notionDealId: 'DEAL-2' }),
      deal({ id: 'n3', name: SECRET, notionDealId: null }),
    ];
    const flags: DataQualityFlag[] = [];
    mergeDeals(seed, live, flags);

    const published = JSON.stringify(flags);
    expect(published).not.toContain('Zephyr');
    expect(published.toLowerCase()).not.toContain('zephyr');
    expect(flags.length).toBeGreaterThan(0);
    // …and the operator can still resolve every flag, because the names went to the local log.
    expect(warn.mock.calls.flat().join(' ')).toContain('Zephyr');
  });
});
