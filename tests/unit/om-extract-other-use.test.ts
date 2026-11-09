// tests/unit/om-extract-other-use.test.ts
//
// E3 (audit 2026-11-08, other-use-no-om-producer). The other-use KILL screen (tenure, ground-lease term, environmental
// remediation, automotive / child-related use) caps every deal at T2 while unknown, and nothing filled it from the OM.
// The main extraction schema already carries 15 of the 16 union-type parameters Anthropic allows PER REQUEST (the limit
// is the "combined total across all strict schemas in a single request"), so a nested sub-object would not help: the six
// other-use fields go in a SECOND small request with its own schema. Fixtures use synthetic names only.
import { describe, expect, it } from 'vitest';
import {
  buildOmExtractSchema, buildOmOtherUseSchema, extractOmFields as extractOmFieldsReal, type OmExtractOptions,
} from '../../server/warehouse/om-extract';

const extractOmFields = (buf: Buffer, o: OmExtractOptions) => extractOmFieldsReal(buf, { confidentialScan: () => null, ...o });

/** Count the parameters that use anyOf or a type array, recursively (Anthropic's union-type limit). */
function unionParamCount(schema: unknown): number {
  if (typeof schema !== 'object' || schema === null) return 0;
  const s = schema as { properties?: Record<string, unknown> };
  let n = 0;
  for (const p of Object.values(s.properties ?? {})) {
    const prop = p as { anyOf?: unknown; type?: unknown };
    if (Array.isArray(prop.anyOf) || Array.isArray(prop.type)) n++;
    n += unionParamCount(p);
  }
  return n;
}

interface Reply { text?: string; status?: number; throws?: boolean; jsonThrows?: boolean }
type Body = { temperature?: number; system?: string; messages?: unknown; output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } } };

