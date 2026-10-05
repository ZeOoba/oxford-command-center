// @vitest-environment node
//
// tests/unit/property-financials-live-sf.test.ts — T9b part 2: live square footage from the Spine A
// snapshot (server builder) and the ONE preference rule the client applies (analytics applyLiveSf):
// live only when present, Spine A and fresh; otherwise the dataset's static sf. The applied dataset
// must still pass the strict contract.
import { describe, expect, it } from 'vitest';
import { parsePropertyFinancialsDataset, PF_ENTITY_IDS } from '@contracts/property-financials';
import { applyLiveSf, LIVE_SF_STALE_DAYS, liveSfUsable, sfProvenance, staticSfDate, type PfLiveSfBlock } from '@analytics/property-financials/live-sf';
import { perSf } from '@analytics/property-financials/metrics';
import { buildLiveSf, LEASED_SF_BASIS, type LiveSfSnapshot } from '../../server/property-financials/live-sf';
import { ENTITY_TO_CANONICAL } from '../../server/property-financials/mapping';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();
const NOW = new Date(2026, 9, 5, 12, 0, 0); // 2026-10-05 local

function lease(propertyId: string, sf: number, status: 'Active' | 'Expiring Soon' | 'Expired' | 'Vacant' | 'Unknown', id = `${propertyId}-${sf}-${status}`) {
  return { id, propertyId, propertyKey: propertyId, tenantName: 't', unit: null, company: null, sf, monthlyRent: 1, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null, status, annualRent: 12, monthsToExpiry: null, flags: [] };
}

function property(id: string, sf: number, occPct: number, tenantCount: number) {
  return { id, sf, occPct, tenantCount } as unknown as LiveSfSnapshot['properties'][number];
}

function snapshot(asOf: string, over: Partial<LiveSfSnapshot> = {}): LiveSfSnapshot {
  const rarig = ENTITY_TO_CANONICAL['1100 Rarig']!.id;
  const redBranch = ENTITY_TO_CANONICAL['9050 Red Branch']!.id;
  return {
    meta: { schemaVersion: 1, asOf, generatedAt: `${asOf}T08:00:00.000Z`, source: 'Master Excel Template Company Wide -- Oxford.xlsx', scenario: 'base' } as unknown as LiveSfSnapshot['meta'],
    properties: [property(rarig, 21000, 0.9, 9), property(redBranch, 90000, 1, 12)],
    leases: [lease(rarig, 12000, 'Active'), lease(rarig, 6900, 'Expiring Soon'), lease(rarig, 2100, 'Vacant'), lease(rarig, 500, 'Expired'), lease(redBranch, 90000, 'Active')],
    ...over,
  };
}

