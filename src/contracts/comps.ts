import { z } from 'zod';

/** A comparable sale. Web data is sparse → only address + source are required. */
export const SaleComp = z.object({
  address: z.string(),
  market: z.string().nullable().default(null),
  sf: z.number().nullable().default(null),
  price: z.number().nullable().default(null),
  pricePerSf: z.number().nullable().default(null),
  capRate: z.number().nullable().default(null), // decimal (0.08 = 8%)
  date: z.string().nullable().default(null),
  source: z.string(),
});
export type SaleComp = z.infer<typeof SaleComp>;

/** A comparable lease. */
export const RentComp = z.object({
  address: z.string(),
  sf: z.number().nullable().default(null),
  rentPerSf: z.number().nullable().default(null), // $/SF/yr (NNN unless noted)
  leaseType: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  source: z.string(),
});
export type RentComp = z.infer<typeof RentComp>;

/** A free-form submarket statistic (vacancy, asking-rent trend, absorption, supply…). */
export const SubmarketStat = z.object({
  label: z.string(),
  value: z.string(),
  source: z.string().nullable().default(null),
});
export type SubmarketStat = z.infer<typeof SubmarketStat>;

/** The cached comp research for one deal. Always AI-sourced; `sourcedAt` drives the freshness tag. */
export const CompSet = z.object({
  saleComps: z.array(SaleComp).default([]),
  rentComps: z.array(RentComp).default([]),
  submarketStats: z.array(SubmarketStat).default([]),
  summary: z.string().nullable().default(null),
  sources: z.array(z.string()).default([]),
  sourcedAt: z.string(), // ISO timestamp the research was cached
});
export type CompSet = z.infer<typeof CompSet>;

/** POST /api/actions/deal-comps body. */
export const DealCompsActionInput = z.object({ dealId: z.string().min(1) });
export type DealCompsActionInput = z.infer<typeof DealCompsActionInput>;

/**
 * Anthropic client-tool schema. The model web-searches freely, then ends its turn by calling
 * record_comps exactly once with structured findings — which we read from the response and
 * validate with CompSet (stamping sourcedAt ourselves).
 */
export const RECORD_COMPS_TOOL = {
  name: 'record_comps',
  description: 'Record the market comparables you found. Call this exactly once, last, with all findings.',
  input_schema: {
    type: 'object',
    properties: {
      saleComps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            market: { type: ['string', 'null'] },
            sf: { type: ['number', 'null'] },
            price: { type: ['number', 'null'] },
            pricePerSf: { type: ['number', 'null'] },
            capRate: { type: ['number', 'null'], description: 'decimal, e.g. 0.08 for 8%' },
            date: { type: ['string', 'null'] },
            source: { type: 'string', description: 'URL or publication' },
          },
          required: ['address', 'source'],
        },
      },
      rentComps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            sf: { type: ['number', 'null'] },
            rentPerSf: { type: ['number', 'null'], description: '$/SF/yr, NNN unless noted' },
            leaseType: { type: ['string', 'null'] },
            date: { type: ['string', 'null'] },
            source: { type: 'string' },
          },
          required: ['address', 'source'],
        },
      },
      submarketStats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
            source: { type: ['string', 'null'] },
          },
          required: ['label', 'value'],
        },
      },
      summary: { type: ['string', 'null'], description: 'one-paragraph read of pricing/positioning + any data gaps' },
      sources: { type: 'array', items: { type: 'string' }, description: 'all source URLs/publications used' },
    },
    required: ['saleComps', 'rentComps', 'submarketStats'],
  },
} as const;
