// Refute round 8, J4: redactAcquisitionPayload put the roster scanner's e.message into its
// fail-closed log line. A scanner error message is not log-safe (it can quote the input or a term),
// so the line now carries a FIXED string; the bake's thrown refusals stay templated (route template
// only). Pinned with a scanner whose Error message plants a synthetic slug: the slug must reach no
// console channel and no thrown message. Synthetic names only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildWarehouseBake, redactAcquisitionPayload, type RouteResolver } from '../../scripts/bake-warehouse';

vi.mock('../../server/brain', () => ({ brain: { getSnapshot: vi.fn(() => null) } }));

const SLUG = 'heronmoor-ridge';
const throwingScan = () => {
  throw new Error(`roster scan exploded on ${SLUG} near Heronmoor Ridge`);
};

const resolver: RouteResolver = async (p) => {
  if (p === '/analytics/metrics') return { status: 200, json: { metrics: [{ propertyId: 'prop-a', period: '2025' }] } };
  if (p === '/analytics/lease-run') return { status: 200, json: { summaries: [] } };
  if (p === '/calibration/log') return { status: 200, json: { log: [] } };
  return { status: 200, json: { ok: true } };
};

let lines: string[];
beforeEach(() => {
  lines = [];
  const cap = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  for (const m of ['warn', 'log', 'error', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation(cap);
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { lines.push(String(c)); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { lines.push(String(c)); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('J4: a scanner error message never reaches a log or a thrown refusal', () => {
  it('redactAcquisitionPayload: the route is dropped and the log line is fixed', () => {
    const out = redactAcquisitionPayload('/brain/report', { openQuestions: [], trackRecord: [] }, {
      nonDealSubjects: new Set(), scan: throwingScan,
    });
    expect(out).toBeNull();
    expect(lines.length).toBeGreaterThan(0); // the fail-closed line was written (not vacuous)
    const all = lines.join('\n');
    expect(all).not.toMatch(/heronmoor|exploded/i);
    expect(all).toMatch(/could not be verified/);
  });

  it('buildWarehouseBake: the refusal is templated and no channel carries the message', async () => {
    let thrown: unknown = null;
    try {
      await buildWarehouseBake(resolver, {
        now: Date.parse('2026-10-14T12:00:00Z'), warehouseSource: 'checkpoint-read', includeConfidential: false, confidentialScan: throwingScan,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/refusing to bake/);
    expect(msg).not.toMatch(/heronmoor|exploded/i);
    expect(String((thrown as Error).stack)).not.toMatch(/heronmoor|exploded/i);
    expect(lines.join('\n')).not.toMatch(/heronmoor|exploded/i);
  });
});
