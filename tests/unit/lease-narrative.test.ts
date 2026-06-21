// @vitest-environment node
//
// tests/unit/lease-narrative.test.ts
//
// Phase 3 · Workstream 3 — AI Narrative Leasing Briefing.
// Spec: docs/superpowers/specs/2026-06-20-phase-3-forecast-leasing-intelligence.md
//
// Tests composeLeaseNarrative via injected fetchImpl (no real HTTP calls).
// Covers: no apiKey, happy path, network error, malformed JSON,
// post-receive confidential hit, LeaseNarrativeResponse contract shape.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { composeLeaseNarrative } from '../../server/ai/narrative';
import { LeaseNarrativeResponse } from '../../src/contracts/lease-forecast';

// ── Minimal valid LeaseNarrativeInput fixture ─────────────────────────────────

const BASE_INPUT = {
  asOf: '2026-06-21',
  propertyCount: 27,
  signalSummary: {
    likelyCt: 12,
    uncertainCt: 8,
    atRiskCt: 4,
    lapsingCt: 2,
    nearTermExpiryRent: 185000,
  },
  topGaps: [
    { propertyKey: 'prop-a', gapPsf: -2.5, underMarket: true },
    { propertyKey: 'prop-b', gapPsf: 1.2, underMarket: false },
  ],
  slowLeasingProperties: ['123 Industrial Dr'],
};

// ── Mock fetch helpers ────────────────────────────────────────────────────────

const VALID_AI_RESPONSE_TEXT = JSON.stringify({
  headline: 'Near-Term Lease Expiry Concentration',
  summary: '6 tenants face near-term expiry with $185,000 in rent at risk.',
  bullets: [
    '4 at-risk renewals require immediate outreach',
    '2 leases lapsing into month-to-month',
    'prop-a is $2.50/SF below market',
    '123 Industrial Dr shows slow leasing velocity',
  ],
});

function mockFetch(
  text: string,
  status = 200,
  opts: { throwAbort?: boolean; throwNetwork?: boolean } = {},
): typeof fetch {
  return async (_url: unknown, _init: unknown) => {
    if (opts.throwAbort) {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (opts.throwNetwork) {
      throw new Error('Network failure');
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ content: [{ type: 'text', text }] }),
      text: async () => text,
    } as Response;
  };
}

// ── Confidential-terms fixture helpers ────────────────────────────────────────

let priorTermsPath: string | undefined;
let termsPathMutated = false;

afterEach(() => {
  if (!termsPathMutated) return;
  if (priorTermsPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = priorTermsPath;
  priorTermsPath = undefined;
  termsPathMutated = false;
});

function installSyntheticTerms(term: string): void {
  priorTermsPath = process.env.CONFIDENTIAL_TERMS_PATH;
  termsPathMutated = true;
  const dir = mkdtempSync(join(tmpdir(), 'lease-narr-conf-'));
  const file = join(dir, 'terms.json');
  writeFileSync(
    file,
    JSON.stringify({
      synthetic_deal: {
        label: 'Synthetic Test Deal',
        active: true,
        always: [term],
        context: [],
        context_requires_any: [],
      },
    }),
  );
  process.env.CONFIDENTIAL_TERMS_PATH = file;
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('composeLeaseNarrative — no apiKey', () => {
  it('returns { narrative: null, degraded: true } when apiKey is absent', async () => {
    const result = await composeLeaseNarrative(BASE_INPUT, {
      fetchImpl: mockFetch(VALID_AI_RESPONSE_TEXT),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('never calls fetchImpl when apiKey is absent', async () => {
    let called = false;
    const trackingFetch: typeof fetch = async (..._args) => {
      called = true;
      return mockFetch(VALID_AI_RESPONSE_TEXT)(..._args);
    };
    await composeLeaseNarrative(BASE_INPUT, { fetchImpl: trackingFetch });
    expect(called).toBe(false);
  });
});

describe('composeLeaseNarrative — happy path', () => {
  it('returns a populated NarrativeBlock on success', async () => {
    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(VALID_AI_RESPONSE_TEXT),
    });
    expect(result.degraded).toBe(false);
    expect(result.narrative).not.toBeNull();
    expect(result.narrative?.headline).toBe('Near-Term Lease Expiry Concentration');
    expect(result.narrative?.summary).toContain('$185,000');
    expect(result.narrative?.bullets).toHaveLength(4);
  });

  it('injects the model string into NarrativeBlock.model', async () => {
    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      model: 'claude-haiku-4-5-20251001',
      fetchImpl: mockFetch(VALID_AI_RESPONSE_TEXT),
    });
    expect(result.narrative?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('sends temperature 0 in the request body', async () => {
    let capturedBody: unknown;
    const capturingFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return mockFetch(VALID_AI_RESPONSE_TEXT)(_url, init);
    };
    await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: capturingFetch,
    });
    expect((capturedBody as { temperature?: number })?.temperature).toBe(0);
  });
});

describe('composeLeaseNarrative — network / timeout errors', () => {
  it('returns degraded on AbortError (timeout)', async () => {
    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('', 200, { throwAbort: true }),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded on network failure', async () => {
    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('', 200, { throwNetwork: true }),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('never throws — all errors return the degraded result object', async () => {
    await expect(
      composeLeaseNarrative(BASE_INPUT, {
        apiKey: 'test-api-key',
        fetchImpl: mockFetch('', 200, { throwNetwork: true }),
      }),
    ).resolves.toEqual({ narrative: null, degraded: true });
  });
});

describe('composeLeaseNarrative — malformed / empty AI responses', () => {
  it('returns degraded on malformed JSON from the model', async () => {
    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('not valid json at all'),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded when the model returns a JSON object missing required fields', async () => {
    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(JSON.stringify({ headline: 'Only a headline' })),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded on HTTP 500', async () => {
    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('Internal Server Error', 500),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded on empty content block', async () => {
    const emptyContentFetch: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ content: [] }),
        text: async () => '',
      }) as Response;
    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: emptyContentFetch,
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });
});

