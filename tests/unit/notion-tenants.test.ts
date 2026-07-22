import { describe, it, expect } from 'vitest';
import { mapNotionTenantPage } from '../../server/sources/notion-tenants';

const page = (over: Record<string, unknown> = {}) => ({
  properties: {
    'Tenant Name': { type: 'title', title: [{ plain_text: 'REDACTED-486' }] },
    'Property Address': { type: 'rich_text', rich_text: [{ plain_text: '1100 Rarig Ave, Columbus OH' }] },
    'Lease Status': { type: 'select', select: { name: 'Active' } },
    'Lease Start': { type: 'date', date: { start: '2023-01-01' } },
    'Lease Expiration': { type: 'date', date: { start: '2027-12-31' } },
    ...over,
  },
});

describe('mapNotionTenantPage', () => {
  it('maps a Notion Tenant Database page to a NotionTenantLease', () => {
    const t = mapNotionTenantPage(page())!;
    expect(t.tenantName).toBe('REDACTED-486');
    expect(t.propertyAddress).toBe('1100 Rarig Ave, Columbus OH');
    expect(t.leaseStatus).toBe('Active');
    expect(t.leaseStart).toBe('2023-01-01');
    expect(t.leaseEnd).toBe('2027-12-31');
  });

  it('returns null for a row with no Tenant Name (not a real tenant row)', () => {
    const t = mapNotionTenantPage(page({ 'Tenant Name': { type: 'title', title: [] } }));
    expect(t).toBeNull();
  });

  it('handles a missing Lease Status gracefully (null, not a throw)', () => {
    const t = mapNotionTenantPage(page({ 'Lease Status': { type: 'select', select: null } }))!;
    expect(t.leaseStatus).toBeNull();
  });

  it('handles missing dates gracefully', () => {
    const t = mapNotionTenantPage(page({ 'Lease Expiration': { type: 'date', date: null } }))!;
    expect(t.leaseEnd).toBeNull();
  });
});
