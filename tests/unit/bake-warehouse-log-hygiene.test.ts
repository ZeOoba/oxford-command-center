// Refute round 7, H3: the redacted warehouse bake logged each roster-omitted route PATH, claiming
// "route paths only (never a term)". A parameterised route embeds a property id, and an id can BE
// the roster term (a synthetic metrics propertyId 'heronmoor-ridge' vs roster term 'Heronmoor
// Ridge'), so the log printed '/analytics/lease-run/heronmoor-ridge'. Logs are a sink: they now carry
// a COUNT plus the route TEMPLATE (id segments and query replaced), never the id itself. Synthetic
// names only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildWarehouseBake, describeOmittedRoutes, type RouteResolver } from '../../scripts/bake-warehouse';

vi.mock('../../server/brain', () => ({ brain: { getSnapshot: vi.fn(() => null) } }));

const SLUG = 'heronmoor-ridge';
const scan = (v: unknown) => (/heronmoor.?ridge/i.test(JSON.stringify(v)) ? { dealLabel: 'Synthetic' } : null);

const resolver: RouteResolver = async (p) => {
  if (p === '/analytics/metrics') {
    return { status: 200, json: { metrics: [{ propertyId: SLUG, period: '2024' }, { propertyId: SLUG, period: '2025' }] } };
  }
  if (p === '/analytics/lease-run') return { status: 200, json: { summaries: [] } };
  if (p.startsWith('/analytics/lease-run/') || p.startsWith('/analytics/drivers/')) {
    return { status: 200, json: { propertyId: decodeURIComponent(p.split('/')[3]!.split('?')[0]!) } };
  }
  return { status: 200, json: { ok: true } };
};

let lines: string[];
beforeEach(() => {
  lines = [];
  const cap = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  vi.spyOn(console, 'warn').mockImplementation(cap);
  vi.spyOn(console, 'log').mockImplementation(cap);
  vi.spyOn(console, 'error').mockImplementation(cap);
});
afterEach(() => vi.restoreAllMocks());

describe('H3: redacted-bake logs never carry an omitted route id', () => {
  it('a roster-matching property id is omitted and never logged', async () => {
    const { envelope, omitted } = await buildWarehouseBake(resolver, {
      now: Date.parse('2026-10-13T12:00:00Z'), warehouseSource: 'checkpoint-read', includeConfidential: false, confidentialScan: scan,
    });
    // The routes really were omitted (the check below is not vacuous).
    expect(omitted).toContain(`/analytics/lease-run/${SLUG}`);
    expect(omitted.some((p) => p.startsWith(`/analytics/drivers/${SLUG}`))).toBe(true);
    expect(JSON.stringify(envelope.endpoints)).not.toMatch(/heronmoor/i);
    // What bake-mirror prints for the omissions.
    lines.push(describeOmittedRoutes(omitted));
    const all = lines.join('\n');
    expect(all).not.toMatch(/heronmoor/i);
    expect(all).toMatch(/\/analytics\/lease-run\/:id/);
  });

  it('describeOmittedRoutes: count plus templates, ids and queries replaced', () => {
    const s = describeOmittedRoutes([
      `/analytics/lease-run/${SLUG}`,
      `/analytics/drivers/${SLUG}?from=2024&to=2025`,
      `/analytics/drivers/${SLUG}?from=2025&to=2026`,
      '/issues',
    ]);
    expect(s).not.toMatch(/heronmoor|2024|2025/i);
    expect(s).toMatch(/^4 warehouse endpoint\(s\)/);
    expect(s).toContain('/analytics/drivers/:id?… x2');
    expect(s).toContain('/analytics/lease-run/:id x1');
    expect(s).toContain('/issues x1');
    expect(describeOmittedRoutes([])).toBe('');
  });
});
