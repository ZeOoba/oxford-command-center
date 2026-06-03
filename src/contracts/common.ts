import { z } from 'zod';

/**
 * Shared primitives for every domain contract.
 * These are the versioned boundary between data sources and the UI — nothing
 * crosses into the app un-validated.
 */

export const SCHEMA_VERSION = '1.0.0' as const;

/** How much we trust a number. Operationalizes the prototype's `*` convention. */
export const Confidence = z.enum(['confirmed', 'estimated', 'derived']);
export type Confidence = z.infer<typeof Confidence>;

/** Where a value came from — clickable provenance in the UI. */
export const Provenance = z.object({
  source: z.string(), // e.g. "Master Workbook › Property NOI!N20"
  confidence: Confidence,
  asOf: z.string().optional(), // ISO date the value was true as-of
  formula: z.string().optional(), // derivation, when confidence === 'derived'
});
export type Provenance = z.infer<typeof Provenance>;

/** A number that carries its own lineage. Used for KPIs and derived analytics. */
export const Cell = z.object({
  value: z.number().nullable(),
  prov: Provenance,
});
export type Cell = z.infer<typeof Cell>;

export function cell(
  value: number | null,
  source: string,
  confidence: Confidence = 'confirmed',
  extra?: { asOf?: string; formula?: string },
): Cell {
  return { value, prov: { source, confidence, ...extra } };
}

/** Surfaced data-quality issue — bad source values are quarantined, never rendered raw. */
export const DataQualityFlag = z.object({
  entity: z.string(), // record id/name the issue belongs to
  field: z.string(),
  issue: z.string(),
  rawValue: z.string().optional(),
  severity: z.enum(['info', 'warn', 'error']).default('warn'),
});
export type DataQualityFlag = z.infer<typeof DataQualityFlag>;

export const Market = z.enum([
  'Columbus OH',
  'Mid-Atlantic',
  'Toledo OH',
  'Cleveland MSA',
  'Kansas City MO',
  'Indianapolis IN',
  'Other',
  'Unknown',
]);
export type Market = z.infer<typeof Market>;

export const PropertyType = z.enum(['Flex', 'Retail', 'Industrial', 'Residence', 'Other']);
export type PropertyType = z.infer<typeof PropertyType>;

/** ISO date string or null (bad/garbage source dates resolve to null + a flag). */
export const IsoDateNullable = z.string().nullable();

export const trend = z.enum(['up', 'down', 'flat']);
export type Trend = z.infer<typeof trend>;

/** Stable slug id from a human name (deterministic — safe across refreshes). */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}
