// @vitest-environment node
//
// tests/unit/narrative.test.ts
//
// Phase 2 · Workstream 2 — AI Narrative Briefings (Step 8).
// Spec: docs/superpowers/specs/2026-06-21-phase-2-w2-ai-narrative-briefings.md
//
// Tests composeNarrative via injected fetchImpl (no real HTTP calls).
// Covers: happy path, no apiKey, non-200, AbortError/timeout, malformed JSON,
// empty content, post-receive confidential hit, pre-send confidential assertion.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { composeNarrative, DEFAULT_MODEL } from '../../server/ai/narrative';
import type { BriefingModel } from '../../src/contracts/briefing';

// ── Minimal valid BriefingModel fixtures ─────────────────────────────────────────────────────

const BASE_META = {
  generatedDate: '2026-06-21',
  workbookAsOf: '2026-06-01',
  dataFreshness: null,
  confidentialMarking: 'CONFIDENTIAL — INTERNAL' as const,
  masthead: 'OXFORD REALTY ADVISORS' as const,
};

const BASE_FIGURE = { display: '$104,000', value: 104000, unit: 'usd' as const };
const ZERO_FIGURE = { display: '—', value: null, unit: 'none' as const };

/** Minimal valid property BriefingModel. */
const PROPERTY_MODEL: BriefingModel = {
  kind: 'property',
  meta: BASE_META,
  subject: {
    propertyId: 'test-property-slug',
    name: 'Test Property',
    market: 'Columbus, OH',
    manager: 'Test Manager',
    scoredPeriod: '2025',
  },
  verdict: {
    health: { display: '72.0', value: 72.0, unit: 'none' },
    healthBand: 'good',
    attentionBand: 'yellow',
    capitalAction: 'hold',
    rootCause: null,
    recommendation: 'Hold and optimize operating performance.',
  },
  kpis: [
    { label: 'NOI', figure: BASE_FIGURE, spark: [90000, 104000] },
    { label: 'NOI/SF', figure: { display: '$4.80 /SF', value: 4.8, unit: 'usd_per_sf' }, spark: [] },
  ],
  noiTrend: [90000, 104000],
  drivers: [
    {
      category: 'Rental Revenue',
      delta: { display: '+$14,000', value: 14000, unit: 'usd' },
      contributionPct: { display: '100.0%', value: 100.0, unit: 'pct' },
    },
  ],
  anomalies: [],
  leaseRun: {
    present: false,
    tenant: null,
    currentExpiry: null,
    stabilizedNoi: ZERO_FIGURE,
    indicativeValue: ZERO_FIGURE,
    belowMarket: false,
    rolloverLabels: [],
  },
  benchmark: {
    noiPerSfQuartile: 2,
    cohortSize: 10,
    noiPerSf: { display: '$4.80 /SF', value: 4.8, unit: 'usd_per_sf' },
    cohortMedianNoiPerSf: { display: '$4.20 /SF', value: 4.2, unit: 'usd_per_sf' },
  },
};

/** Minimal valid manager BriefingModel. */
const MANAGER_MODEL: BriefingModel = {
  kind: 'manager',
  meta: BASE_META,
  subject: {
    managerId: 'test-manager',
    name: 'Test Manager',
    contact: null,
    propertyCount: 2,
    smallSample: true,
  },
  scorecard: {
    avgNoiPerSf: { display: '$4.80 /SF', value: 4.8, unit: 'usd_per_sf' },
    avgNoiGrowth: { display: '10.0%', value: 10.0, unit: 'pct' },
    avgExpenseGrowth: { display: '-6.7%', value: -6.7, unit: 'pct' },
  },
  managedProperties: [
    {
      propertyId: 'test-property-slug',
      name: 'Test Property',
      health: { display: '72.0', value: 72.0, unit: 'none' },
      healthBand: 'good',
      noi: BASE_FIGURE,
      attentionBand: 'green',
    },
  ],
  attentionItems: ['Monitor deferred maintenance.'],
  actionList: ['Schedule preventive maintenance review.'],
};

// ── Mock fetch helpers ─────────────────────────────────────────────────────────────────────────

