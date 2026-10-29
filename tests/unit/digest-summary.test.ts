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

  it('attention is the signal total across critical, review and deals — never the row count', () => {
    const rows = [{ ...it_('g', 0), signals: 9 }, { ...it_('w', 1), signals: 3 }, it_('d', 2, 'deal')];
    const s = digestSummary(rows);
    expect(rows).toHaveLength(3);
    expect(s.attention).toBe(13); // 9 + 3 + 1
    expect(s.attention).toBe(s.critical + s.review + s.deals);
  });

  it('counts signals, not rows, for rolled-up rows', () => {
    const s = digestSummary([{ ...it_('g', 0), signals: 3 }, it_('b', 0), { ...it_('w', 1), signals: 2 }, it_('x', 1)]);
    expect(s).toMatchObject({ critical: 4, review: 3, deals: 0 });
    expect(s.top.map((x) => x.id)).toEqual(['g', 'b']);
  });
});
