import { describe, it, expect } from 'vitest';
import { stripLocalitySuffix, dealJoinKey, findNearDuplicateNames, parseAcceptedNearDupes } from '../../server/sources/deal-name';

describe('stripLocalitySuffix — Notion "<Deal Name> — <City>, <ST>" convention', () => {
  it('strips an anchored "— City, ST" tail', () => {
    expect(stripLocalitySuffix('REDACTED-340 — Indianapolis, IN')).toBe('REDACTED-340');
    expect(stripLocalitySuffix('REDACTED-367 — Twinsburg, OH')).toBe('REDACTED-367');
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
    expect(stripLocalitySuffix('REDACTED-158')).toBe('REDACTED-158');
    expect(stripLocalitySuffix('REDACTED-056'))
      .toBe('REDACTED-056');
    expect(stripLocalitySuffix('REDACTED-126'))
      .toBe('REDACTED-126');
    expect(stripLocalitySuffix('REDACTED-009'))
      .toBe('REDACTED-009');
  });

  it('never strips a name down to nothing', () => {
    expect(stripLocalitySuffix('— Columbus, OH')).toBe('— Columbus, OH');
  });

  it('strips ONLY the locality tail when an earlier dash segment exists (regression)', () => {
    // The locality body must exclude "-" as well as the em/en dashes. With "-" allowed, the leftmost
    // em dash matched and the body swallowed the building segment, collapsing a building-level deal
    // into its parent — a silent wrong merge. Caught in review 2026-08-04.
    expect(stripLocalitySuffix('REDACTED-340 — Bldg A - Indianapolis, IN'))
      .toBe('REDACTED-340 — Bldg A');
    expect(dealJoinKey('REDACTED-340 — Bldg A - Indianapolis, IN'))
      .not.toBe(dealJoinKey('REDACTED-340'));
  });
});

describe('dealJoinKey', () => {
  it('normalizes case, punctuation and the locality suffix to one key', () => {
    expect(dealJoinKey('REDACTED-340 — Indianapolis, IN')).toBe(dealJoinKey('REDACTED-340'));
    expect(dealJoinKey('REDACTED-367 — Twinsburg, OH')).toBe(dealJoinKey('REDACTED-367'));
  });

  it('keeps genuinely different deals apart', () => {
    expect(dealJoinKey('REDACTED-185')).not.toBe(dealJoinKey('REDACTED-116'));
    // Same street name, different number — distinct deals.
    expect(dealJoinKey('100 Main St')).not.toBe(dealJoinKey('200 Main St'));
  });
});

describe('findNearDuplicateNames — the regrowth tripwire', () => {
  it('flags a token-prefix pair that the join key did NOT unify', () => {
    const pairs = findNearDuplicateNames(['2146 Enterprise', 'REDACTED-367 — Twinsburg, OH']);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual(['2146 Enterprise', 'REDACTED-367 — Twinsburg, OH']);
  });

  it('does not flag names that merely share a leading token', () => {
    expect(findNearDuplicateNames(['100 Main St', '100 Oak Ave'])).toHaveLength(0);
    expect(findNearDuplicateNames(['REDACTED-401', 'REDACTED-293'])).toHaveLength(0);
  });

  it('does not flag a pair the join key already unifies', () => {
    // The previous version of this test passed a ONE-element list, which cannot produce a pair and
    // so asserted nothing (caught in review 2026-08-04). Two names that unify is the real case.
    expect(dealJoinKey('REDACTED-340')).toBe(dealJoinKey('REDACTED-340 — Indianapolis, IN'));
    expect(findNearDuplicateNames(['REDACTED-340', 'REDACTED-340 — Indianapolis, IN'])).toHaveLength(1);
    // ...and it is exactly ONE pair, not a silent drop — mergeDeals collapses it; the detector's job
    // is only to notice that two rows reached the snapshot still unmerged.
  });

  it('reports EVERY colliding pair, not just the first', () => {
    const pairs = findNearDuplicateNames(['Alpha Park', 'Alpha Park Two', 'Beta Yard', 'Beta Yard North']);
    expect(pairs).toHaveLength(2);
  });

  it('does NOT catch abbreviation/spelling variance — documented scope limit, not a bug', () => {
    // Pinned so a future reader does not mistake the detector for a general duplicate guarantee.
    expect(findNearDuplicateNames(['REDACTED-340', 'Pendleton Trade Ctr — Indianapolis, IN'])).toHaveLength(0);
    expect(findNearDuplicateNames(['REDACTED-401', 'REDACTED-520 Boulevard — Columbus, OH'])).toHaveLength(0);
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
