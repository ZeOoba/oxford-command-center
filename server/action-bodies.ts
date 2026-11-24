// server/action-bodies.ts
//
// Request-body schemas for the server/index.ts write routes that used to cast their body
// (`as { ... }`) instead of validating it (2026-11-23 review, Tier 4). The cast let a non-string
// `type` / `dueDay` / `notes` reach data/overlay.json, which is not re-parsed through Zod on read
// (an off-shape record can then be silently dropped downstream). Types only: no length caps are
// invented here. null is accepted wherever the old route quietly defaulted it (refute
// wf_92c09816-8c3), so no payload the old route accepted with a sensible meaning is now rejected.
// The routes call `Schema.safeParse(...)` directly, the same shape as their sibling routes, so
// scripts/check-write-schema-drift.ts can see the schema.
import { z } from 'zod';
import { DealStage } from '../src/contracts/index';

const nonEmpty = z.string().trim().min(1);

export const DealStageBody = z.object({ dealId: nonEmpty, stage: DealStage });

export const TaskBody = z.object({
  label: nonEmpty,
  section: z.string().nullish(),
  type: z.string().nullish(),
  dueDay: z.string().nullish(),
  notes: z.string().nullish(),
});

/** A null or missing note clears it, as before. */
export const TenantNoteBody = z.object({
  tenantId: nonEmpty,
  note: z.string().nullish().transform((v) => v ?? ''),
});
