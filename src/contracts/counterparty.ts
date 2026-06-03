import { z } from 'zod';

/**
 * A relationship node in the entity graph — a firm or person Oxford transacts with.
 * Lenders & carriers are DERIVED from the workbook (loans, insurance, deals);
 * counsel, title, and principals are SEEDED from firm memory. Links are the edges
 * back into the portfolio (properties / loans / deals / insurance) for drill-through.
 */
export const CounterpartyKind = z.enum([
  'lender',
  'carrier',
  'counsel',
  'title',
  'broker',
  'principal',
  'partner',
]);
export type CounterpartyKind = z.infer<typeof CounterpartyKind>;

export const CounterpartyLinks = z.object({
  properties: z.array(z.string()).default([]),
  loans: z.array(z.string()).default([]),
  deals: z.array(z.string()).default([]),
  insurance: z.array(z.string()).default([]),
});
export type CounterpartyLinks = z.infer<typeof CounterpartyLinks>;

export const Counterparty = z.object({
  id: z.string(),
  name: z.string(),
  kind: CounterpartyKind,
  firm: z.string().nullable(),
  role: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  market: z.string().nullable(),
  notes: z.string().nullable(),
  /** confirmed when grounded in workbook/memory; derived when inferred by matching. */
  source: z.enum(['workbook', 'memory']),
  links: CounterpartyLinks,
});
export type Counterparty = z.infer<typeof Counterparty>;