describe('composeLeaseNarrative — confidentiality guards', () => {
  it('post-receive: discards narrative when AI output contains a confidential term', async () => {
    const LEAK_TERM = 'zephyr_lease_xk9q_test';
    installSyntheticTerms(LEAK_TERM);

    const leakedResponse = JSON.stringify({
      headline: `Acquisition update re: ${LEAK_TERM}`,
      summary: 'Normal summary.',
      bullets: ['Bullet 1', 'Bullet 2'],
    });

    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(leakedResponse),
    });

    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('pre-send: does not call fetch when input contains a confidential term', async () => {
    const PRESEND_TERM = 'ora_lease_presend_poison_xk9q7z';
    installSyntheticTerms(PRESEND_TERM);

    let fetchCalled = false;
    const trackingFetch: typeof fetch = async (...args) => {
      fetchCalled = true;
      return mockFetch(VALID_AI_RESPONSE_TEXT)(...args);
    };

    const poisonedInput = {
      ...BASE_INPUT,
      slowLeasingProperties: [`${PRESEND_TERM} Industrial Park`],
    };

    const result = await composeLeaseNarrative(poisonedInput, {
      apiKey: 'test-api-key',
      fetchImpl: trackingFetch,
    });

    expect(fetchCalled).toBe(false);
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('post-receive: clean AI output passes through (no false positive)', async () => {
    const LEAK_TERM = 'lease_false_positive_q8x3';
    installSyntheticTerms(LEAK_TERM);

    const cleanResponse = JSON.stringify({
      headline: 'Near-Term Lease Expiry Concentration',
      summary: 'Several leases expire within 6 months.',
      bullets: ['4 at-risk', '2 lapsing'],
    });

    const result = await composeLeaseNarrative(BASE_INPUT, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(cleanResponse),
    });

    expect(result.narrative).not.toBeNull();
    expect(result.degraded).toBe(false);
    expect(result.narrative?.headline).toBe('Near-Term Lease Expiry Concentration');
  });
});

describe('LeaseNarrativeResponse contract', () => {
  it('parses a valid payload', () => {
    const parsed = LeaseNarrativeResponse.safeParse({
      asOf: '2026-06-21',
      narrative: {
        headline: 'Test',
        summary: 'Test summary.',
        bullets: ['bullet 1'],
        model: 'claude-haiku-4-5-20251001',
      },
      degraded: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a degraded payload with null narrative', () => {
    const parsed = LeaseNarrativeResponse.safeParse({
      asOf: '2026-06-21',
      narrative: null,
      degraded: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects payload missing degraded field', () => {
    const parsed = LeaseNarrativeResponse.safeParse({
      asOf: '2026-06-21',
      narrative: null,
      // degraded intentionally omitted
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects payload missing asOf field', () => {
    const parsed = LeaseNarrativeResponse.safeParse({
      narrative: null,
      degraded: true,
    });
    expect(parsed.success).toBe(false);
  });
});
