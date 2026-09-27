import { describe, expect, it } from 'vitest';
import { filterSliceReadout } from '../../src/shell/filter-slice';

const inv = (noi: number) => ({ type: 'Flex', noi });
const res = { type: 'Residence', noi: 0 };
const live = [...Array.from({ length: 13 }, () => inv(300_000)), res]; // 13 investment + the residence

describe('filterSliceReadout (ratified 2026-09-24)', () => {
  it('unfiltered live shape reads "13 investment · 1 other holding"', () => {
    expect(filterSliceReadout(live, live, false)).toBe('13 investment · 1 other holding');
  });
  it('filtered: "N of 13 investment · $X.XM NOI", NOI over matched investment rows only', () => {
    expect(filterSliceReadout(live, [inv(300_000), inv(200_000), inv(100_000)], true)).toBe('3 of 13 investment · $0.6M NOI');
  });
  it('filtered to the residence type: "0 of 13 investment · 1 other holding · $0.0M NOI"', () => {
    expect(filterSliceReadout(live, [res], true)).toBe('0 of 13 investment · 1 other holding · $0.0M NOI');
  });
  it('plural other holdings; no "of" when a filter matches every investment row', () => {
    expect(filterSliceReadout([inv(1), res, res], [inv(1), res, res], true)).toBe('1 investment · 2 other holdings · $0.0M NOI');
  });
  it('no rows yet → no readout', () => {
    expect(filterSliceReadout([], [], false)).toBeUndefined();
  });
});