/** The valid AI response payload the API would return. */
const VALID_AI_RESPONSE_TEXT = JSON.stringify({
  headline: 'Strong NOI Growth',
  summary: 'The property delivered solid NOI growth in 2025.',
  bullets: [
    'NOI grew from $90,000 to $104,000',
    'Revenue driver: Rental Revenue +$14,000',
    'Benchmark: 2nd quartile in cohort of 10',
  ],
});

/** Build a mock fetchImpl that returns the given body text with the given HTTP status. */
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

// Track env mutations so afterEach only restores when a test actually mutated the var.
// Without the flag, afterEach would unconditionally delete CONFIDENTIAL_TERMS_PATH even for
// tests that never called installSyntheticTerms, causing cross-test env contamination.
let priorTermsPath: string | undefined;
let termsPathMutated = false;

afterEach(() => {
  if (!termsPathMutated) return;
  if (priorTermsPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = priorTermsPath;
  priorTermsPath = undefined;
  termsPathMutated = false;
});

/** Write a synthetic confidential-terms file and point the env var at it.
 *  Returns the always-term that will trigger a scan hit. */
function installSyntheticTerms(term: string): void {
  priorTermsPath = process.env.CONFIDENTIAL_TERMS_PATH;
  termsPathMutated = true;
  const dir = mkdtempSync(join(tmpdir(), 'narrative-conf-'));
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

// ── Test suites ───────────────────────────────────────────────────────────────────────────────

describe('composeNarrative — no apiKey', () => {
  it('returns { narrative: null, degraded: true } when apiKey is absent', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      fetchImpl: mockFetch(VALID_AI_RESPONSE_TEXT),
      // no apiKey
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
    await composeNarrative(PROPERTY_MODEL, { fetchImpl: trackingFetch });
    expect(called).toBe(false);
  });
});

describe('composeNarrative — happy path (property)', () => {
  it('returns a populated NarrativeBlock on success', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(VALID_AI_RESPONSE_TEXT),
    });
    expect(result.degraded).toBe(false);
    expect(result.narrative).not.toBeNull();
    expect(result.narrative?.headline).toBe('Strong NOI Growth');
    expect(result.narrative?.summary).toContain('NOI growth');
    expect(result.narrative?.bullets).toHaveLength(3);
  });

  it('injects the model string into NarrativeBlock.model', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      model: DEFAULT_MODEL,
      fetchImpl: mockFetch(VALID_AI_RESPONSE_TEXT),
    });
    expect(result.narrative?.model).toBe(DEFAULT_MODEL);
  });

  it(`uses ${DEFAULT_MODEL} as the default model`, async () => {
    let capturedBody: unknown;
    const capturingFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return mockFetch(VALID_AI_RESPONSE_TEXT)(_url, init);
    };
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: capturingFetch,
    });
    expect(result.narrative?.model).toBe(DEFAULT_MODEL);
    expect((capturedBody as { model?: string })?.model).toBe(DEFAULT_MODEL);
  });

  it('sends temperature 0 in the request body', async () => {
    let capturedBody: unknown;
    const capturingFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return mockFetch(VALID_AI_RESPONSE_TEXT)(_url, init);
    };
    await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: capturingFetch,
    });
    expect((capturedBody as { temperature?: number })?.temperature).toBe(0);
  });
});

describe('composeNarrative — happy path (manager)', () => {
  it('returns a populated NarrativeBlock for a manager model', async () => {
    const result = await composeNarrative(MANAGER_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(VALID_AI_RESPONSE_TEXT),
    });
    expect(result.degraded).toBe(false);
    expect(result.narrative).not.toBeNull();
    expect(result.narrative?.headline).toBe('Strong NOI Growth');
  });
});

describe('composeNarrative — HTTP non-200 responses', () => {
  it('returns degraded on HTTP 500', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('Internal Server Error', 500),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded on HTTP 429', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('Rate limited', 429),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded on HTTP 401 (bad key)', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'bad-key',
      fetchImpl: mockFetch('Unauthorized', 401),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });
});

