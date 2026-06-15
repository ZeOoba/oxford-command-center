/**
 * Cloudflare Pages Function — POST /api/warehouse/acquisition/score
 *
 * Mirrors the Brain Server's acquisition-score route (server/warehouse/api.ts) so the deployed,
 * Access-gated mirror can score acquisitions WITHOUT a live server. This is the one server-only
 * module that is genuinely edge-portable: scoreAcquisition() is a PURE function of (input, ruleset,
 * rct) with ZERO database dependency (its server route even sits outside the warehouse withDb guard).
 * Only the node:fs *loaders* are server-only, so here we BUNDLE the ratified config JSON instead of
 * reading the filesystem — the financial engine itself (server/warehouse/acquisition.ts) is reused
 * verbatim, unchanged.
 *
 * FAIL-CLOSED (financial-decision invariant, preserved from acquisition.ts): the ratified ruleset +
 * Replacement-Cost Table are parsed and asserted at MODULE INIT. If either is non-ratified, incomplete,
 * or missing provenance, every request returns 503 — a verdict is NEVER blessed on un-ratified config.
 * This matches the server route's `acqConfig()` 503 behaviour exactly.
 *
 * DEPLOY REQUIREMENT: acquisition.ts imports `node:crypto` (createHash) + `node:fs` at module top, so
 * this Function needs the `nodejs_compat` compatibility flag on the Pages project
 * (Cloudflare dashboard → Workers & Pages → ora-command-center → Settings → Functions → Compatibility
 * flags → add `nodejs_compat`; set a compatibility_date >= 2024-09-23). The bundler resolves the imports
 * under that flag; readFileSync is never called on this path (configs are bundled JSON). Verify after
 * deploy with `wrangler pages dev` or a real request before relying on it.
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

// Parse + assert the ratified config ONCE at module init (fail-closed). On any failure, cfgError is set
// and every request 503s — never a blessed verdict on un-ratified config.
let RULESET: AcquisitionRuleset | null = null;
let RCT: ReplacementCostTable | null = null;
let cfgError: string | null = null;
try {
  const r = parseRuleset(rulesetJson);
  assertProductionRuleset(r);
  const rct = ReplacementCostTable.parse(rctJson);
  assertProductionRct(rct);
  RULESET = r;
  RCT = rct;
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
  if (cfgError !== null || RULESET === null || RCT === null) {
    return json({ error: 'acquisition engine unavailable', detail: cfgError ?? 'config not loaded' }, 503);
  }
  const parsed = AcquisitionInput.safeParse(await context.request.json().catch(() => ({})));
  if (!parsed.success) {
    return json({ error: 'invalid acquisition input', issues: parsed.error.issues }, 400);
  }
  return json({ score: scoreAcquisition(parsed.data, RULESET, { rct: RCT }) });
}
