// src/contracts/warehouse.ts
import { z } from 'zod';

export const Classification = z.enum([
  'revenue', 'recovery', 'other-income', 'opex',
  'capex', 'ti', 'leasing', 'debt-service', 'excluded',
]);
export type Classification = z.infer<typeof Classification>;

/** Classes whose active ledger rows participate in NOI: revenue + recovery + other-income − opex. */
export const NOI_CLASSES = ['revenue', 'recovery', 'other-income', 'opex'] as const;

export const Basis = z.enum(['cash', 'accrual', 'tax', 'unknown']);
export const SourceSystem = z.enum(['quickbooks', 'yardi', 'rent-manager', 'appfolio', 'unknown']);
export const PeriodGrain = z.enum(['month', 'year', 'ytd']);
export const ImportStatus = z.enum(['pending-review', 'committed', 'superseded', 'rejected']);
export const FinancialMode = z.enum(['pnl', 'lease-run']);

export const PropertyMasterRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  market: z.string().nullish(),
  address: z.string().nullish(),
  propertyManager: z.string().nullish(),
  pmContact: z.string().nullish(),
  pmPlatform: z.string().nullish(),
  financialMode: FinancialMode.default('pnl'),
  rentableSf: z.number().nonnegative().finite().nullish(),
  acquisitionDate: z.string().nullish(),
  ownershipPct: z.number().gt(0).max(1).default(1),
  ownershipStatus: z.string().default('active'),
  assetClass: z.string().nullish(),
  notes: z.string().nullish(),
});
export type PropertyMasterRow = z.infer<typeof PropertyMasterRowSchema>;

export const RawAccountLineSchema = z.object({
  code: z.string().nullish(),
  name: z.string().min(1),
  section: z.string().min(1),
  parent: z.string().nullish(),
  total: z.number().finite().nullable(),
});
export type RawAccountLine = z.infer<typeof RawAccountLineSchema>;

export const RawStatementSchema = z.object({
  propertyRaw: z.string(),
  periodLabel: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  grain: PeriodGrain,
  basis: Basis,
  sourceSystem: SourceSystem,
  accounts: z.array(RawAccountLineSchema),
  totalIncome: z.number().finite().nullable(),
  totalExpense: z.number().finite().nullable(),
  // Per-section foot scope: each statement section with the leaf total accumulated
  // while the section was OPEN (accumulation closes at the section's top-level Total
  // row) and the report-stated total captured from that row (null = never stated).
  sections: z.array(z.object({
    name: z.string().min(1),
    leafSum: z.number().finite(),
    statedTotal: z.number().finite().nullable(),
  })).default([]),
});
export type RawStatement = z.infer<typeof RawStatementSchema>;

export const LedgerEntrySchema = z.object({
  importId: z.number().int(),
  propertyId: z.string().min(1),
  period: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
  rawAccount: z.string().min(1),
  glCode: z.string().nullish(),
  amount: z.number().finite(),
  normalizedCategory: z.string().min(1),
  classification: Classification,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const AccountMappingSchema = z.object({
  account: z.string().min(1),
  code: z.string().nullish(),
  normalized_category: z.string().min(1),
  classification: Classification,
  confidence: z.string().optional(),
  note: z.string().nullish(),
});
export type AccountMapping = z.infer<typeof AccountMappingSchema>;
