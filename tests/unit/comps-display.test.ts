import { describe, expect, it } from 'vitest';
import { compSourceCount, humanizeDealId } from '../../src/modules/market/comps-display';

describe('comps display helpers', () => {
  it('humanizes an orphan Notion deal slug', () => {
    expect(humanizeDealId('notion-liberty-office-park-west-chester-oh-45069')).toBe('Liberty Office Park West Chester OH 45069');
  });
  it('counts distinct comp sources when the set-level sources list is empty', () => {
    expect(compSourceCount({ sources: [], saleComps: [{ source: 'a' }, { source: 'b' }, { source: 'a' }], rentComps: [{ source: 'c' }] })).toBe(3);
    expect(compSourceCount({ sources: ['x', 'y'], saleComps: [], rentComps: [] })).toBe(2);
  });
});
