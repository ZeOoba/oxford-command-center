// tests/unit/om-extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractOmFields as extractOmFieldsReal, buildOmExtractSchema } from '../../server/warehouse/om-extract';
import type { OmExtractOptions } from '../../server/warehouse/om-extract';
import fieldsConfig from '../../server/warehouse/om-extract-fields.json';

// Minimal real-shaped Anthropic response
function mockFetch(text: string, status = 200) {
  return async (_url: unknown, _opts: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => text,
  });
}

// Captures the request so wiring tests can assert on the actual POST body.
function capturingFetch(text: string, status = 200) {
  const calls: Array<{ url: unknown; opts: { body?: string } }> = [];
  const fetchImpl = async (url: unknown, opts: { body?: string }) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ content: [{ type: 'text', text }] }),
      text: async () => text,
    };
  };
  return { fetchImpl, calls };
}

const VALID_PDF_BUFFER = Buffer.from('fake-pdf');
const VALID_JSON = JSON.stringify({
  price: '1450000',
  totalSf: '17688',
  yearBuilt: '1987',
  clearHeightFt: '18',
  hasDock: 'yes',
  UNKNOWN_KEY: 'should-be-stripped',
});

// Existing cases predate the egress roster scan and need no machine-local roster: default the scan to
// a no-hit stub. The fail-closed cases below pass their own confidentialScan explicitly.
const extractOmFields = (buf: Buffer, o: OmExtractOptions) =>
  extractOmFieldsReal(buf, { confidentialScan: () => null, ...o });

