import { z } from 'zod';
import { Market } from './common';

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
  confidential: z.boolean().default(false),
  /** Field names whose values are estimates (drives dotted provenance underline). */
  estimatedFields: z.array(z.string()).default([]),
});
export type Deal = z.infer<typeof Deal>;
