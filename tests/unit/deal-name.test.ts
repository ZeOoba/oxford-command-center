import { describe, it, expect } from 'vitest';
import { stripLocalitySuffix, dealJoinKey, findNearDuplicateNames, parseAcceptedNearDupes } from '../../server/sources/deal-name';

describe('stripLocalitySuffix — Notion "<Deal Name> — <City>, <ST>" convention', () => {
  it('strips an anchored "— City, ST" tail', () => {
    expect(stripLocalitySuffix('Pendleton Trade Center — Indianapolis, IN')).toBe('Pendleton Trade Center');
    expect(stripLocalitySuffix('2146 Enterprise Pkwy — Twinsburg, OH')).toBe('2146 Enterprise Pkwy');
  });

  it('accepts en-dash and spaced-hyphen separators, not an unspaced hyphen', () => {
    expect(stripLocalitySuffix('Foo Center – Dayton, OH')).toBe('Foo Center');
    expect(stripLocalitySuffix('Foo Center - Dayton, OH')).toBe('Foo Center');
    // An unspaced hyphen is part of a name (Wal-Mart), never a locality separator.
    expect(stripLocalitySuffix('Wal-Mart, OH')).toBe('Wal-Mart, OH');
  });

  it('leaves a tail that is not a bare "City, ST" locality alone', () => {
    // These are real pipeline rows — stripping them would be a guess, not a normalization.
    expect(stripLocalitySuffix('Stall Alert — 2026-04-29')).toBe('Stall Alert — 2026-04-29');
    expect(stripLocalitySuffix('8025 & 8009 S Division Ave — Wilkast')).toBe('8025 & 8009 S Division Ave — Wilkast');
    expect(stripLocalitySuffix('2900 Northridge Dr NW — Walker, MI (Kent County)'))
      .toBe('2900 Northridge Dr NW — Walker, MI (Kent County)');
    expect(stripLocalitySuffix('808 Rhoads Avenue — Columbus, OH 43205'))
      .toBe('808 Rhoads Avenue — Columbus, OH 43205');
    expect(stripLocalitySuffix('11850 Hamilton Ave, Cincinnati OH — Dollar General (Quasi-IOS)'))
      .toBe('11850 Hamilton Ave, Cincinnati OH — Dollar General (Quasi-IOS)');
  });

  it('never strips a name down to nothing', () => {
    expect(stripLocalitySuffix('— Columbus, OH')).toBe('— Columbus, OH');
  });

  it('strips ONLY the locality tail when an earlier dash segment exists (regression)', () => {
    // The locality body must exclude "-" as well as the em/en dashes. With "-" allowed, the leftmost
    // em dash matched and the body swallowed the building segment, collapsing a building-level deal
    // into its parent — a silent wrong merge. Caught in review 2026-08-04.
    expect(stripLocalitySuffix('Pendleton Trade Center — Bldg A - Indianapolis, IN'))
      .toBe('Pendleton Trade Center — Bldg A');
    expect(dealJoinKey('Pendleton Trade Center — Bldg A - Indianapolis, IN'))
      .not.toBe(dealJoinKey('Pendleton Trade Center'));
  });
});

describe('dealJoinKey', () => {
  it('normalizes case, punctuation and the locality suffix to one key', () => {
    expect(dealJoinKey('Pendleton Trade Center — Indianapolis, IN')).toBe(dealJoinKey('Pendleton Trade Center'));
    expect(dealJoinKey('2146 Enterprise Pkwy — Twinsburg, OH')).toBe(dealJoinKey('2146 Enterprise Pkwy'));
  });

  it('keeps genuinely different deals apart', () => {
    expect(dealJoinKey('470 McCormick Blvd — Columbus, OH')).not.toBe(dealJoinKey('511 Industrial Mile Road — Columbus, OH'));
    // Same street name, different number — distinct deals.
    expect(dealJoinKey('100 Main St')).not.toBe(dealJoinKey('200 Main St'));
  });
});

describe('findNearDuplicateNames — the regrowth tripwire', () => {
  it('flags a token-prefix pair that the join key did NOT unify', () => {
    const pairs = findNearDuplicateNames(['2146 Enterprise', '2146 Enterprise Pkwy — Twinsburg, OH']);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual(['2146 Enterprise', '2146 Enterprise Pkwy — Twinsburg, OH']);
  });

  it('does not flag names that merely share a leading token', () => {
    expect(findNearDuplicateNames(['100 Main St', '100 Oak Ave'])).toHaveLength(0);
    expect(findNearDuplicateNames(['470 McCormick Blvd', '511 Industrial Mile Road'])).toHaveLength(0);
  });

  it('does not flag a pair the join key already unifies', () => {
    // The previous version of this test passed a ONE-element list, which cannot produce a pair and
    // so asserted nothing (caught in review 2026-08-04). Two names that unify is the real case.
    expect(dealJoinKey('Pendleton Trade Center')).toBe(dealJoinKey('Pendleton Trade Center — Indianapolis, IN'));
    expect(findNearDuplicateNames(['Pendleton Trade Center', 'Pendleton Trade Center — Indianapolis, IN'])).toHaveLength(1);
    // ...and it is exactly ONE pair, not a silent drop — mergeDeals collapses it; the detector's job
    // is only to notice that two rows reached the snapshot still unmerged.
  });

  it('reports EVERY colliding pair, not just the first', () => {
    const pairs = findNearDuplicateNames(['Alpha Park', 'Alpha Park Two', 'Beta Yard', 'Beta Yard North']);
    expect(pairs).toHaveLength(2);
  });

  it('does NOT catch abbreviation/spelling variance — documented scope limit, not a bug', () => {
    // Pinned so a future reader does not mistake the detector for a general duplicate guarantee.
    expect(findNearDuplicateNames(['Pendleton Trade Center', 'Pendleton Trade Ctr — Indianapolis, IN'])).toHaveLength(0);
    expect(findNearDuplicateNames(['470 McCormick Blvd', '470 McCormick Boulevard — Columbus, OH'])).toHaveLength(0);
  });

  it('honors an explicit accepted-pair entry so a real phased asset need not be renamed', () => {
    const names = ['Fairground Village', 'Fairground Village Center'];
    expect(findNearDuplicateNames(names, new Set())).toHaveLength(1);
    const accepted = parseAcceptedNearDupes('Fairground Village=>Fairground Village Center');
    expect(findNearDuplicateNames(names, accepted)).toHaveLength(0);
    // Order-independent: config should not have to guess which name comes first.
    const reversed = parseAcceptedNearDupes('Fairground Village Center=>Fairground Village');
    expect(findNearDuplicateNames(names, reversed)).toHaveLength(0);
  });

  it('returns nothing for an empty or single-name list', () => {
    expect(findNearDuplicateNames([])).toHaveLength(0);
    expect(findNearDuplicateNames(['Solo Deal'])).toHaveLength(0);
  });
});
