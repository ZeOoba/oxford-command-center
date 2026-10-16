// Refute round 6, G6: mergeDeals (server/sources/notion-deals.ts) console-logged the NAMES and slug
// ids of rows that default confidential or can be roster-claimed: seed rows on an ambiguous Deal
// ID, live rows on a colliding Deal ID, live rows with no Deal ID, the seed id on the staleness
// tripwire, both sides of a MIGRATION GAP, a DANGLING seed and DUPLICATE published rows. A log is a
// sink. Each message now carries counts, the opaque Notion Deal ID (already treated as safe in the
// published flags) and keyDigest digests, never a name or a name-derived id. The #457
// "live row is confidential (name pattern)" line is deliberately out of scope here (its own test
// asserts it). Synthetic names only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DataQualityFlag, Deal } from '../../src/contracts/index';
import { mergeDeals } from '../../server/sources/notion-deals';
import { keyDigest } from '../../server/sources/deal-name';

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
const logged = () => warn.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n');
const SECRET = /heronmoor|quillfield|osprey/i;

describe('G6: mergeDeals logs no deal name or name-derived id', () => {
  it('ambiguous seed Deal ID: count + Deal ID, no seed names', () => {
    mergeDeals([
      deal({ id: 'heronmoor-flex', name: 'Heronmoor Flex', notionDealId: 'DEAL-901' }),
      deal({ id: 'heronmoor-flex-ii', name: 'Heronmoor Flex II', notionDealId: 'DEAL-901' }),
    ], []);
    expect(logged()).not.toMatch(SECRET);
    expect(logged()).toMatch(/2 seed rows claim Deal ID 'DEAL-901'/);
  });

  it('live Deal ID collision: count + Deal ID, no live names', () => {
    mergeDeals([], [
      deal({ id: 'n1', name: 'Heronmoor Yard - Columbus, OH', notionDealId: 'DEAL-902' }),
      deal({ id: 'n2', name: 'Heronmoor Yard - Madison, WI', notionDealId: 'DEAL-902' }),
    ]);
    expect(logged()).not.toMatch(SECRET);
    expect(logged()).toMatch(/DEAL-902/);
    expect(logged()).toMatch(/2 live rows/);
  });

  it('live rows with no Deal ID: count only', () => {
    mergeDeals([], [deal({ id: 'a', name: 'Quillfield Park' }), deal({ id: 'b', name: 'Osprey Commons' })]);
    expect(logged()).not.toMatch(SECRET);
    expect(logged()).toMatch(/2 live pipeline row\(s\) carry no Deal ID/);
  });

  it('seed staleness: a digest of the seed id, not the id', () => {
    mergeDeals(
      [deal({ id: 'heronmoor-flex', name: 'Heronmoor Flex', notionDealId: 'DEAL-903', confidential: false })],
      [deal({ id: 'n', name: 'Heronmoor Flex', notionDealId: 'DEAL-903', stage: 'Due Diligence', confidential: false })],
    );
    expect(logged()).not.toMatch(SECRET);
    expect(logged()).toContain(keyDigest('heronmoor-flex'));
    expect(logged()).toContain('Due Diligence');
  });

  it('MIGRATION GAP: a seed digest and the live Deal IDs, no names', () => {
    const flags: DataQualityFlag[] = [];
    mergeDeals(
      [deal({ id: 'heronmoor-flex', name: 'Heronmoor Flex', notionDealId: null })],
      [deal({ id: 'n', name: 'Heronmoor Flex', notionDealId: 'DEAL-904' })],
      flags,
    );
    expect(logged()).toMatch(/MIGRATION GAP/);
    expect(logged()).not.toMatch(SECRET);
    expect(logged()).toMatch(/DEAL-904/);
  });

  it('DANGLING seed Deal ID: the Deal ID and stage, no seed name', () => {
    mergeDeals([deal({ id: 'heronmoor-flex', name: 'Heronmoor Flex', notionDealId: 'DEAL-905', stage: 'Closing' })], []);
    expect(logged()).toMatch(/DANGLING seed Deal ID DEAL-905/);
    expect(logged()).not.toMatch(SECRET);
  });

  it('DUPLICATE published rows: a digest and count, no names or slug ids', () => {
    mergeDeals([], [
      deal({ id: 'quillfield-a', name: 'Quillfield Park', notionDealId: 'DEAL-906' }),
      deal({ id: 'quillfield-b', name: 'Quillfield Park', notionDealId: 'DEAL-907' }),
    ]);
    expect(logged()).toMatch(/DUPLICATE published rows/);
    expect(logged()).not.toMatch(SECRET);
    expect(logged()).toMatch(/2 rows/);
  });
});
