import { describe, it, expect } from 'vitest';
import { stripLocalitySuffix, dealJoinKey } from '../../server/sources/deal-name';

/**
 * SCOPE, AS OF 2026-08-12. These functions no longer decide what merges — the seed↔Notion join is
 * `Deal.notionDealId` (Notion's Unique ID). All that survives here is the normalization behind
 * mergeDeals' migration-gap tripwire, where a name is evidence that something needs a human's
 * attention and a false positive costs a warning rather than a wrong merge.
 *
 * Retired with the name join, along with their tests: findNearDuplicateNames, parseNameAliases,
 * parseAcceptedNearDupes, parseAcceptedCollisions, acceptedPairKey, acceptedCollisionKey,
 * aliasedJoinKey, localityStateOf. See server/sources/deal-name.ts for why they all existed.
 */
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
    // into its parent. Under the name join that was a silent wrong merge (caught in review
    // 2026-08-04); it now costs at most a spurious tripwire warning, but the anchoring is still right.
    expect(stripLocalitySuffix('REDACTED-340 — Bldg A - Indianapolis, IN'))
      .toBe('REDACTED-340 — Bldg A');
    expect(dealJoinKey('REDACTED-340 — Bldg A - Indianapolis, IN'))
      .not.toBe(dealJoinKey('REDACTED-340'));
  });
});

describe('dealJoinKey — a comparison form for the tripwire, NOT a join key', () => {
  it('normalizes case, punctuation and the locality suffix to one value', () => {
    expect(dealJoinKey('REDACTED-340 — Indianapolis, IN')).toBe(dealJoinKey('REDACTED-340'));
    expect(dealJoinKey('REDACTED-367 — Twinsburg, OH')).toBe(dealJoinKey('REDACTED-367'));
  });

  it('keeps genuinely different deals apart', () => {
    expect(dealJoinKey('REDACTED-185')).not.toBe(dealJoinKey('REDACTED-116'));
    // Same street name, different number — distinct deals.
    expect(dealJoinKey('100 Main St')).not.toBe(dealJoinKey('200 Main St'));
  });

  it('COLLIDES across metros — which is exactly why it is no longer the join key', () => {
    // The defect the id join retired, pinned as a property of this function rather than a story:
    // the locality tail is the only thing distinguishing these two, and this deletes it.
    expect(dealJoinKey('REDACTED-185'))
      .toBe(dealJoinKey('REDACTED-401 — Louisville, KY'));
  });
});
