/**
 * Cloudflare Pages Function — POST /api/warehouse/acquisition/score
 *
 * Mirrors the Brain Server's acquisition-score route (server/warehouse/api.ts) so the deployed,
 * Access-gated mirror can score acquisitions WITHOUT a live server. This is the one server-only
 * module that is genuinely edge-portable: scoreAcquisition() is a PURE function of (input, ruleset,
 * rct) with ZERO database dependency (its server route even sits outside the warehouse withDb guard).
 * Only the node:fs *loaders* are server-only, so here we BUNDLE the ratified config JSON instead of
 * reading the filesystem — the financial engine (server/warehouse/acquisition.ts) is reused verbatim.
 *
 * FAIL-CLOSED (financial-decision invariant, preserved from acquisition.ts): the ratified ruleset +
 * Replacement-Cost Table are parsed and asserted at MODULE INIT via resolveAcquisitionConfig(). If
 * either is non-ratified, incomplete, or missing provenance, every request returns 503 — a verdict is
 * NEVER blessed on un-ratified config (matches the server route's acqConfig() 503 behaviour). The gate
 * logic is exported so a unit test can assert it directly (see acquisition-edge-function.test.ts).
 *
 * DEPLOY REQUIREMENT (Gabriel, before this endpoint works): the Pages project needs the `nodejs_compat`
 * compatibility flag AND `compatibility_date >= 2025-09-01` — acquisition.ts imports node:crypto
 * (createHash, used by computeInputsVersion, on the hot path) and node:fs at module top; node:fs is only
 * available under nodejs_compat from that date (Cloudflare docs). Set both in the dashboard
 * (Workers & Pages → ora-command-center → Settings → Functions → Compatibility flags/date) — or, better,
 * commit them in a wrangler.toml when you next touch the deploy. Then verify a real request returns a
 * score (`wrangler pages dev` or curl). I (autonomous) cannot deploy (invariant 2), so this is unverified
 * on the edge runtime. FOLLOW-UP (cleaner): factor the node:fs loaders out of acquisition.ts into a
 * server-only acquisition-loaders.ts so the edge bundle never imports node:fs at all (drops the date req).
 */
import rulesetJson from '../../../../config/acquisition-ruleset.v1.json';
import rctJson from '../../../../config/replacement-cost.v1.json';
import {
  parseRuleset,
  assertProductionRuleset,
  assertProductionRct,
  scoreAcquisition,
} from '../../../../server/warehouse/acquisition';
import { AcquisitionInput, ReplacementCostTable } from '../../../../src/contracts/acquisition';
import type { AcquisitionRuleset } from '../../../../src/contracts/acquisition';

export interface EdgeAcquisitionConfig {
  ruleset: AcquisitionRuleset;
  rct: ReplacementCostTable;
}

/**
 * Parse + assert the ratified production config. THROWS (fail-closed) on a non-ratified, incomplete, or
 * unsigned ruleset or RCT — exactly the four guards in server/warehouse/acquisition.ts
 * (assertProductionRuleset + assertProductionRct). Exported so the gate is unit-testable directly.
 */
export function resolveAcquisitionConfig(rulesetRaw: unknown, rctRaw: unknown): EdgeAcquisitionConfig {
  const ruleset = parseRuleset(rulesetRaw);
  assertProductionRuleset(ruleset);
  const rct = ReplacementCostTable.parse(rctRaw);
  assertProductionRct(rct);
  return { ruleset, rct };
}

// Resolve the bundled config ONCE at module init. On any failure, cfgError is set and every request 503s.
let CFG: EdgeAcquisitionConfig | null = null;
let cfgError: string | null = null;
try {
  CFG = resolveAcquisitionConfig(rulesetJson, rctJson);
} catch (e) {
  cfgError = e instanceof Error ? e.message : String(e);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context: { request: Request }): Promise<Response> {
  if (cfgError !== null || CFG === null) {
    return json({ error: 'acquisition engine unavailable', detail: cfgError ?? 'config not loaded' }, 503);
  }
  const parsed = AcquisitionInput.safeParse(await context.request.json().catch(() => ({})));
  if (!parsed.success) {
    return json({ error: 'invalid acquisition input', issues: parsed.error.issues }, 400);
  }
  return json({ score: scoreAcquisition(parsed.data, CFG.ruleset, { rct: CFG.rct }) });
}
