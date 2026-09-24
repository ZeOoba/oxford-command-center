import { describe, expect, it } from 'vitest';
import { digestSummary } from '../../src/modules/principal/digest-summary';
import type { DigestItem } from '../../src/brain/principal-digest';

const it_ = (id: string, rank: number, kind: DigestItem['kind'] = 'insight') => ({ id, kind, rank, title: id, detail: '' }) as DigestItem;

describe('digestSummary', () => {
  it('counts by class and keeps the top 3 critical items', () => {
    const s = digestSummary([it_('a', 0), it_('b', 0), it_('c', 1), it_('d', 0), it_('e', 0), it_('f', 2, 'deal')]);
    expect(s).toMatchObject({ critical: 4, review: 1, deals: 1 });
    expect(s.top.map((x) => x.id)).toEqual(['a', 'b', 'd']);
  });
});
