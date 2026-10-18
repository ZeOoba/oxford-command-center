// Refute R3 (2026-10-13): the "roster outranks a seed confidential:false" rule ran only inside
// mergeDeals, so loadDeals' three SEED_DEALS fallback returns (not-configured / empty-result /
// fetch-failed) published seed flags unchecked. rosterEnforce now runs on every return path.
// Synthetic roster only: it claims a seed deal by the seed's own id, so no real term is needed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import { SEED_DEALS } from '../../src/data/seed-deals';
import { loadDeals, rosterEnforce } from '../../server/sources/notion-deals';

const publicSeed = SEED_DEALS.find((d) => !d.confidential);

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, token: process.env.NOTION_TOKEN };
function roster(always: string[]) {
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify({ syn: { label: 'Synthetic', active: true, always } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-enforce-'));
  delete process.env.NOTION_TOKEN;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of [['CONFIDENTIAL_TERMS_PATH', saved.path], ['NOTION_TOKEN', saved.token]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('rosterEnforce', () => {
  it('flags a roster-claimed confidential:false deal, leaves the rest alone', () => {
    roster(['zephyr quill']);
    const out = rosterEnforce([deal({ id: 'a', name: 'Zephyr Quill Park' }), deal({ id: 'b', name: 'Plain' })]);
    expect(out.map((d) => d.confidential)).toEqual([true, false]);
  });
  it('fails closed on an unreadable roster', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(rosterEnforce([deal({ id: 'b', name: 'Plain' })])[0]!.confidential).toBe(true);
  });
});

describe('loadDeals seed fallback (NOTION_TOKEN unset) is roster-enforced', () => {
  it.skipIf(!publicSeed)('a public seed claimed by the roster is returned confidential', async () => {
    roster([publicSeed!.id]);
    const r = await loadDeals();
    expect(r.degraded?.reason).toBe('not-configured');
    expect(r.deals.find((d) => d.id === publicSeed!.id)!.confidential).toBe(true);
  });
  it('an unclaimed seed keeps its own flag', async () => {
    roster(['__nothing_matches_this__']);
    const r = await loadDeals();
    for (const s of SEED_DEALS) expect(r.deals.find((d) => d.id === s.id)!.confidential).toBe(s.confidential);
  });
});
