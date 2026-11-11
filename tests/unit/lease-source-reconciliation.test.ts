// tests/unit/lease-source-reconciliation.test.ts
//
// Pure comparison logic for cross-checking the Master Workbook's lease/tenant rows against the
// Notion Tenant Database — the mechanism that was missing when portfolio.json's "Expired" rows
// for Tenant 059 LLC / Person 017 / REDACTED-691 were already retired by the 2026-07-21
// Tenant DB rent-roll reconciliation, with no way for the workbook pipeline to ever notice.
import { describe, expect, it } from 'vitest';
import { reconcileLeaseSources, type NotionTenantLease } from '../../server/reconcile/lease-source-reconciliation';
import type { Lease } from '../../src/contracts/lease';

function makeLease(overrides: Partial<Lease> & { tenantName: string }): Lease {
  return {
    id: `${overrides.propertyKey ?? 'prop'}-${overrides.tenantName}-1`,
    propertyKey: overrides.propertyKey ?? '1100 Rarig',
    propertyId: overrides.propertyId ?? null,
    tenantName: overrides.tenantName,
    unit: overrides.unit ?? null,
    company: overrides.company ?? null,
    sf: overrides.sf ?? 1000,
    monthlyRent: overrides.monthlyRent ?? 1000,
    rentPerSf: overrides.rentPerSf ?? null,
    leaseStart: overrides.leaseStart ?? null,
    leaseEnd: overrides.leaseEnd ?? null,
    escalationDate: overrides.escalationDate ?? null,
    escalationPct: overrides.escalationPct ?? null,
    status: overrides.status ?? 'Active',
    annualRent: overrides.annualRent ?? 12000,
    monthsToExpiry: overrides.monthsToExpiry ?? null,
    flags: overrides.flags ?? [],
  };
}

function makeNotionTenant(overrides: Partial<NotionTenantLease> & { tenantName: string }): NotionTenantLease {
  return {
    tenantName: overrides.tenantName,
    propertyAddress: overrides.propertyAddress ?? null,
    leaseStatus: overrides.leaseStatus ?? 'Active',
    leaseStart: overrides.leaseStart ?? null,
    leaseEnd: overrides.leaseEnd ?? null,
  };
}