describe('buildLiveSf (server)', () => {
  it('reads SF / occupancy / tenants from the live property and leased SF from Active + Expiring Soon leases; fresh within 7 days', () => {
    const b = buildLiveSf(snapshot('2026-10-03'), D, NOW);
    expect(b.source).toBe('spine-a');
    expect(b.asOf).toBe('2026-10-03');
    expect(b.ageDays).toBe(2);
    expect(b.stale).toBe(false);
    expect(b.staleDays).toBe(LIVE_SF_STALE_DAYS);
    expect(b.label).toBe('Master Workbook (live Spine A) as of 2026-10-03');
    expect(b.leasedSfBasis).toBe(LEASED_SF_BASIS);
    const r = b.entries['1100 Rarig']!;
    expect(r).toMatchObject({ canonicalId: ENTITY_TO_CANONICAL['1100 Rarig']!.id, mappingMethod: 'exact', sf: 21000, leasedSf: 18900, occupancy: 0.9, tenants: 2, fields: { sf: 'live', leasedSf: 'live', occupancy: 'live' } });
    expect(b.entries['9050 Red Branch']).toMatchObject({ sf: 90000, leasedSf: 90000, occupancy: 1, fields: { sf: 'live', leasedSf: 'live', occupancy: 'live' } });
  });

  it('an entity absent from the live snapshot keeps the static value and says why; the solar entity is not applicable; FVC is flagged inferred', () => {
    const fvcId = ENTITY_TO_CANONICAL.FVC!.id;
    const b = buildLiveSf(snapshot('2026-10-05', { properties: [property(fvcId, 109657, 0.85, 38), property(ENTITY_TO_CANONICAL['1851 South Club Solar']!.id, 0, 0, 0)], leases: [] }), D, NOW);
    expect(b.entries['3540 E 5th']).toMatchObject({ sf: 35886, leasedSf: 35886, fields: { sf: 'static', leasedSf: 'static', occupancy: 'static' } });
    expect(b.entries['3540 E 5th']!.note).toMatch(/not in the live snapshot/);
    expect(b.entries['1851 South Club Solar']).toMatchObject({ sf: null, fields: { sf: 'none', leasedSf: 'none', occupancy: 'none' } });
    const fvc = b.entries.FVC!;
    expect(fvc).toMatchObject({ sf: 109657, mappingMethod: 'inferred', fields: { sf: 'live', leasedSf: 'static', occupancy: 'live' } });
    expect(fvc.leasedSf).toBe(D.sf.FVC.leased_sf);
    expect(fvc.note).toMatch(/inferred/);
    expect(fvc.note).toMatch(/no Active \/ Expiring Soon leases/);
  });

  it('a workbook more than 7 days old is STALE with a reason; exactly 7 days is still fresh', () => {
    expect(buildLiveSf(snapshot('2026-09-28'), D, NOW)).toMatchObject({ stale: false, ageDays: 7 });
    const stale = buildLiveSf(snapshot('2026-09-27'), D, NOW);
    expect(stale).toMatchObject({ stale: true, ageDays: 8 });
    expect(stale.staleReason).toMatch(/2026-09-27 is 8 day\(s\) old/);
    expect(stale.entries['1100 Rarig']!.fields.sf).toBe('live'); // still reported, for information
  });

  it('with no snapshot it falls back to the dataset and labels the source "static dataset (2026-10-02)"', () => {
    const b = buildLiveSf(null, D, NOW);
    expect(b.source).toBe('static-dataset');
    expect(b.label).toBe('static dataset (2026-10-02)');
    expect(b.asOf).toBe('2026-10-02');
    expect(b.ageDays).toBe(3);
    expect(b.stale).toBe(false);
    expect(b.staleReason).toMatch(/no snapshot/);
    expect(b.entries['1100 Rarig']).toMatchObject({ sf: 21000, leasedSf: 18000, occupancy: 0.8571, tenants: 9, fields: { sf: 'static', leasedSf: 'static', occupancy: 'static' } });
    expect(Object.keys(b.entries)).toEqual([...PF_ENTITY_IDS]);
    // and with neither snapshot nor dataset, every entity is 'none'
    const none = buildLiveSf(null, null, NOW);
    expect(Object.values(none.entries).every((e) => e.fields.sf === 'none' && e.sf === null)).toBe(true);
  });
});

