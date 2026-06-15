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
});
