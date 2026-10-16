// Refute round 6, G7: the placeholder roster was detected by SCANNING the sentinel string
// '__ora_confidential_placeholder__' against the loaded roster, so a real roster term that is a
// substring of it ('Ora', 'Confidential', 'placeholder') made every egress / publication path treat
// the real roster as the placeholder and refuse (and rosterClaimsDeal claim every deal). The
// placeholder is now detected by IDENTITY (the loader's own fallback object). Synthetic roster only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import { egressRosterScanner, egressRosterMatch } from '../../server/briefing/roster-match';
import { loadConfidentialTerms, isPlaceholderRoster } from '../../server/briefing/confidential';
import { rosterClaimsDeal, isDeclassified, publicationRosterScan } from '../../server/sources/deal-declassification';

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
const roster = (always: string[]) => {
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify({ syn: { label: 'Synthetic', active: true, always } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
};
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ph-id-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('G7: placeholder detection by identity', () => {
  it.each([['Ora'], ['Confidential'], ['placeholder'], ['__ora_confidential_placeholder__']])(
    'a real roster with term %s is not mistaken for the placeholder',
    (term) => {
      roster([term]);
      expect(isPlaceholderRoster(loadConfidentialTerms())).toBe(false);
      expect(() => egressRosterScanner()).not.toThrow();
      expect(egressRosterMatch('Public Flex Center, 22,000 SF')).toBeNull();
      expect(publicationRosterScan({ name: 'Public Yard' })).toBeNull();
      // 'Confidential' equals a Deal KEY ('confidential'), and object keys are scanned, so every
      // Deal record matches it: a fail-closed over-match unrelated to placeholder detection.
      if (term !== 'Confidential') {
        expect(rosterClaimsDeal(deal({ id: 'pub', name: 'Public Yard' }))).toBe(false);
        expect(isDeclassified(deal({ id: 'pub', name: 'Public Yard' }), ['pub'])).toBe(true);
      }
    },
  );
  it('the real term still matches', () => {
    roster(['Ora']);
    expect(egressRosterMatch('the Ora deal')).not.toBeNull();
  });
  it('the actual placeholder is still detected and refused everywhere', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    expect(isPlaceholderRoster(loadConfidentialTerms())).toBe(true);
    expect(() => egressRosterScanner()).toThrow(/placeholder/i);
    expect(rosterClaimsDeal(deal({ id: 'pub', name: 'Public Yard' }))).toBe(true);
    expect(isDeclassified(deal({ id: 'pub', name: 'Public Yard' }), ['pub'])).toBe(false);
  });
});