describe('applyLiveSf (client preference, one place)', () => {
  it('fresh Spine A values replace the static sf / leased_sf / occupancy and the result still passes the strict contract', () => {
    const block = buildLiveSf(snapshot('2026-10-05'), D, NOW);
    expect(liveSfUsable(block)).toBe(true);
    const out = applyLiveSf(D, block);
    expect(out).not.toBe(D);
    expect(out.sf['1100 Rarig']).toMatchObject({ sf: 21000, leased_sf: 18900, occ: 0.9, tenants: 2 });
    expect(out.sf['1100 Rarig'].source).toMatch(/^Master Workbook \(live Spine A\): .* as of 2026-10-05$/);
    expect(out.sf['1100 Rarig'].note).toBe(D.sf['1100 Rarig'].note);
    expect(out.properties['1100 Rarig']).toMatchObject({ sf: 21000, leased_sf: 18900, occupancy: 0.9 });
    // untouched entities keep their static block verbatim
    expect(out.sf['3540 E 5th']).toEqual(D.sf['3540 E 5th']);
    expect(out.properties['3540 E 5th']).toEqual(D.properties['3540 E 5th']);
    expect(out.sf['1851 South Club Solar']).toEqual(D.sf['1851 South Club Solar']);
    expect(() => parsePropertyFinancialsDataset(out)).not.toThrow();
    // the input is never mutated
    expect(D.sf['1100 Rarig'].leased_sf).toBe(18000);
  });

  it('a stale block, a static-fallback block or no block leaves the dataset untouched (same object)', () => {
    expect(applyLiveSf(D, buildLiveSf(snapshot('2026-09-01'), D, NOW))).toBe(D);
    expect(applyLiveSf(D, buildLiveSf(null, D, NOW))).toBe(D);
    expect(applyLiveSf(D, null)).toBe(D);
    expect(applyLiveSf(D, undefined)).toBe(D);
  });

  it('an entry whose sf is not live (or zero) is skipped even inside a fresh block', () => {
    const block = buildLiveSf(snapshot('2026-10-05'), D, NOW);
    const forged: PfLiveSfBlock = { ...block, entries: { ...block.entries, '1100 Rarig': { ...block.entries['1100 Rarig']!, sf: 0 } } };
    expect(applyLiveSf(D, forged).sf['1100 Rarig']).toEqual(D.sf['1100 Rarig']);
  });

  it('$/SF follows the applied SF: live Rarig SF changes nothing when equal, a different live SF changes the per-SF figure', () => {
    const snap = snapshot('2026-10-05', { properties: [property(ENTITY_TO_CANONICAL['1100 Rarig']!.id, 24000, 0.9, 9)], leases: [] });
    const out = applyLiveSf(D, buildLiveSf(snap, D, NOW));
    const noi = D.properties['1100 Rarig'].periods.FY2025.noi;
    expect(perSf(noi, out.sf['1100 Rarig'].sf)).toEqual(perSf(noi, 24000));
    expect(perSf(noi, D.sf['1100 Rarig'].sf).value).not.toEqual(perSf(noi, out.sf['1100 Rarig'].sf).value);
  });
});

describe('sfProvenance (data-health rows)', () => {
  it('reports live vs static per entity with the source label, as-of and staleness', () => {
    const live = sfProvenance(D, buildLiveSf(snapshot('2026-10-04'), D, NOW));
    const rarig = live.find((r) => r.entity === '1100 Rarig')!;
    expect(rarig).toMatchObject({ using: 'live', sf: 21000, leasedSf: 18900, source: 'Master Workbook (live Spine A) as of 2026-10-04', asOf: '2026-10-04', stale: false });
    expect(rarig.fields).toEqual({ sf: 'live', leasedSf: 'live', occupancy: 'live' });
    const e5 = live.find((r) => r.entity === '3540 E 5th')!;
    expect(e5).toMatchObject({ using: 'static', sf: 35886, source: 'static dataset (2026-10-02)', asOf: '2026-10-02', stale: false });
    expect(live.find((r) => r.entity === '1851 South Club Solar')).toMatchObject({ using: 'none', sf: null, source: 'not applicable' });

    const stale = sfProvenance(D, buildLiveSf(snapshot('2026-09-01'), D, NOW));
    expect(stale.find((r) => r.entity === '1100 Rarig')).toMatchObject({ using: 'static', sf: 21000, leasedSf: 18000, stale: true });
    expect(stale.find((r) => r.entity === '1100 Rarig')!.note).toMatch(/2026-09-01/);

    const fallback = sfProvenance(D, buildLiveSf(null, D, NOW));
    expect(fallback.every((r) => r.using !== 'live' && r.stale === false)).toBe(true);
    expect(staticSfDate(D)).toBe('2026-10-02');
  });
});
