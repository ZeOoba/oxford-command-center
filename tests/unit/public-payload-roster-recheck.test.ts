import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { scanForConfidential as ScanFn } from '../../server/briefing/confidential';

// Review round 4, C3: the post-scan rosterUnavailable() re-check. The roster is re-read on every scan;
// if it vanishes mid-scan (placeholder env set) the scans ran against the stand-in and a clean result
// is meaningless. Simulated by letting the SENTINEL probe pass once and then hit.
const h = vi.hoisted(() => ({ sentinelCalls: 0, flipAfter: Infinity }));

vi.mock('../../server/briefing/confidential', async (importOriginal) => {
  const real = await importOriginal<{ scanForConfidential: typeof ScanFn }>();
  return {
    ...real,
    scanForConfidential: (value: unknown, terms?: Parameters<typeof ScanFn>[1]) => {
      if (value === '__ora_confidential_placeholder__') {
        h.sentinelCalls += 1;
        return h.sentinelCalls > h.flipAfter ? { dealLabel: 'placeholder' } : null;
      }
      return real.scanForConfidential(value, terms);
    },
  };
});

import { serializeForPublication } from '../../server/sources/deal-declassification';

beforeEach(() => { h.sentinelCalls = 0; h.flipAfter = Infinity; });

describe('serializeForPublication — roster re-check after the scan', () => {
  it('publishes a clean payload while the roster stays available', () => {
    const out = serializeForPublication({ a: 'clean' });
    expect(out.refusal).toBeNull();
    expect(out.json).toBe('{"a":"clean"}');
  });

  it('refuses when the roster turns into the placeholder between the first check and the end of the scan', () => {
    h.flipAfter = 1; // first probe passes, the post-scan probe hits
    const out = serializeForPublication({ a: 'clean' });
    expect(out.json).toBeNull();
    expect(out.refusal).toMatch(/became unreadable/i);
  });
});
