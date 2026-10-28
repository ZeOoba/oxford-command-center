// tests/unit/capital-unscored.test.ts
//
// Which properties the cap-rate report covers but the allocation verdicts do not. The two engines key
// properties by the same slug, but the verdict engine needs a ledger P&L, so properties with only
// workbook data (Fishel, Sunburst) get a cap-table row and no verdict card.
import { describe, it, expect } from 'vitest';
import { unscoredPropertyNames } from '../../src/modules/capital/unscored';

const entry = (propertyId: string, propertyName: string | null) => ({ propertyId, propertyName });

describe('unscoredPropertyNames', () => {
  it('returns report properties that have no verdict, by name, sorted', () => {
    expect(
      unscoredPropertyNames(
        [{ propertyId: 'a' }, { propertyId: 'c' }],
        [entry('c', 'Charlie'), entry('b', 'Bravo'), entry('z', 'Zulu'), entry('a', 'Alpha')],
      ),
    ).toEqual(['Bravo', 'Zulu']);
  });

  it('falls back to the id when a property has no name', () => {
    expect(unscoredPropertyNames([], [entry('x-1', null)])).toEqual(['x-1']);
  });

  it('is empty when every property has a verdict, or there is no report', () => {
    expect(unscoredPropertyNames([{ propertyId: 'a' }], [entry('a', 'Alpha')])).toEqual([]);
    expect(unscoredPropertyNames([{ propertyId: 'a' }], [])).toEqual([]);
  });
});
