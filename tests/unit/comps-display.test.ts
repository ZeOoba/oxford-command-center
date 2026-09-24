import { describe, expect, it } from 'vitest';
import { compSourceCount, humanizeDealId } from '../../src/modules/market/comps-display';

describe('comps display helpers', () => {
  it('humanizes an orphan Notion deal slug', () => {
    expect(humanizeDealId('notion-liberty-office-park-west-chester-oh-45069')).toBe('REDACTED-390 West Chester OH 45069');
  });
  it('counts distinct comp sources when the set-level sources list is empty', () => {
    expect(compSourceCount({ sources: [], saleComps: [{ source: 'a' }, { source: 'b' }, { source: 'a' }], rentComps: [{ source: 'c' }] })).toBe(3);
    expect(compSourceCount({ sources: ['x', 'y'], saleComps: [], rentComps: [] })).toBe(2);
  });
  it('reports 0 sources for a set with no set-level sources and no comp rows (T15)', () => {
    expect(compSourceCount({ sources: [], saleComps: [], rentComps: [] })).toBe(0);
  });
  it('uppercases a state code only in the last position or directly before a 5-digit ZIP — "in"/"de" stay English words mid-title (T15)', () => {
    expect(humanizeDealId('flex-space-in-columbus-oh')).toBe('Flex Space in Columbus OH');
    expect(humanizeDealId('notion-rio-de-janeiro-flex-in')).toBe('Rio de Janeiro Flex IN');
    expect(humanizeDealId('notion-warehouse-de-wilmington-de-19801')).toBe('Warehouse de Wilmington DE 19801');
    // A state code that is neither last nor before a ZIP is an ordinary word.
    expect(humanizeDealId('oh-so-flex-park-oh')).toBe('Oh So Flex Park OH');
  });
});
