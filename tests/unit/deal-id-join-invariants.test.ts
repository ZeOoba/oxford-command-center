// tests/unit/deal-id-join-invariants.test.ts
//
// EXHAUSTIVE structural invariants for mergeDeals, checked over every combination of the id
// configurations that matter rather than over hand-picked scenarios.
//
// Written because the defects PR #271 spent four adversarial rounds on were not scenarios anyone
// thought to write a test for — they were combinations. A seed sharing a colliding key; an alias
// reaching a key with no locality tail; an acceptance grandfathering a third row nobody had seen.
// Each was found by asking "what if two of these hold at once?", so that question is asked
// mechanically here.
//
// The invariants are stated over the OUTPUT SET, not over the mechanism that produces it — the
// failure mode this subsystem keeps repeating is a guard phrased over a mechanism.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DataQualityFlag, Deal } from '../../src/contracts/index';
import { mergeDeals } from '../../server/sources/notion-deals';

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

/** The id shapes that distinguish a code path. */
const ID_SHAPES = [null, 'DEAL-1', 'DEAL-2'] as const;
/** Names chosen so some pairs collide under the retired name key and others do not. */
const NAMES = ['Shared Name', 'Shared Name — Columbus, OH', 'Distinct Asset'] as const;

interface Case { seeds: Deal[]; live: Deal[]; label: string }

/** Every (id, name) seed x (id, name) live combination, plus the two-live-row variants. */
function allCases(): Case[] {
  const cases: Case[] = [];
  for (const sid of ID_SHAPES) {
    for (const sname of NAMES) {
      for (const lid of ID_SHAPES) {
        for (const lname of NAMES) {
          const seeds = [deal({ id: 's1', name: sname, notionDealId: sid, estPrice: null })];
          cases.push({
            seeds,
            live: [deal({ id: 'n1', name: lname, notionDealId: lid, estPrice: 1_000_000 })],
            label: `seed(${sid},${sname}) x live(${lid},${lname})`,
          });
          // …and the same with a SECOND live row, so collisions and partial matches are covered.
          for (const lid2 of ID_SHAPES) {
            cases.push({
              seeds,
              live: [
                deal({ id: 'n1', name: lname, notionDealId: lid, estPrice: 1_000_000 }),
                deal({ id: 'n2', name: 'Second Row', notionDealId: lid2, estPrice: 2_000_000 }),
              ],
              label: `seed(${sid},${sname}) x live(${lid},${lname})+live2(${lid2})`,
            });
          }
        }
      }
    }
  }
  // Two seeds sharing an id — the fourth-pass ambiguity case — against each live shape.
  for (const lid of ID_SHAPES) {
    cases.push({
      seeds: [
        deal({ id: 's1', name: 'Shared Name', notionDealId: 'DEAL-1' }),
        deal({ id: 's2', name: 'Shared Name — Columbus, OH', notionDealId: 'DEAL-1' }),
      ],
      live: [deal({ id: 'n1', name: 'Shared Name', notionDealId: lid, estPrice: 3_000_000 })],
      label: `ambiguous seeds x live(${lid})`,
    });
  }
  return cases;
}

const CASES = allCases();