describe('reconcileLeaseSources', () => {
  it('flags a conflict when the workbook says Expired but Notion says Active (the exact 2026-07-21 case)', () => {
    const workbook = [makeLease({ tenantName: 'Tenant 059 LLC', status: 'Expired' })];
    const notion = [makeNotionTenant({ tenantName: 'Tenant 059 LLC', leaseStatus: 'Active' })];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]!.tenantName).toBe('Tenant 059 LLC');
    expect(result.divergences[0]!.workbookStatus).toBe('Expired');
    expect(result.divergences[0]!.notionStatus).toBe('Active');
    expect(result.divergences[0]!.severity).toBe('workbook-stale-expired');
  });

  it('flags the mirror case: Notion says Expired but the workbook still shows Active', () => {
    const workbook = [makeLease({ tenantName: 'Person 017', status: 'Active' })];
    const notion = [makeNotionTenant({ tenantName: 'Person 017', leaseStatus: 'Expired' })];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]!.severity).toBe('notion-ahead-expired');
  });

  it('does not flag a match when both sources agree the lease is Expired', () => {
    const workbook = [makeLease({ tenantName: 'REDACTED-691', status: 'Expired' })];
    const notion = [makeNotionTenant({ tenantName: 'REDACTED-691', leaseStatus: 'Expired' })];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(0);
  });

  it('does not flag a match when both sources agree the lease is active/occupied', () => {
    const workbook = [makeLease({ tenantName: 'Tenant Co', status: 'Active' })];
    const notion = [makeNotionTenant({ tenantName: 'Tenant Co', leaseStatus: 'Active' })];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(0);
  });

  it('matches tenant names case-insensitively and across whitespace/punctuation differences', () => {
    const workbook = [makeLease({ tenantName: 'ACME Warehousing, LLC', status: 'Expired' })];
    const notion = [makeNotionTenant({ tenantName: 'acme warehousing llc', leaseStatus: 'Active' })];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(1);
  });

  it('does NOT treat Notion Month-to-Month or Notice Given as directly comparable to a workbook status (no fabricated equivalence)', () => {
    // These two Notion statuses have no confident 1:1 workbook equivalent — comparing them
    // would require guessing a mapping, which risks a false-positive/false-negative divergence
    // report. Skip rather than fabricate.
    const workbook = [
      makeLease({ tenantName: 'Tenant MTM', status: 'Active' }),
      makeLease({ tenantName: 'Tenant Notice', status: 'Active' }),
    ];
    const notion = [
      makeNotionTenant({ tenantName: 'Tenant MTM', leaseStatus: 'Month-to-Month' }),
      makeNotionTenant({ tenantName: 'Tenant Notice', leaseStatus: 'Notice Given' }),
    ];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(0);
    expect(result.skippedIncomparable).toHaveLength(2);
  });

  it('reports tenants present in the workbook but not found in Notion as unmatched (not a divergence)', () => {
    const workbook = [makeLease({ tenantName: 'Only In Workbook', status: 'Active' })];
    const notion: NotionTenantLease[] = [];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(0);
    expect(result.unmatchedInWorkbook).toEqual(['Only In Workbook']);
  });

  it('reports tenants present in Notion but not found in the workbook as unmatched (not a divergence)', () => {
    const workbook: Lease[] = [];
    const notion = [makeNotionTenant({ tenantName: 'Only In Notion', leaseStatus: 'Active' })];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(0);
    expect(result.unmatchedInNotion).toEqual(['Only In Notion']);
  });

  it('handles multiple tenants independently, only flagging the ones that actually conflict', () => {
    const workbook = [
      makeLease({ tenantName: 'Conflict Tenant', status: 'Expired' }),
      makeLease({ tenantName: 'Agreeing Tenant', status: 'Active' }),
    ];
    const notion = [
      makeNotionTenant({ tenantName: 'Conflict Tenant', leaseStatus: 'Active' }),
      makeNotionTenant({ tenantName: 'Agreeing Tenant', leaseStatus: 'Active' }),
    ];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]!.tenantName).toBe('Conflict Tenant');
  });

  it('is deterministic: identical inputs produce identical output', () => {
    const workbook = [makeLease({ tenantName: 'Tenant 059 LLC', status: 'Expired' })];
    const notion = [makeNotionTenant({ tenantName: 'Tenant 059 LLC', leaseStatus: 'Active' })];
    const r1 = reconcileLeaseSources(workbook, notion);
    const r2 = reconcileLeaseSources(workbook, notion);
    expect(r1).toEqual(r2);
  });

  describe('ambiguous / placeholder names — never name-matched, never silently merged', () => {
    it('excludes the "VACANT" placeholder tenant name from matching entirely, even with exactly one on each side', () => {
      // "VACANT" is an established placeholder tenant name used elsewhere in this codebase
      // (server/workbook/parse.ts, tests/unit/renewals.test.ts) — it does not identify a real
      // tenant entity, so matching on it (even when only one happens to exist per side in a
      // given snapshot) is fragile and can silently cross-match unrelated units the moment a
      // second vacant unit appears. It must never be name-matched, full stop.
      const workbook = [makeLease({ tenantName: 'VACANT', propertyKey: '1100 Rarig', status: 'Vacant' })];
      const notion = [makeNotionTenant({ tenantName: 'VACANT', leaseStatus: 'Vacant' })];
      const result = reconcileLeaseSources(workbook, notion);
      expect(result.divergences).toHaveLength(0);
      expect(result.ambiguousNames).toContain('VACANT');
      expect(result.unmatchedInWorkbook).toHaveLength(0); // ambiguous, not "unmatched"
      expect(result.unmatchedInNotion).toHaveLength(0);
    });

    it('does not cross-match two different-property "VACANT" units against each other', () => {
      const workbook = [
        makeLease({ tenantName: 'VACANT', propertyKey: '1100 Rarig', status: 'Vacant' }),
        makeLease({ tenantName: 'VACANT', propertyKey: '3540 E 5th Ave', status: 'Vacant' }),
      ];
      const notion = [makeNotionTenant({ tenantName: 'Vacant', leaseStatus: 'Expired' })]; // would be a false divergence if matched
      const result = reconcileLeaseSources(workbook, notion);
      expect(result.divergences).toHaveLength(0);
      expect(result.ambiguousNames).toContain('VACANT');
    });

    it('excludes an ordinary (non-vacant) duplicate tenant name that appears at two workbook properties from matching', () => {
      // A national/franchise tenant leasing at two ORA properties under the identical legal
      // name — matching by name alone can't distinguish which physical lease Notion's single
      // row actually refers to, so it must be excluded rather than guessed.
      const workbook = [
        makeLease({ tenantName: 'National Storage Co', propertyKey: '1100 Rarig', status: 'Expired' }),
        makeLease({ tenantName: 'National Storage Co', propertyKey: '3540 E 5th Ave', status: 'Active' }),
      ];
      const notion = [makeNotionTenant({ tenantName: 'National Storage Co', leaseStatus: 'Active' })];
      const result = reconcileLeaseSources(workbook, notion);
      expect(result.divergences).toHaveLength(0);
      expect(result.ambiguousNames).toContain('National Storage Co');
    });

    it('excludes a duplicate tenant name that appears twice in Notion from matching, and does not silently drop one via a Map overwrite', () => {
      const workbook = [makeLease({ tenantName: 'Regional Tenant LLC', status: 'Expired' })];
      const notion = [
        makeNotionTenant({ tenantName: 'Regional Tenant LLC', leaseStatus: 'Active', propertyAddress: '111 A St' }),
        makeNotionTenant({ tenantName: 'Regional Tenant LLC', leaseStatus: 'Active', propertyAddress: '222 B St' }),
      ];
      const result = reconcileLeaseSources(workbook, notion);
      expect(result.divergences).toHaveLength(0);
      expect(result.ambiguousNames).toContain('Regional Tenant LLC');
    });

    it('still correctly matches a uniquely-named tenant even when an unrelated ambiguous name exists elsewhere in the same run', () => {
      const workbook = [
        makeLease({ tenantName: 'VACANT', propertyKey: '1100 Rarig', status: 'Vacant' }),
        makeLease({ tenantName: 'VACANT', propertyKey: '3540 E 5th Ave', status: 'Vacant' }),
        makeLease({ tenantName: 'Tenant 059 LLC', status: 'Expired' }),
      ];
      const notion = [
        makeNotionTenant({ tenantName: 'Vacant', leaseStatus: 'Vacant' }),
        makeNotionTenant({ tenantName: 'Tenant 059 LLC', leaseStatus: 'Active' }),
      ];
      const result = reconcileLeaseSources(workbook, notion);
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0]!.tenantName).toBe('Tenant 059 LLC');
    });
  });

  describe('divergence note text must not mischaracterize the actual source status', () => {
    it('does not claim the lease is "occupied" in the note when the workbook status is actually Vacant', () => {
      // A uniquely-named tenant row (not the "VACANT" placeholder) whose status happens to be
      // 'Vacant' still lands in the 'active' bucket (vs 'expired') for comparison purposes, but
      // the generated note text must describe the REAL status, not assume "occupied".
      const workbook = [makeLease({ tenantName: 'Suite 4B Holdover', status: 'Vacant' })];
      const notion = [makeNotionTenant({ tenantName: 'Suite 4B Holdover', leaseStatus: 'Expired' })];
      const result = reconcileLeaseSources(workbook, notion);
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0]!.note.toLowerCase()).not.toContain('occupied');
      expect(result.divergences[0]!.note).toContain('Vacant');
    });
  });

  it('includes the Notion property address alongside the workbook property key in a divergence, so a reviewer can sanity-check the match', () => {
    const workbook = [makeLease({ tenantName: 'Tenant 059 LLC', propertyKey: '1100 Rarig', status: 'Expired' })];
    const notion = [makeNotionTenant({ tenantName: 'Tenant 059 LLC', leaseStatus: 'Active', propertyAddress: '1100 Rarig Ave, Columbus OH' })];
    const result = reconcileLeaseSources(workbook, notion);
    expect(result.divergences[0]!.notionPropertyAddress).toBe('1100 Rarig Ave, Columbus OH');
  });
});
