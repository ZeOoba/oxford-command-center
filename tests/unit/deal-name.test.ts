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
    expect(stripLocalitySuffix('Pipeline Deal 06 — Indianapolis, IN')).toBe('Pipeline Deal 06');
    expect(stripLocalitySuffix('Pipeline Deal 04 — Twinsburg, OH')).toBe('Pipeline Deal 04');
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
    expect(stripLocalitySuffix('Pipeline Deal 18')).toBe('Pipeline Deal 18');
    expect(stripLocalitySuffix('Pipeline Deal 11'))
      .toBe('Pipeline Deal 11');
    expect(stripLocalitySuffix('Pipeline Deal 19'))
      .toBe('Pipeline Deal 19');
    expect(stripLocalitySuffix('Pipeline Deal 17'))
      .toBe('Pipeline Deal 17');
  });

  it('never strips a name down to nothing', () => {
    expect(stripLocalitySuffix('— Columbus, OH')).toBe('— Columbus, OH');
  });

  it('strips ONLY the locality tail when an earlier dash segment exists (regression)', () => {
    // The locality body must exclude "-" as well as the em/en dashes. With "-" allowed, the leftmost
    // em dash matched and the body swallowed the building segment, collapsing a building-level deal
    // into its parent. Under the name join that was a silent wrong merge (caught in review
    // 2026-08-04); it now costs at most a spurious tripwire warning, but the anchoring is still right.
    expect(stripLocalitySuffix('Pipeline Deal 06 — Bldg A - Indianapolis, IN'))
      .toBe('Pipeline Deal 06 — Bldg A');
    expect(dealJoinKey('Pipeline Deal 06 — Bldg A - Indianapolis, IN'))
      .not.toBe(dealJoinKey('Pipeline Deal 06'));
  });
});

describe('dealJoinKey — a comparison form for the tripwire, NOT a join key', () => {
  it('normalizes case, punctuation and the locality suffix to one value', () => {
    expect(dealJoinKey('Pipeline Deal 06 — Indianapolis, IN')).toBe(dealJoinKey('Pipeline Deal 06'));
    expect(dealJoinKey('Pipeline Deal 04 — Twinsburg, OH')).toBe(dealJoinKey('Pipeline Deal 04'));
  });

  it('keeps genuinely different deals apart', () => {
    expect(dealJoinKey('100 Example Blvd — Columbus, OH')).not.toBe(dealJoinKey('Pipeline Deal 21'));
    // Same street name, different number — distinct deals.
    expect(dealJoinKey('100 Main St')).not.toBe(dealJoinKey('200 Main St'));
  });

  it('COLLIDES across metros — which is exactly why it is no longer the join key', () => {
    // The defect the id join retired, pinned as a property of this function rather than a story:
    // the locality tail is the only thing distinguishing these two, and this deletes it.
    expect(dealJoinKey('100 Example Blvd — Columbus, OH'))
      .toBe(dealJoinKey('100 Example Blvd — Louisville, KY'));
  });
});