/** Answers each request by its schema: the main extraction gets `main`, the other-use extraction gets `otherUse`. */
function routingFetch(main: Reply, otherUse: Reply) {
  const bodies: Body[] = [];
  const fetchImpl = async (_url: unknown, opts: { body?: string }) => {
    const body = JSON.parse(opts.body ?? '{}') as Body;
    bodies.push(body);
    const r = isOtherUse(body) ? otherUse : main;
    if (r.throws) throw new Error('connect ECONNREFUSED');
    const status = r.status ?? 200;
    const text = r.text ?? '{}';
    const json = async () => {
      if (r.jsonThrows) throw new SyntaxError('Unexpected token < in JSON');
      return { content: [{ type: 'text', text }] };
    };
    return { ok: status >= 200 && status < 300, status, json, text: async () => text };
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}
const isOtherUse = (b: Body): boolean => 'groundLeased' in (b.output_config?.format?.schema?.properties ?? {});

const OTHER_USE_NULLS = {
  groundLeased: null, groundLeaseYearsRemaining: null, envRemediationPctOfPrice: null,
  useAutomotive: null, useChildRelated: null, useChildSafetyReviewed: null,
};
const MAIN_JSON = JSON.stringify({ price: '2100000', totalSf: '24000', hasDock: 'yes' });
const BUF = Buffer.from('fake-pdf');
const pdf = async () => ({ text: 'Zephyr Corp flex building OM.' });
const run = (fetchImpl: typeof fetch) => extractOmFields(BUF, { apiKey: 'k', pdfParseFn: pdf, fetchImpl });

describe('other-use OM producer (E3, audit 2026-11-08)', () => {
  it('sends TWO requests, each within the 16 union-type-parameter limit (the limit is per request)', async () => {
    const { fetchImpl, bodies } = routingFetch({ text: MAIN_JSON }, { text: JSON.stringify(OTHER_USE_NULLS) });
    const r = await run(fetchImpl);
    expect(r.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(unionParamCount(b.output_config?.format?.schema)).toBeLessThanOrEqual(16);
      expect(b.temperature).toBe(0);
    }
    const schemas = bodies.map((b) => b.output_config?.format?.schema);
    expect(schemas).toContainEqual(buildOmExtractSchema());
    expect(schemas).toContainEqual(buildOmOtherUseSchema());
  });

  it('the other-use schema: six required, nullable properties, yes/no enums for the tri-states, no main field', () => {
    const s = buildOmOtherUseSchema();
    const keys = Object.keys(OTHER_USE_NULLS).sort();
    expect(Object.keys(s.properties).sort()).toEqual(keys);
    expect([...s.required].sort()).toEqual(keys);
    expect(s.additionalProperties).toBe(false);
    for (const k of ['groundLeased', 'useAutomotive', 'useChildRelated', 'useChildSafetyReviewed']) {
      expect(s.properties[k]).toEqual({ anyOf: [{ type: 'string', enum: ['yes', 'no'] }, { type: 'null' }] });
    }
    for (const k of ['groundLeaseYearsRemaining', 'envRemediationPctOfPrice']) expect(s.properties[k]).toEqual({ type: ['string', 'null'] });
    expect(unionParamCount(s)).toBe(6);
    expect(unionParamCount(buildOmExtractSchema())).toBe(15);
  });

  it('ground-lease OM: fills tenure and the stated term, leaves the unstated fields out', async () => {
    const { fetchImpl } = routingFetch({ text: MAIN_JSON }, { text: JSON.stringify({ ...OTHER_USE_NULLS, groundLeased: 'yes', groundLeaseYearsRemaining: '45' }) });
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(r.fields).toEqual({ price: '2100000', totalSf: '24000', hasDock: 'yes', groundLeased: 'yes', groundLeaseYearsRemaining: '45' });
    expect(r.fieldCount).toBe(5);
  });

  it('Phase-I-clean, fee-simple OM: envRemediationPctOfPrice 0 and groundLeased no', async () => {
    const { fetchImpl } = routingFetch({ text: MAIN_JSON }, { text: JSON.stringify({ ...OTHER_USE_NULLS, groundLeased: 'no', envRemediationPctOfPrice: '0' }) });
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(r.fields.groundLeased).toBe('no');
    expect(r.fields.envRemediationPctOfPrice).toBe('0');
    expect('groundLeaseYearsRemaining' in r.fields).toBe(false);
  });

  it('use flags come back under the FORM keys (use:*), so Apply merges them into the underwriting form unchanged', async () => {
    const { fetchImpl } = routingFetch({ text: '{}' }, { text: JSON.stringify({ ...OTHER_USE_NULLS, useAutomotive: 'yes', useChildRelated: 'no' }) });
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(r.fields).toEqual({ 'use:automotive': 'yes', 'use:childRelated': 'no' });
  });

  it('an OM that states none of them yields none of them (never invented)', async () => {
    const { fetchImpl } = routingFetch({ text: MAIN_JSON }, { text: JSON.stringify(OTHER_USE_NULLS) });
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(Object.keys(r.fields).sort()).toEqual(['hasDock', 'price', 'totalSf']);
  });

  it('drops a non-numeric or out-of-range number rather than passing it to the form', async () => {
    const bad: Array<[string, string]> = [
      ['envRemediationPctOfPrice', '150'], ['envRemediationPctOfPrice', '-1'], ['envRemediationPctOfPrice', 'about 5'],
      ['envRemediationPctOfPrice', '0.2 (20%)'], ['envRemediationPctOfPrice', '5%'], ['groundLeaseYearsRemaining', '-3'],
      ['groundLeaseYearsRemaining', '45 years'], ['groundLeaseYearsRemaining', 'Infinity'], ['groundLeaseYearsRemaining', '1e3'],
      ['groundLeaseYearsRemaining', '0x2D'],
    ];
    for (const [field, value] of bad) {
      const { fetchImpl } = routingFetch({ text: '{}' }, { text: JSON.stringify({ ...OTHER_USE_NULLS, [field]: value }) });
      const r = await run(fetchImpl);
      if (!r.ok) throw new Error(r.error);
      expect(field in r.fields, `${field}=${value}`).toBe(false);
    }
    const { fetchImpl } = routingFetch({ text: '{}' }, { text: JSON.stringify({ ...OTHER_USE_NULLS, envRemediationPctOfPrice: '12.5', groundLeaseYearsRemaining: '30' }) });
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(r.fields).toEqual({ envRemediationPctOfPrice: '12.5', groundLeaseYearsRemaining: '30' });
  });

  it("a response cannot fill the OTHER call's fields (each call keeps only its own keys)", async () => {
    const { fetchImpl } = routingFetch(
      { text: JSON.stringify({ price: '2100000', groundLeased: 'no', 'use:automotive': 'no', useAutomotive: 'no' }) },
      { text: JSON.stringify({ ...OTHER_USE_NULLS, price: '1', totalSf: '2', 'use:automotive': 'no' }) },
    );
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(r.fields).toEqual({ price: '2100000' });
  });

  it.each([
    ['HTTP 503', { status: 503 }], ['HTTP 500', { status: 500 }], ['malformed JSON', { text: 'not json' }],
    ['array JSON', { text: '[]' }], ['network error', { throws: true }], ['non-JSON response body', { jsonThrows: true }],
  ] as const)('other-use call fails (%s): the main fields still return, the other-use fields stay unknown', async (_l, failure) => {
    const { fetchImpl } = routingFetch({ text: MAIN_JSON }, failure);
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(Object.keys(r.fields).sort()).toEqual(['hasDock', 'price', 'totalSf']);
  });

  it('main call fails: the request fails as before even when the other-use call succeeded', async () => {
    const { fetchImpl } = routingFetch({ status: 503 }, { text: JSON.stringify({ ...OTHER_USE_NULLS, groundLeased: 'no' }) });
    const r = await run(fetchImpl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it('only other-use fields found: fieldCount counts them, and the copy-OM-text fallback still appears (main found nothing)', async () => {
    const { fetchImpl } = routingFetch({ text: '{}' }, { text: JSON.stringify({ ...OTHER_USE_NULLS, groundLeased: 'no' }) });
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(r.fieldCount).toBe(1);
    expect(r.rawText).toContain('Zephyr Corp');
  });

  it('main fields found: no raw text attached, whatever the other-use call returned', async () => {
    const { fetchImpl } = routingFetch({ text: MAIN_JSON }, { text: JSON.stringify(OTHER_USE_NULLS) });
    const r = await run(fetchImpl);
    if (!r.ok) throw new Error(r.error);
    expect(r.rawText).toBeUndefined();
  });

  it('the other-use prompt carries the never-guess rules (Phase I no RECs = 0; use flags only when stated)', async () => {
    const { fetchImpl, bodies } = routingFetch({ text: '{}' }, { text: JSON.stringify(OTHER_USE_NULLS) });
    await run(fetchImpl);
    const other = bodies.find(isOtherUse);
    const prompt = JSON.stringify([other?.system, other?.messages]);
    expect(prompt).toMatch(/Phase I/);
    expect(prompt).toMatch(/RECs/);
    expect(prompt).toMatch(/[Nn]ever infer/);
    expect(prompt).toMatch(/fee simple/);
    expect(prompt).toMatch(/Zephyr Corp/); // the same OM text both calls send
  });

  it('a confidential OM blocks BOTH calls (no network at all)', async () => {
    const { fetchImpl, bodies } = routingFetch({ text: MAIN_JSON }, { text: '{}' });
    const r = await extractOmFieldsReal(BUF, { apiKey: 'k', pdfParseFn: pdf, fetchImpl, confidentialScan: () => ({ dealLabel: 'x' }) });
    expect(r.ok).toBe(false);
    expect(bodies).toHaveLength(0);
  });

  it('the deal-name gate re-checked at egress blocks BOTH calls', async () => {
    const { fetchImpl, bodies } = routingFetch({ text: MAIN_JSON }, { text: '{}' });
    const r = await extractOmFields(BUF, { apiKey: 'k', pdfParseFn: pdf, fetchImpl, mentionsConfidentialDeal: () => true });
    expect(r.ok).toBe(false);
    expect(bodies).toHaveLength(0);
  });
});

describe('extracted other-use fields reach the engine through the form unchanged (E3)', () => {
  it('fee simple + Phase I clean + no automotive/child use: the other-use gate is determinate (no T2 cap from it)', async () => {
    const { AcquisitionInput } = await import('@contracts/acquisition');
    const { buildInput } = await import('../../src/modules/acquisitions/acquisition-score');
    const input = AcquisitionInput.parse(buildInput({ groundLeased: 'no', envRemediationPctOfPrice: '0', 'use:automotive': 'no', 'use:childRelated': 'no' }, 'd'));
    expect(input.groundLeased).toBe(false);
    expect(input.envRemediationPctOfPrice).toBe(0);
    expect(input.use).toEqual({ automotive: false, childRelated: false, childSafetyReviewed: false });
  });

  it('a stated ground lease and term arrive as numbers; an incomplete use screen stays unknown (null)', async () => {
    const { AcquisitionInput } = await import('@contracts/acquisition');
    const { buildInput } = await import('../../src/modules/acquisitions/acquisition-score');
    const input = AcquisitionInput.parse(buildInput({ groundLeased: 'yes', groundLeaseYearsRemaining: '45', envRemediationPctOfPrice: '12.5', 'use:childRelated': 'yes' }, 'd'));
    expect(input.groundLeased).toBe(true);
    expect(input.groundLeaseYearsRemaining).toBe(45);
    expect(input.envRemediationPctOfPrice).toBeCloseTo(0.125, 12);
    expect(input.use).toBeNull();
  });
});
