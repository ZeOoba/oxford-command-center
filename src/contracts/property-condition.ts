// src/contracts/property-condition.ts
//
// Property Condition ledger — typed boundary for the PCA extraction register
// (docs/capital/2026-10-07-pca-capex-ledger-integration-plan.md; migration 035). These are CAPEX
// RESERVE / PRICE-BASIS facts, neither Spine A NOI nor Spine B ledger values — never aggregate them
// with either (CLAUDE.md §1).
//
// Basis discipline: consultant component costs are `basis: 'estimate'` only. Contractor prices live
// in PcaQuote and are never merged into the same aggregate.
import { z } from 'zod';

/** ISO date at year, month, or day grain — the register carries '2025-11' and '2016-10' as printed. */
export const PcaPartialDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'expected YYYY, YYYY-MM or YYYY-MM-DD');

export const PCA_USABILITY_CLASSES = ['current', 'draft', 'limited', 'stale', 'unknown'] as const;
export const PcaUsabilityClass = z.enum(PCA_USABILITY_CLASSES);
export type PcaUsabilityClass = z.infer<typeof PcaUsabilityClass>;

const nonNeg = z.number().finite().nonnegative().nullable();

export const PcaReport = z
  .object({
    reportId: z.string().min(1),
    propertyKey: z.string().min(1),
    propertyMasterId: z.string().min(1).nullable(),
    propertyLabel: z.string().min(1),
    location: z.string().nullable(),
    consultant: z.string().nullable(),
    client: z.string().nullable(),
    oraCommissioned: z.boolean().nullable(),
    purpose: z.string().nullable(),
    inspectionDate: PcaPartialDate.nullable(),
    reportDate: PcaPartialDate.nullable(),
    sf: nonNeg,
    buildings: z.number().int().nonnegative().nullable(),
    yearBuilt: z.string().nullable(),
    immediateUsd: nonNeg,
    shortTermUsd: nonNeg,
    reservesUninflUsd: nonNeg,
    reservesInflUsd: nonNeg,
    termYears: z.number().int().positive().nullable(),
    psfYrStated: z.number().finite().nullable(),
    usabilityRaw: z.string().nullable(),
    usabilityClass: PcaUsabilityClass,
    sourceFiles: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .strict();
export type PcaReport = z.infer<typeof PcaReport>;

export const PcaComponent = z
  .object({
    reportId: z.string().min(1),
    rowSeq: z.number().int().positive(),
    system: z.string().min(1),
    qty: z.number().finite().nullable(),
    uom: z.string().nullable(),
    unitCost: nonNeg,
    factor: z.string().nullable(),
    eul: z.number().int().positive().nullable(),
    age: z.number().int().nonnegative().nullable(),
    rul: z.number().int().nullable(),
    /** RUL as printed — a range like '1-2' has no single integer, so `rul` is null and this keeps it. */
    rulRaw: z.string().nullable(),
    totalUsd: nonNeg,
    timing: z.string().nullable(),
    basis: z.literal('estimate'),
    note: z.string().nullable(),
  })
  .strict();
export type PcaComponent = z.infer<typeof PcaComponent>;

export const PcaQuote = z
  .object({
    quoteKey: z.string().min(1),
    title: z.string().min(1),
    propertyKey: z.string().min(1),
    propertyMasterId: z.string().min(1).nullable(),
    propertyLabel: z.string().min(1),
    vendor: z.string().nullable(),
    recordType: z.string().nullable(),
    status: z.string().nullable(),
    trade: z.string().nullable(),
    docDate: PcaPartialDate.nullable(),
    quotedUsd: nonNeg,
    actualUsd: nonNeg,
    qty: z.number().finite().nullable(),
    uom: z.string().nullable(),
    scopeSummary: z.string().nullable(),
    sourceRef: z.string().nullable(),
    confidence: z.string().nullable(),
    verified: z.boolean(),
    fundingClass: z.string().nullable(),
    leaseRecovery: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .strict();
export type PcaQuote = z.infer<typeof PcaQuote>;

export const PcaAssetFact = z
  .object({
    propertyKey: z.string().min(1),
    propertyMasterId: z.string().min(1).nullable(),
    propertyLabel: z.string().min(1),
    component: z.string().min(1),
    installFact: z.string().nullable(),
    installYear: z.number().int().min(1900).max(2100).nullable(),
    warranty: z.string().nullable(),
    warrantyEndYear: z.number().int().min(1900).max(2100).nullable(),
    source: z.string().nullable(),
    flag: z.string().nullable(),
    rowSeq: z.number().int().positive(),
  })
  .strict();
export type PcaAssetFact = z.infer<typeof PcaAssetFact>;

export const PcaOpenItem = z
  .object({
    itemNo: z.number().int().positive(),
    severity: z.enum(['High', 'Med', 'Low', 'Info']),
    propertyText: z.string().nullable(),
    issue: z.string().min(1),
    actionNeeded: z.string().nullable(),
  })
  .strict();
export type PcaOpenItem = z.infer<typeof PcaOpenItem>;