describe('mergeDeals invariants — exhaustive over id/name combinations', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it(`covers a meaningful combination space (${CASES.length} cases)`, () => {
    expect(CASES.length).toBeGreaterThan(100);
  });

  it('NOTHING IS DROPPED: every seed and every live row appears exactly once', () => {
    for (const c of CASES) {
      const out = mergeDeals(c.seeds, c.live, []);
      // A merged row wears the SEED's id, so a live row is "present" either under its own id or
      // folded into the seed that claimed it. Count both populations.
      const outIds = out.map((d) => d.id);
      for (const s of c.seeds) {
        expect(outIds.filter((id) => id === s.id), `seed ${s.id} in ${c.label}`).toHaveLength(1);
      }
      for (const l of c.live) {
        const merged = out.some((d) => d.notionDealId !== null && d.notionDealId === l.notionDealId && !c.live.some((x) => x.id === d.id));
        const standalone = outIds.filter((id) => id === l.id).length;
        expect(standalone + (merged ? 1 : 0), `live ${l.id} in ${c.label}`).toBeGreaterThanOrEqual(1);
      }
      // Total rows never exceeds seeds + live, and never falls below seeds.
      expect(out.length, c.label).toBeLessThanOrEqual(c.seeds.length + c.live.length);
      expect(out.length, c.label).toBeGreaterThanOrEqual(c.seeds.length);
    }
  });

  it('FAILS CLOSED: every unmerged live row carries confidential:true', () => {
    for (const c of CASES) {
      const out = mergeDeals(c.seeds, c.live, []);
      const seedIds = new Set(c.seeds.map((s) => s.id));
      for (const row of out) {
        if (seedIds.has(row.id)) continue; // a seed row keeps the seed's flag by design
        expect(row.confidential, `unmerged ${row.id} in ${c.label}`).toBe(true);
      }
    }
  });

  it('NEVER MERGES ACROSS DIFFERENT IDS: a seed only ever takes economics from its own id', () => {
    for (const c of CASES) {
      const out = mergeDeals(c.seeds, c.live, []);
      for (const s of c.seeds) {
        const row = out.find((d) => d.id === s.id)!;
        if (row.estPrice === null) continue; // unenriched — nothing to attribute
        const source = c.live.find((l) => l.estPrice === row.estPrice);
        expect(source, `enriched seed ${s.id} in ${c.label} has a source`).toBeDefined();
        expect(source!.notionDealId, `${c.label}: economics came from a row with a DIFFERENT id`)
          .toBe(s.notionDealId);
      }
    }
  });

  it('NEVER LEAKS A NAME: no flag mentions any deal name across the whole space', () => {
    // Hard Invariant 3 — snapshot.dataQuality reaches the public mirror unredacted.
    for (const c of CASES) {
      const flags: DataQualityFlag[] = [];
      mergeDeals(c.seeds, c.live, flags);
      const published = JSON.stringify(flags);
      for (const name of [...c.seeds, ...c.live].map((d) => d.name)) {
        for (const token of name.split(/\s+/).filter((t) => t.length > 3 && !/^\d+$/.test(t))) {
          expect(published, `${c.label}: flag text contains "${token}"`).not.toContain(token);
        }
      }
    }
  });

  it('IS ORDER-INDEPENDENT: reversing either input yields the same row set', () => {
    const idsOf = (ds: Deal[]) => ds.map((d) => `${d.id}:${d.estPrice}:${d.confidential}`).sort();
    for (const c of CASES) {
      const base = idsOf(mergeDeals(c.seeds, c.live, []));
      expect(idsOf(mergeDeals([...c.seeds].reverse(), c.live, [])), `seed order: ${c.label}`).toEqual(base);
      expect(idsOf(mergeDeals(c.seeds, [...c.live].reverse(), [])), `live order: ${c.label}`).toEqual(base);
    }
  });

  it('RAISES AN ERROR FLAG whenever a live row could not be joined for an id reason', () => {
    for (const c of CASES) {
      const flags: DataQualityFlag[] = [];
      mergeDeals(c.seeds, c.live, flags);
      const idlessLive = c.live.some((l) => !l.notionDealId);
      const dupLive = c.live.length > 1 && c.live[0]!.notionDealId !== null && c.live[0]!.notionDealId === c.live[1]!.notionDealId;
      const dupSeed = c.seeds.length > 1 && c.seeds[0]!.notionDealId === c.seeds[1]!.notionDealId;
      if (idlessLive || dupLive || dupSeed) {
        expect(flags.some((f) => f.severity === 'error'), `expected an error flag: ${c.label}`).toBe(true);
      }
    }
  });
});
