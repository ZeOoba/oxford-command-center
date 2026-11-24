// server/warehouse/noi-acknowledgments.ts — ratified, dated per-property acknowledgments of a KNOWN
// Spine A (workbook) / Spine B (warehouse) NOI drift (audit R34-3, ruled 2026-11-23).
//
// Why a list, not inference: the R34-3 drift is a lease that ENDED after the warehouse comparison
// year; the roster zeroes an expired lease's rent, so the lost rent has to be estimated. Five REFUTE
// rounds on an estimating rung each found a medium edge (re-lets, holdovers, duplicates, stale rows,
// mid-year acquisitions). Gabriel ruled to replace inference with an explicit acknowledgment he
// ratifies per property, kept in the repo (config/ is refute-gated) with no dollar figures.
//
// An acknowledgment downgrades a large-drift ERROR to a structural-mismatch WARN only when ALL hold
// (enforced in reconcile-noi.ts classifyNoiReconciliation): same property, same comparison period,
// the listed direction, |delta|/max <= maxDeltaPct, as-of date strictly before `expires`, workbook
// NOI > 0 and no sign conflict. A missing file means no acknowledgments (never a downgrade); a
// malformed file throws, so the gate stage fails loudly instead of silently loosening.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const NOI_ACKNOWLEDGMENTS_PATH = join(process.cwd(), 'config', 'noi-crosscheck-acknowledgments.json');

const IsoDay = z.string().refine((s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}, 'must be a real YYYY-MM-DD date');

export const NoiDriftAcknowledgment = z.object({
  propertyId: z.string().min(1),
  /** The warehouse full-year comparison period this acknowledgment covers (e.g. "2025"). A new
   *  full-year ingest moves the comparison period and ends the acknowledgment automatically. */
  comparisonPeriod: z.string().regex(/^\d{4}$/),
  /** Only the move-out direction is supported: the warehouse actuals exceed the workbook NOI. */
  direction: z.literal('warehouse-exceeds-workbook'),
  /** Ceiling on |delta| / max(|wb|, |wh|); a larger gap still errors (a new break is not masked). */
  maxDeltaPct: z.number().gt(0).lte(1),
  /** Applies while the as-of date is strictly BEFORE this date. */
  expires: IsoDay,
  ratifiedBy: z.string().min(1),
  ratifiedOn: IsoDay,
  reason: z.string().min(1),
}).strict().refine((a) => a.expires > a.ratifiedOn, { message: 'expires must be after ratifiedOn' });
export type NoiDriftAcknowledgment = z.infer<typeof NoiDriftAcknowledgment>;

const AcknowledgmentFile = z.object({
  version: z.literal(1),
  acknowledgments: z.array(NoiDriftAcknowledgment),
}).strict();

/** Load and validate the acknowledgment list. Missing file -> []. Malformed or duplicate -> throws. */
export function loadNoiAcknowledgments(path: string = NOI_ACKNOWLEDGMENTS_PATH): NoiDriftAcknowledgment[] {
  if (!existsSync(path)) return [];
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = AcknowledgmentFile.parse(raw);
  const seen = new Set<string>();
  for (const a of parsed.acknowledgments) {
    if (seen.has(a.propertyId)) throw new Error(`noi-acknowledgments: duplicate entry for ${a.propertyId}`);
    seen.add(a.propertyId);
  }
  return parsed.acknowledgments;
}

/** True when a valid YYYY-MM-DD as-of date is strictly before the acknowledgment's expiry. */
export function acknowledgmentInForce(ack: NoiDriftAcknowledgment, asOfDate: string | null | undefined): boolean {
  if (typeof asOfDate !== 'string' || !IsoDay.safeParse(asOfDate).success) return false;
  return asOfDate < ack.expires;
}
