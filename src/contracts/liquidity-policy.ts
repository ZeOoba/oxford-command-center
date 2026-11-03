/**
 * Ratified liquidity policy — the ONE import path for config/liquidity-policy.v1.json (mirrors the
 * governor single-source discipline in ./governor-constants; plan:
 * docs/superpowers/plans/2026-09-18-capital-deployable-capacity.md step 1). Runtime-agnostic, so the
 * client bundle and the Brain Server read the same parsed object. Fail-closed: a malformed or
 * missing field throws at import rather than silently running on a default.
 *
 * Today it carries one value, the firm cash floor ($1.5M above all property-level reserves, ratified
 * by Gabriel 2026-09-18; added as code with his in-turn Invariant-4 approval 2026-11-02). Kept OUT
 * of RATIFIED_GOVERNORS: it is not part of the capital_config GovernorSet / DB CHECK pair, so it
 * cannot move any DSCR/LTV boundary. NEVER change a value without Gabriel's permission.
 */
import { z } from 'zod';
import raw from '../../config/liquidity-policy.v1.json';

export const LiquidityPolicy = z
  .object({
    version: z.literal(1),
    ratifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ratifiedBy: z.string().min(1),
    /** Firm cash floor (USD), held above all property-level reserves. */
    firmCashFloorUsd: z.number().finite().positive(),
    notes: z.string().optional(),
  })
  .strict();
export type LiquidityPolicy = z.infer<typeof LiquidityPolicy>;

/** Parse a liquidity-policy document or throw — never returns a partial/defaulted policy. */
export function assertLiquidityPolicy(input: unknown): LiquidityPolicy {
  const r = LiquidityPolicy.safeParse(input);
  if (!r.success) throw new Error(`config/liquidity-policy.v1.json is invalid (fail closed): ${r.error.message}`);
  return r.data;
}

export const LIQUIDITY_POLICY: LiquidityPolicy = assertLiquidityPolicy(raw);
