// @vitest-environment node
//
// Synthetic-fixture generator: vendor aliasing is independent of row order, and a bare range bound after
// a drawn dollar figure is drawn too (refute round 7 F2/F3). Every name and amount here is SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { aliasProbe } from '../../scripts/fixtures/build-synthetic-data';

describe('synthetic generator: vendor aliasing', () => {
  it('treats a name and its entity-suffixed form as one vendor, in either order', () => {
    const note = 'Called Zorblax about the invoice';
    const a = aliasProbe(['Zorblax', 'Zorblax Corp'], [note]);
    const b = aliasProbe(['Zorblax Corp', 'Zorblax'], [note]);
    expect(new Set(a.fields).size).toBe(1);
    expect(a.fields[0]).toBe(b.fields[0]);
    expect(a.texts).toEqual(b.texts);
    expect(a.texts[0]).toBe(`Called ${a.fields[0]} about the invoice`);
  });

  it('marks a short form ambiguous only when two distinct vendors share it, in any order', () => {
    const note = 'Quiblet came out twice';
    const names = ['Quiblet Roofing LLC', 'Quiblet Paving Inc', 'Narfwick Mechanical'];
    const runs = [names, [...names].reverse(), [names[1]!, names[2]!, names[0]!]].map((n) => aliasProbe(n, [note, 'Narfwick fixed it']));
    for (const r of runs) {
      expect(r.texts[0]).toBe('Vendor (unspecified) came out twice');
      expect(r.texts[1]).not.toMatch(/Narfwick/);
    }
    // the same vendor gets the same alias whatever order its rows arrive in
    const byName = runs.map((r, i) => Object.fromEntries((i === 0 ? names : i === 1 ? [...names].reverse() : [names[1]!, names[2]!, names[0]!]).map((n, j) => [n, r.fields[j]])));
    expect(byName[1]).toEqual(byName[0]);
    expect(byName[2]).toEqual(byName[0]);
  });

  it('never relabels a non-vendor alias with a vendor short form', () => {
    const r = aliasProbe(['Plimbo Roofing', 'Plimbo Paving'], ['Plimbo signed the lease'], [['company', 'Plimbo']]);
    expect(r.texts[0]).toMatch(/^Tenant \d{3} LLC signed the lease$/);
  });
});

describe('synthetic generator: dollar ranges', () => {
  it('draws the bare upper bound of a "$X-Y/SF" range with the dollar figure', () => {
    const src = 'quotes $10,205.9-12.5/SF and $4,000 to 5,500 total';
    const { texts } = aliasProbe([], [src]);
    const out = texts[0]!;
    expect(out).not.toMatch(/-12\.5\/SF/);
    expect(out).not.toMatch(/ to 5,500/);
    const m = /\$([\d,.]+)-([\d,.]+)\/SF and \$([\d,.]+) to ([\d,.]+) total/.exec(out);
    expect(m).not.toBeNull();
    const n = (x: string) => Number(x.replace(/,/g, ''));
    expect(n(m![1]!)).toBeLessThanOrEqual(n(m![2]!));
    expect(n(m![3]!)).toBeLessThanOrEqual(n(m![4]!));
    expect(aliasProbe([], [src]).texts[0]).toBe(out); // deterministic
  });

  it('leaves a lone dollar figure and unrelated numbers alone in shape', () => {
    const { texts } = aliasProbe([], ['paid $1,234 on 2026-11-10 for 3 units']);
    expect(texts[0]).toMatch(/^paid \$[\d,]+ on 2026-11-10 for 3 units$/);
  });
});
