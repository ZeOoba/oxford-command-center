// src/contracts/notion-writeback.ts
//
// Direction 1 — Notion Writeback contract.
// Zod schema for the POST /api/warehouse/capital-allocation/sync-notion response.
//
// The capital allocation engine produces per-property capitalAction + priorityScore.
// This writeback pushes those decisions back to the Notion 🏢 Property Register so they
// surface in the operational workflow. The route is FAIL-OPEN: it never throws on
// per-property mismatch or a single page write failure — it tallies and returns.
//
//   synced  — properties matched to a Notion page AND written successfully
//   skipped — properties with no matching Notion page (logged, not an error)
//   errors  — per-page write failures (Notion API non-2xx, timeout, etc.); strings only
//   asOf    — the snapshot asOf the synced decisions were computed from
import { z } from 'zod';

export const NotionSyncResult = z.object({
  synced: z.number().int().min(0),
  skipped: z.number().int().min(0),
  errors: z.array(z.string()),
  asOf: z.string(),
});
export type NotionSyncResult = z.infer<typeof NotionSyncResult>;
