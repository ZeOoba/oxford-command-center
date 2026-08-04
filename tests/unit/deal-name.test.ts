import { describe, it, expect } from 'vitest';
import { stripLocalitySuffix, dealJoinKey, findNearDuplicateNames } from '../../server/sources/deal-name';

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

  it('does not flag a pair the join key already unifies (they collapse to one row upstream)', () => {
    expect(findNearDuplicateNames(['REDACTED-340'])).toHaveLength(0);
  });

  it('returns nothing for an empty or single-name list', () => {
    expect(findNearDuplicateNames([])).toHaveLength(0);
    expect(findNearDuplicateNames(['Solo Deal'])).toHaveLength(0);
  });
});
