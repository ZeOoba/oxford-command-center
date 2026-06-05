import { describe, it, expect } from 'vitest';
import { CompSet, SaleComp, DealCompsActionInput, RECORD_COMPS_TOOL } from '../../src/contracts/comps';

describe('CompSet contract', () => {
  it('defaults all comp arrays and fills nullable comp fields', () => {
    const cs = CompSet.parse({ sourcedAt: '2026-06-05T00:00:00.000Z' });
    expect(cs.saleComps).toEqual([]);
    expect(cs.rentComps).toEqual([]);
    expect(cs.submarketStats).toEqual([]);
    expect(cs.sources).toEqual([]);
    expect(cs.summary).toBeNull();
  });

  it('parses a sale comp with sparse fields (address + source required)', () => {
    const sc = SaleComp.parse({ address: '123 Main', source: 'LoopNet' });
    expect(sc.address).toBe('123 Main');
    expect(sc.pricePerSf).toBeNull();
    expect(SaleComp.safeParse({ source: 'x' }).success).toBe(false); // address required
  });

  it('validates the action input', () => {
    expect(DealCompsActionInput.safeParse({ dealId: 'd1' }).success).toBe(true);
    expect(DealCompsActionInput.safeParse({ dealId: '' }).success).toBe(false);
  });

  it('exposes a record_comps tool schema for the model', () => {
    expect(RECORD_COMPS_TOOL.name).toBe('record_comps');
    expect(RECORD_COMPS_TOOL.input_schema.type).toBe('object');
    expect(Object.keys(RECORD_COMPS_TOOL.input_schema.properties)).toEqual(
      expect.arrayContaining(['saleComps', 'rentComps', 'submarketStats', 'summary', 'sources']),
    );
  });
});
