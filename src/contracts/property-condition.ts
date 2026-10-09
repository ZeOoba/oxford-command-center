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

export const PcaCalibrationPair = z
  .object({
    rowSeq: z.number().int().positive(),
    propertyKey: z.string().min(1),
    propertyMasterId: z.string().min(1).nullable(),
    propertyLabel: z.string().min(1),
    scope: z.string().min(1),
    estimateSource: z.string().nullable(),
    estimateUsd: nonNeg,
    estimatePsf: nonNeg,
    contractorSource: z.string().nullable(),
    contractorUsd: nonNeg,
    contractorPsf: nonNeg,
    comment: z.string().nullable(),
  })
  .strict();
export type PcaCalibrationPair = z.infer<typeof PcaCalibrationPair>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Read model — GET /api/warehouse/property-condition/report (server/warehouse/property-condition.ts)
//
// "Current" for a property is the MOST RECENT report we have for it (Gabriel, 2026-10-07 — no age
// cutoff). Age and usabilityClass are carried as caveats, never as exclusions.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const PcaReportBrief = z
  .object({
    reportId: z.string().min(1),
    reportDate: PcaPartialDate.nullable(),
    consultant: z.string().nullable(),
    usabilityClass: PcaUsabilityClass,
    usabilityRaw: z.string().nullable(),
    sf: nonNeg,
    immediateUsd: nonNeg,
    shortTermUsd: nonNeg,
    reservesUninflUsd: nonNeg,
    reservesInflUsd: nonNeg,
    termYears: z.number().int().positive().nullable(),
    psfYrStated: z.number().finite().nullable(),
    notes: z.string().nullable(),
  })
  .strict();
export type PcaReportBrief = z.infer<typeof PcaReportBrief>;

export const PcaPropertySummary = z
  .object({
    propertyKey: z.string().min(1),
    propertyLabel: z.string().min(1),
    propertyMasterId: z.string().min(1).nullable(),
    current: PcaReportBrief,
    /** Older reports for the same property, newest first. Kept as history, never summed. */
    history: z.array(PcaReportBrief),
    /** Whole years between the current report's year and the as-of year; null when undated. */
    ageYears: z.number().int().nonnegative().nullable(),
    /** reservesUninfl ÷ sf ÷ term — derived; null unless all three are present. */
    reservesPsfYr: z.number().finite().nullable(),
    /** False for narrative-only / letter reports with no dollar figure at all. */
    hasDollarFigures: z.boolean(),
  })
  .strict();
export type PcaPropertySummary = z.infer<typeof PcaPropertySummary>;

export const PCA_WARRANTY_STATUSES = ['expired', 'ends-this-year', 'expiring', 'active', 'unknown'] as const;
export const PcaWarrantyStatus = z.enum(PCA_WARRANTY_STATUSES);
export type PcaWarrantyStatus = z.infer<typeof PcaWarrantyStatus>;

export const PcaScheduleRow = z
  .object({
    propertyKey: z.string().min(1),
    propertyLabel: z.string().min(1),
    component: z.string().min(1),
    installFact: z.string().nullable(),
    installYear: z.number().int().nullable(),
    ageYears: z.number().int().nonnegative().nullable(),
    warranty: z.string().nullable(),
    warrantyEndYear: z.number().int().nullable(),
    warrantyStatus: PcaWarrantyStatus,
    flag: z.string().nullable(),
  })
  .strict();
export type PcaScheduleRow = z.infer<typeof PcaScheduleRow>;

/** A line from a property's CURRENT report: consultant-estimated life, with a derived due year. */
export const PcaLifecycleRow = z
  .object({
    propertyKey: z.string().min(1),
    propertyLabel: z.string().min(1),
    reportId: z.string().min(1),
    reportDate: PcaPartialDate.nullable(),
    system: z.string().min(1),
    eul: z.number().int().nullable(),
    age: z.number().int().nullable(),
    rulRaw: z.string().nullable(),
    /** reportYear + integer RUL — derived, null when RUL is a range, absent, or the report is undated. */
    dueYear: z.number().int().nullable(),
    totalUsd: nonNeg,
    timing: z.string().nullable(),
    basis: z.literal('estimate'),
  })
  .strict();
export type PcaLifecycleRow = z.infer<typeof PcaLifecycleRow>;

export const PcaCalibrationRow = z
  .object({
    propertyKey: z.string().min(1),
    propertyLabel: z.string().min(1),
    scope: z.string().min(1),
    estimateSource: z.string().nullable(),
    estimateUsd: nonNeg,
    estimatePsf: nonNeg,
    contractorSource: z.string().nullable(),
    contractorUsd: nonNeg,
    contractorPsf: nonNeg,
    /** contractor ÷ estimate − 1. Dollars when both are present, else $/SF; null when neither pair exists. */
    deltaPct: z.number().finite().nullable(),
    deltaBasis: z.enum(['usd', 'psf']).nullable(),
    comment: z.string().nullable(),
  })
  .strict();
export type PcaCalibrationRow = z.infer<typeof PcaCalibrationRow>;

export const PCA_EVIDENCE_CLASSES = ['executed', 'quoted', 'budget', 'superseded'] as const;
export const PcaEvidenceClass = z.enum(PCA_EVIDENCE_CLASSES);
export type PcaEvidenceClass = z.infer<typeof PcaEvidenceClass>;

export const PcaQuoteRow = z
  .object({
    quoteKey: z.string().min(1),
    title: z.string().min(1),
    propertyKey: z.string().min(1),
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
    /** (actual ?? quoted) ÷ qty, SF-basis rows only — derived, never a benchmark aggregate (n=1 per scope). */
    unitPriceUsdPsf: z.number().finite().nullable(),
    /** executed = awarded/completed/contract; quoted = live bid; budget = estimate-type record; superseded. */
    evidenceClass: PcaEvidenceClass,
    scopeSummary: z.string().nullable(),
    confidence: z.string().nullable(),
    verified: z.boolean(),
    fundingClass: z.string().nullable(),
    leaseRecovery: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .strict();
export type PcaQuoteRow = z.infer<typeof PcaQuoteRow>;

/** Consultant ESTIMATE unit costs — never merged with PcaQuoteRow (contractor) prices. */
export const PcaPriceBookRow = z
  .object({
    reportId: z.string().min(1),
    propertyKey: z.string().min(1),
    propertyLabel: z.string().min(1),
    reportYear: z.number().int().nullable(),
    system: z.string().min(1),
    uom: z.string().nullable(),
    unitCost: z.number().finite().nonnegative(),
    basis: z.literal('estimate'),
  })
  .strict();
export type PcaPriceBookRow = z.infer<typeof PcaPriceBookRow>;

export const PropertyConditionReport = z
  .object({
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** False when pca_reports is empty — the importer has not been run. */
    loaded: z.boolean(),
    properties: z.array(PcaPropertySummary),
    totals: z
      .object({
        propertiesTotal: z.number().int().nonnegative(),
        propertiesWithFigures: z.number().int().nonnegative(),
        immediateUsd: z.number().finite().nonnegative(),
        shortTermUsd: z.number().finite().nonnegative(),
        reservesUninflUsd: z.number().finite().nonnegative(),
      })
      .strict(),
    schedule: z.array(PcaScheduleRow),
    lifecycle: z.array(PcaLifecycleRow),
    calibration: z.array(PcaCalibrationRow),
    quotes: z.array(PcaQuoteRow),
    priceBook: z.array(PcaPriceBookRow),
    openItems: z.array(PcaOpenItem),
  })
  .strict();
export type PropertyConditionReport = z.infer<typeof PropertyConditionReport>;
