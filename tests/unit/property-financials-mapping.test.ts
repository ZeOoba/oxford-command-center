// @vitest-environment node
//
// tests/unit/property-financials-mapping.test.ts — entity → canonical property id table (plan T4).
import { describe, expect, it } from 'vitest';
import { PF_ENTITY_IDS } from '@contracts/property-financials';
import { CANON_PROPERTIES } from '../../server/warehouse/property-master';
import { buildEntityMapping, ENTITY_TO_CANONICAL } from '../../server/property-financials/mapping';
import { loadDataset } from './property-financials-helpers';

const ds = loadDataset();
const rows = buildEntityMapping(PF_ENTITY_IDS, ds.sf);
const row = (entity: string) => rows.find((r) => r.entity === entity)!;

describe('buildEntityMapping — committed dataset', () => {
  it('maps all 11 entities, in dataset order, to ids that exist in CANON_PROPERTIES', () => {
    expect(rows.map((r) => r.entity)).toEqual([...PF_ENTITY_IDS]);
    const canonIds = new Set(CANON_PROPERTIES.map((p) => p.id));
    for (const r of rows) {
      expect(r.canonicalId).not.toBeNull();
      expect(canonIds.has(r.canonicalId!)).toBe(true);
    }
  });

  it('pins the ratified mapping', () => {
    expect(Object.fromEntries(rows.map((r) => [r.entity, r.canonicalId]))).toEqual({
      '1100 Rarig': '1100-rarig-ave-columbus-oh',
      '1900 Broadway': '1900-n-broadway-baltimore-md',
      '29000 Info Lane': '29000-information-lane-easton-md',
      '3034 Westerville': '3034-westerville-rd-columbus-oh',
      '3540 E 5th': '3540-e-5th-ave-columbus-oh',
      '3883 Livingston': '3875-3883-e-livingston-ave-columbus-oh',
      '9050 Red Branch': '9050-red-branch-rd-columbia-md',
      '9620 State 350': '9620-e-state-route-350-raytown-mo',
      FVC: 'sepich-portfolio-columbus-oh-8-props',
      '55 New Plant (EGFLLC)': '55-new-plant-ct-owings-mills-md',
      '1851 South Club Solar': '1851-s-club-solar',
    });
  });

  it('FVC is the only inferred row and carries the confirm-me flag', () => {
    expect(rows.filter((r) => r.method === 'inferred').map((r) => r.entity)).toEqual(['FVC']);
    expect(row('FVC').flags.map((f) => f.code)).toContain('FVC_SEPICH_MAPPING_INFERRED');
    expect(rows.filter((r) => r.entity !== 'FVC').every((r) => r.method === 'exact')).toBe(true);
  });

  it('SF disagreements are computed from dataset vs master, not hardcoded', () => {
    const sfFlags = rows.flatMap((r) => r.flags.filter((f) => f.code === 'SF_MISMATCH').map((f) => ({ entity: r.entity, ...f })));
    expect(sfFlags.map((f) => [f.entity, f.datasetSf, f.masterSf])).toEqual([
      ['3034 Westerville', 18360, 18000],
      ['9620 State 350', 34300, 34560],
      ['FVC', 109657, 110000],
    ]);
  });

  it('flips with the data: an SF change in the dataset produces/clears the flag', () => {
    const sf = structuredClone(ds.sf);
    sf['1100 Rarig'].sf = 21001;
    sf['3034 Westerville'].sf = 18000;
    const r = buildEntityMapping(PF_ENTITY_IDS, sf);
    const codes = (e: string) => r.find((x) => x.entity === e)!.flags.map((f) => f.code);
    expect(codes('1100 Rarig')).toContain('SF_MISMATCH');
    expect(codes('3034 Westerville')).not.toContain('SF_MISMATCH');
  });

  it('the solar entity (no SF on either side) carries no SF flag', () => {
    expect(row('1851 South Club Solar').flags).toEqual([]);
  });

  it('Northwood never appears in the output', () => {
    expect(JSON.stringify(rows)).not.toMatch(/northwood/i);
    expect(JSON.stringify(ENTITY_TO_CANONICAL)).not.toMatch(/northwood/i);
  });
});

describe('buildEntityMapping — unmatched', () => {
  it('an entity with no mapping yields canonicalId null + UNMATCHED flag', () => {
    const r = buildEntityMapping(['Mystery LLC'], {});
    expect(r).toEqual([
      { entity: 'Mystery LLC', canonicalId: null, method: 'unmatched', flags: [{ code: 'UNMATCHED', detail: expect.any(String) }] },
    ]);
  });

  it('a mapped id that is absent from the property master degrades to unmatched', () => {
    const r = buildEntityMapping(['1100 Rarig'], ds.sf, []);
    expect(r[0]).toMatchObject({ canonicalId: null, method: 'unmatched' });
  });

  it('a Northwood entity is suppressed even if it appears in the input', () => {
    const r = buildEntityMapping(['2203-2207 Northwood', '1100 Rarig'], ds.sf);
    expect(r.map((x) => x.entity)).toEqual(['1100 Rarig']);
  });

  it('never mutates CANON_PROPERTIES', () => {
    const before = JSON.stringify(CANON_PROPERTIES);
    buildEntityMapping(PF_ENTITY_IDS, ds.sf);
    expect(JSON.stringify(CANON_PROPERTIES)).toBe(before);
  });
});
