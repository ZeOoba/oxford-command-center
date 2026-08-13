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

/**
 * ORA markets. Two populations feed this: OWNED properties (assigned by inferMarket() from workbook
 * text) and PIPELINE deals (mapped from Notion's Market select by MARKET_MAP in
 * server/sources/notion-deals.ts).
 *
 * The bottom group was added 2026-08-12. The enum covered 6 markets while Notion's select offers 12,
 * so mapMarket collapsed everything else to 'Other' — and the live pipeline actually spans those
 * metros: 11 of 20 rows published market:'Other' to the mirror while their real metro was known and
 * recorded upstream. Adding a member is backward compatible for reading stored snapshots.
 *
 * NOT the same thing as being PRICED. src/brain/replacement-cost.ts's RCT_V03 covers only Columbus,
 * Kansas City, Indianapolis, and Mid-Atlantic; every other member (old and new) resolves
 * marketCovered:false and is not given a replacement-cost denominator. Naming a market here does not
 * invent a basis for it.
 */
export const Market = z.enum([
  'Columbus OH',
  'Mid-Atlantic',
  'Toledo OH',
  'Cleveland MSA',
  'Kansas City MO',
  'Indianapolis IN',
  // Live Notion pipeline metros, added 2026-08-12 (see above).
  'Cincinnati OH',
  'Madison WI',
  'Grand Rapids MI',
  'Des Moines IA',
  'Louisville KY',
  'Richmond VA',
  'Other',
  'Unknown',
]);
export type Market = z.infer<typeof Market>;

/**
 * The subset of Market that OWNED PROPERTIES can take — the codomain of inferMarket()
 * (server/workbook/parse.ts), plus 'Unknown'.
 *
 * The portfolio filter enumerates THIS rather than the whole enum. The markets added 2026-08-12 are
 * PIPELINE metros where ORA owns nothing, so listing them in a property filter offers options that
 * can only ever match zero rows. Deal markets and property markets are different populations that
 * happen to share a type.
 *
 * Keep in sync with inferMarket: a new branch there needs a member here, and
 * tests/unit/portfolio-filter.test.tsx pins that inferMarket never returns anything absent from
 * this list.
 */
export const PROPERTY_MARKETS: readonly Market[] = [
  'Columbus OH',
  'Mid-Atlantic',
  'Toledo OH',
  'Cleveland MSA',
  'Kansas City MO',
  'Indianapolis IN',
  'Other',
  'Unknown',
];

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