describe('extractOmFields', () => {
  it('returns error when no API key', async () => {
    const pdfParseFn = async () => ({ text: 'some text' });
    const result = await extractOmFields(VALID_PDF_BUFFER, { pdfParseFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ANTHROPIC_API_KEY/i);
  });

  it('returns error when PDF text is empty (image-only PDF)', async () => {
    const pdfParseFn = async () => ({ text: '   ' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scanned/i);
  });

  it('extracts known fields and strips unknown keys', async () => {
    const pdfParseFn = async () => ({ text: 'Industrial OM with lots of detail.' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch(VALID_JSON) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.price).toBe('1450000');
    expect(result.fields.totalSf).toBe('17688');
    expect(result.fields.hasDock).toBe('yes');
    expect('UNKNOWN_KEY' in result.fields).toBe(false);
    expect(result.fieldCount).toBe(5);
  });

  it('returns error when Claude returns malformed JSON', async () => {
    const pdfParseFn = async () => ({ text: 'OM text' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch('not json at all') as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/malformed/i);
  });

  it('returns error on HTTP 503', async () => {
    const pdfParseFn = async () => ({ text: 'OM text' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch('', 503) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unavailable/i);
  });

  it('returns empty fields (not error) when Claude finds nothing', async () => {
    const pdfParseFn = async () => ({ text: 'OM text' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch('{}') as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fieldCount).toBe(0);
    expect(Object.keys(result.fields)).toHaveLength(0);
  });

  describe('confidentiality egress guard', () => {
    it('blocks extraction for a confidential deal before any PDF parse or network call', async () => {
      let pdfParseCalled = false;
      let fetchCalled = false;
      const pdfParseFn = async () => {
        pdfParseCalled = true;
        return { text: 'Industrial OM with lots of detail.' };
      };
      const fetchImpl = (async () => {
        fetchCalled = true;
        return mockFetch(VALID_JSON)(undefined, undefined);
      }) as unknown as typeof fetch;

      const result = await extractOmFields(VALID_PDF_BUFFER, {
        apiKey: 'test-key',
        pdfParseFn,
        fetchImpl,
        dealConfidential: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/confidential/i);
        expect(result.status).toBe(403);
      }
      expect(pdfParseCalled).toBe(false);
      expect(fetchCalled).toBe(false);
    });

    it('blocks even when no API key is configured (block takes precedence)', async () => {
      const pdfParseFn = async () => ({ text: 'some text' });
      const result = await extractOmFields(VALID_PDF_BUFFER, { pdfParseFn, dealConfidential: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/confidential/i);
        expect(result.error).not.toMatch(/ANTHROPIC_API_KEY/i);
      }
    });

    it('proceeds as normal when dealConfidential is false (non-confidential deal)', async () => {
      const pdfParseFn = async () => ({ text: 'Industrial OM with lots of detail.' });
      const result = await extractOmFields(VALID_PDF_BUFFER, {
        apiKey: 'test-key',
        pdfParseFn,
        fetchImpl: mockFetch(VALID_JSON) as unknown as typeof fetch,
        dealConfidential: false,
      });
      expect(result.ok).toBe(true);
    });

    it('proceeds as normal when dealConfidential is omitted (blank-deal upload, nothing to check against)', async () => {
      const pdfParseFn = async () => ({ text: 'Industrial OM with lots of detail.' });
      const result = await extractOmFields(VALID_PDF_BUFFER, {
        apiKey: 'test-key',
        pdfParseFn,
        fetchImpl: mockFetch(VALID_JSON) as unknown as typeof fetch,
      });
      expect(result.ok).toBe(true);
    });

    // A dealId was supplied but the Deal couldn't be resolved (brain snapshot unavailable, or an
    // unknown/stale id) — confidentiality can't be verified. This must fail CLOSED, not silently
    // proceed as if the deal were non-confidential (mirrors server/briefing/confidential.ts's
    // fail-closed doctrine for confidentiality gates).
    it('fails closed when a dealId was supplied but the deal could not be resolved', async () => {
      let pdfParseCalled = false;
      let fetchCalled = false;
      const pdfParseFn = async () => {
        pdfParseCalled = true;
        return { text: 'Industrial OM with lots of detail.' };
      };
      const fetchImpl = (async () => {
        fetchCalled = true;
        return mockFetch(VALID_JSON)(undefined, undefined);
      }) as unknown as typeof fetch;

      const result = await extractOmFields(VALID_PDF_BUFFER, {
        apiKey: 'test-key',
        pdfParseFn,
        fetchImpl,
        dealLookupFailed: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/could not (be )?verif/i);
        expect(result.status).toBe(403);
      }
      expect(pdfParseCalled).toBe(false);
      expect(fetchCalled).toBe(false);
    });
  });

  it('drops explicit JSON null values (the schema requires every key; "not found" is null, not omission)', async () => {
    const pdfParseFn = async () => ({ text: 'OM text' });
    const responseWithNulls = JSON.stringify({
      price: '1450000',
      totalSf: null,
      yearBuilt: null,
      constructionType: null,
      hasDock: 'yes',
    });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch(responseWithNulls) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual({ price: '1450000', hasDock: 'yes' });
    expect(result.fieldCount).toBe(2);
  });

  it('sends output_config.format (structured outputs) and temperature:0 on the request', async () => {
    const pdfParseFn = async () => ({ text: 'OM text' });
    const { fetchImpl, calls } = capturingFetch(VALID_JSON);
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected exactly one fetch call');
    const body = JSON.parse(call.opts.body ?? '{}');
    expect(body.temperature).toBe(0);
    expect(body.output_config?.format?.type).toBe('json_schema');
    expect(body.output_config.format.schema).toEqual(buildOmExtractSchema());
    // The rest of the request is unchanged by this fix.
    expect(typeof body.model).toBe('string');
    expect(body.max_tokens).toBe(1024);
    expect(typeof body.system).toBe('string');
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

describe('buildOmExtractSchema', () => {
  const schema = buildOmExtractSchema();
  const manifestKeys = fieldsConfig.fields.map((f) => f.key);

  // Shape verified against the live API (2026-07-18): an all-optional / omit-from-required
  // version of this schema reliably hit "Grammar compilation timed out" (even with zero
  // enums), while this all-required + nullable shape compiled in ~12s and returned correct
  // results. "Not found" is expressed as JSON null, not an omitted key — see the
  // "drops explicit JSON null values" test in the extractOmFields describe block above.
  it('is a JSON Schema object with additionalProperties:false and every field required', () => {
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(manifestKeys);
  });

  it('has exactly one property per manifest field', () => {
    expect(Object.keys(schema.properties)).toEqual(manifestKeys);
  });

  it('types every non-enum field as a nullable string', () => {
    for (const field of fieldsConfig.fields) {
      if ('enum' in field) continue;
      expect(schema.properties[field.key]).toEqual({ type: ['string', 'null'] });
    }
  });

  it('constrains constructionType, hasDock, hasDriveIn via anyOf(enum-string, null)', () => {
    expect(schema.properties.constructionType).toEqual({
      anyOf: [{ type: 'string', enum: ['block-tilt-brick', 'mixed', 'pemb', 'unknown'] }, { type: 'null' }],
    });
    expect(schema.properties.hasDock).toEqual({
      anyOf: [{ type: 'string', enum: ['yes', 'no'] }, { type: 'null' }],
    });
    expect(schema.properties.hasDriveIn).toEqual({
      anyOf: [{ type: 'string', enum: ['yes', 'no'] }, { type: 'null' }],
    });
  });

  it('stays within Anthropic\'s union-type-parameter limit (16 total allowed) with 1 field of headroom', () => {
    // Every property here uses either a type array or anyOf, so all 15 count toward this
    // limit (separate from the unused "optional parameters" limit of 24) — documented at
    // https://platform.claude.com/docs/en/build-with-claude/structured-outputs. 16 is the
    // ceiling (not the trigger point); this guard fails CI before a 17th manifest field
    // would silently produce an invalid request, discovered only via a live API failure.
    expect(Object.keys(schema.properties).length).toBeLessThanOrEqual(16);
  });
});

describe('extractOmFields egress roster scan (blank-deal upload)', () => {
  const pdfParseFn = async () => ({ text: 'Confidential OM for SyntheticCo Plaza, asking $1.0M' });

  it('blocks a blank-deal upload whose text matches the roster, without calling the network', async () => {
    let called = false;
    const result = await extractOmFieldsReal(VALID_PDF_BUFFER, {
      apiKey: 'k',
      pdfParseFn,
      confidentialScan: () => ({ dealLabel: 'Synthetic Deal' }),
      fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).not.toContain('SyntheticCo');
      expect(result.error).not.toContain('Synthetic Deal');
    }
    expect(called).toBe(false);
  });

  it('fails CLOSED (403, no network) when the roster scan throws (roster missing/unreadable)', async () => {
    let called = false;
    const result = await extractOmFieldsReal(VALID_PDF_BUFFER, {
      apiKey: 'k',
      pdfParseFn,
      confidentialScan: () => { throw new Error('confidential-terms.json missing'); },
      fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(called).toBe(false);
  });

  it('DEFAULT wiring (production path, no injected scan) blocks a roster match and never calls the network', async () => {
    let called = false;
    const result = await extractOmFieldsReal(VALID_PDF_BUFFER, {
      apiKey: 'k',
      pdfParseFn: async () => ({ text: 'OM narrative mentioning zzz-confidential-trigger-9f3a1c in the body' }),
      fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(called).toBe(false);
  });

  it('DEFAULT wiring fails CLOSED when the roster file is unreadable', async () => {
    const saved = process.env.CONFIDENTIAL_TERMS_PATH;
    process.env.CONFIDENTIAL_TERMS_PATH = 'C:/definitely/not/a/roster.json';
    let called = false;
    try {
      const result = await extractOmFieldsReal(VALID_PDF_BUFFER, {
        apiKey: 'k',
        pdfParseFn: async () => ({ text: 'ordinary OM text' }),
        fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
      expect(called).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
      else process.env.CONFIDENTIAL_TERMS_PATH = saved;
    }
  });

  it('scans the exact text that would be sent (the truncated body)', async () => {
    const seen: string[] = [];
    await extractOmFieldsReal(VALID_PDF_BUFFER, {
      apiKey: 'k',
      pdfParseFn: async () => ({ text: 'x'.repeat(40_000) }),
      confidentialScan: (t) => { seen.push(t); return { dealLabel: 'stop here' }; },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.length).toBeLessThan(40_000);
  });
});

describe('extractOmFields — upstream failures do not leak raw text', () => {
  const pdfParseFn = async () => ({ text: 'Industrial OM with lots of detail.' });

  it('network error: generic 503, no raw exception text', async () => {
    const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:443'); }) as unknown as typeof fetch;
    const r = await extractOmFields(VALID_PDF_BUFFER, { apiKey: 'test-key', pdfParseFn, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.error).not.toMatch(/ECONNREFUSED|10\.1\.2\.3/);
    }
  });

  it('non-2xx: 502 with status only, upstream body not echoed', async () => {
    const r = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch('upstream org_SECRET123 trace', 500) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.error).toContain('500');
      expect(r.error).not.toContain('org_SECRET123');
    }
  });
});
