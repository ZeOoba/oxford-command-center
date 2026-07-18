// tests/unit/om-extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractOmFields } from '../../server/warehouse/om-extract';

// Minimal real-shaped Anthropic response
function mockFetch(text: string, status = 200) {
  return async (_url: unknown, _opts: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => text,
  });
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
});