describe('composeNarrative — timeout / network errors', () => {
  it('returns degraded on AbortError (timeout)', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('', 200, { throwAbort: true }),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded on network failure', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('', 200, { throwNetwork: true }),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('never throws — all errors return the degraded result object', async () => {
    await expect(
      composeNarrative(PROPERTY_MODEL, {
        apiKey: 'test-api-key',
        fetchImpl: mockFetch('', 200, { throwNetwork: true }),
      }),
    ).resolves.toEqual({ narrative: null, degraded: true });
  });
});

describe('composeNarrative — malformed / empty AI responses', () => {
  it('returns degraded on malformed JSON from the model', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch('not valid json at all'),
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded when the model returns a JSON object missing required fields', async () => {
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      // Missing `summary` and `bullets`
      fetchImpl: mockFetch(JSON.stringify({ headline: 'Only a headline' })),
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
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: emptyContentFetch,
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('returns degraded when content block has no text field', async () => {
    const noTextFetch: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'tool_use', id: 'abc' }] }),
        text: async () => '',
      }) as Response;
    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: noTextFetch,
    });
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });
});

describe('composeNarrative — confidentiality guards', () => {
  it('pre-send: does NOT call fetch when the model subset contains a confidential term', async () => {
    // Install a synthetic confidential term so this test is deterministic whether or not the
    // real confidential-terms.json is present on the box (CI vs. local dev). The built-in
    // __ora_confidential_placeholder__ only works when that file is ABSENT — on this machine
    // the live terms file supersedes the fallback and the placeholder is never in it.
    const PRESEND_TERM = 'ora_presend_poison_xk9q7z';
    installSyntheticTerms(PRESEND_TERM);

    let fetchCalled = false;
    const trackingFetch: typeof fetch = async (...args) => {
      fetchCalled = true;
      return mockFetch(VALID_AI_RESPONSE_TEXT)(...args);
    };

    // Embed the synthetic term in the model's subject name — assertNoConfidential must fire
    // against the built subset BEFORE any HTTP call.
    const poisonedModel: BriefingModel = {
      ...PROPERTY_MODEL,
      subject: {
        ...PROPERTY_MODEL.subject,
        name: `Property ${PRESEND_TERM} Holdings`,
      },
    } as BriefingModel;

    const result = await composeNarrative(poisonedModel, {
      apiKey: 'test-api-key',
      fetchImpl: trackingFetch,
    });

    expect(fetchCalled).toBe(false);
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('post-receive: discards narrative when AI output contains a confidential term', async () => {
    // Install a synthetic term. The mock AI response will contain it.
    const LEAK_TERM = 'zephyr_holdings_xk9q';
    installSyntheticTerms(LEAK_TERM);

    // The mock AI returns a response that contains the confidential term in its body
    const leakedResponse = JSON.stringify({
      headline: `Acquisition update re: ${LEAK_TERM}`,
      summary: 'Summary without the term.',
      bullets: ['Bullet 1', 'Bullet 2'],
    });

    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(leakedResponse),
    });

    // The narrative must be discarded — never rendered
    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('post-receive: discards narrative when term appears in bullets', async () => {
    const LEAK_TERM = 'secret_parcel_7z2m';
    installSyntheticTerms(LEAK_TERM);

    const leakedResponse = JSON.stringify({
      headline: 'Normal Headline',
      summary: 'Normal summary.',
      bullets: [`Refer to ${LEAK_TERM} for context`, 'Other bullet'],
    });

    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(leakedResponse),
    });

    expect(result.narrative).toBeNull();
    expect(result.degraded).toBe(true);
  });

  it('post-receive: clean AI output passes through (no false positive)', async () => {
    const LEAK_TERM = 'false_positive_term_q8x3';
    installSyntheticTerms(LEAK_TERM);

    // The mock AI response does NOT contain the term
    const cleanResponse = JSON.stringify({
      headline: 'Strong NOI Growth',
      summary: 'The property performed well in 2025.',
      bullets: ['NOI grew 15%', 'Expense discipline held'],
    });

    const result = await composeNarrative(PROPERTY_MODEL, {
      apiKey: 'test-api-key',
      fetchImpl: mockFetch(cleanResponse),
    });

    expect(result.narrative).not.toBeNull();
    expect(result.degraded).toBe(false);
    expect(result.narrative?.headline).toBe('Strong NOI Growth');
  });
});
