import { z } from 'zod';

/** Lease renewal pipeline stages, in advance order. "Expiring" is the implicit default. */
export const RenewalStage = z.enum(['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed']);
export type RenewalStage = z.infer<typeof RenewalStage>;

export const RENEWAL_STAGES: RenewalStage[] = ['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed'];

export function nextRenewalStage(stage: RenewalStage): RenewalStage | null {
  const i = RENEWAL_STAGES.indexOf(stage);
  if (i < 0 || i >= RENEWAL_STAGES.length - 1) return null;
  return RENEWAL_STAGES[i + 1]!;
}

/** POST /api/actions/renewal-stage body. */
export const RenewalStageInput = z.object({
  leaseId: z.string().min(1),
  stage: RenewalStage,
});
export type RenewalStageInput = z.infer<typeof RenewalStageInput>;
