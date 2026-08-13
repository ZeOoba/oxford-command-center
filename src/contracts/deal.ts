import { z } from 'zod';
import { IsoDateNullable, Market } from './common';

export const DealStage = z.enum([
  'Sourcing',
  'Candidate',
  'LOI/PSA',
  'Due Diligence',
  'Closing',
  'Refinance',
  'Closed',
  'Dead',
]);
export type DealStage = z.infer<typeof DealStage>;

/**
 * An acquisition / refinance in the pipeline. Seeded from the prototype + memory;
 * live source later = HubSpot + Notion Acquisition Pipeline Tracker.
 */
export const Deal = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string().nullable(),
  location: z.string().nullable(),
  market: Market.nullable(),
  sf: z.number().nullable(),
  buildings: z.number().int().nullable(),
  stage: DealStage,
  estPrice: z.number().nullable(),
  capRate: z.number().nullable(),
  irr: z.number().nullable(),
  equityMultiple: z.number().nullable(),
  holdYrs: z.number().nullable(),
  lender: z.string().nullable(),
  status: z.string().nullable(),
  nextAction: z.string().nullable(),
  owner: z.string().nullable(),
  targetCloseDate: IsoDateNullable, // Notion "Target Close Date"; drives LOI/PSA-deadline alert
  /**
   * The seed↔Notion join key: Notion's native Unique ID on the Acquisition Pipeline Tracker
   * ("Deal ID", rendered "<prefix>-<number>"). Opaque and READ-ONLY at the source — Notion assigns
   * it and no rename, locality suffix, alias, or punctuation variant can perturb it.
   *
   * This replaced a normalized-NAME join on 2026-08-12. Names are not identity: Notion's
   * "<Name> — <City>, <ST>" convention exists precisely because bare street names repeat across
   * metros, so any key that normalized the tail away deleted its own disambiguator. Four adversarial
   * passes over 2026-08-11/12 found a CRITICAL cross-side wrong merge and three further defects in
   * the guards written to contain it. See docs/superpowers/plans/2026-08-12-deal-id-join.md.
   *
   * `null` means UNJOINABLE, never "fall back to matching on the name".
   */
  notionDealId: z.string().nullable().default(null),
  confidential: z.boolean().default(false),
  /** Field names whose values are estimates (drives dotted provenance underline). */
  estimatedFields: z.array(z.string()).default([]),
});
export type Deal = z.infer<typeof Deal>;
