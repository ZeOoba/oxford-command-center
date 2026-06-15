// tests/unit/acquisition-edge-function.test.ts
//
// Verifies the Cloudflare Pages Function (functions/api/warehouse/acquisition/score.ts) is a faithful
// mirror of the Brain Server's acquisition-score route: same ratified config, same engine, same response
// shape. Runs in Node (vitest) — node:crypto/fs + the bundled JSON import resolve here, so this proves
// the LOGIC + config parity. It does NOT exercise the workerd edge runtime (nodejs_compat) — that needs a
// real `wrangler pages dev`/deploy check, documented in the Function header.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { onRequestPost } from '../../functions/api/warehouse/acquisition/score';
import { AcquisitionInput, ReplacementCostTable } from '@contracts/acquisition';
import { parseRuleset, scoreAcquisition } from '../../server/warehouse/acquisition';

// A strong, fully-known PURSUE-grade deal (copied from acquisition.test.ts STRONG_BASE).
const STRONG_BASE: Record<string, unknown> = {
  dealId: 'strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005,
  sfhaOnPad: false,
  allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket',
  sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5,
  valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};

function postCtx(body: unknown): { request: Request } {
  return {
    request: new Request('https://mirror/api/warehouse/acquisition/score', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  };
}

// `scoredAt` is the engine's only wall-clock field — strip it before comparing two independent runs.
function stripScoredAt(s: Record<string, unknown>): Record<string, unknown> {
  return { ...s, scoredAt: undefined };
}

describe('acquisition edge Function — POST /api/warehouse/acquisition/score', () => {
  it('scores a valid deal identically to the server engine (same ratified config)', async () => {
    const res = await onRequestPost(postCtx(STRONG_BASE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score: Record<string, unknown> };

    // Independent server-path expectation using the SAME on-disk config the Function bundles.
    const ruleset = parseRuleset(
      JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
    );
    const rct = ReplacementCostTable.parse(
      JSON.parse(readFileSync(resolve(process.cwd(), 'config/replacement-cost.v1.json'), 'utf8')),
    );
    const expected = scoreAcquisition(AcquisitionInput.parse(STRONG_BASE), ruleset, { rct });

    expect(stripScoredAt(body.score)).toEqual(stripScoredAt(expected as unknown as Record<string, unknown>));
  });

  it('returns the same {score} envelope as the server route (has verdict + tier)', async () => {
    const res = await onRequestPost(postCtx(STRONG_BASE));
    const body = (await res.json()) as { score: Record<string, unknown> };
    expect(body.score).toHaveProperty('verdict');
    expect(body.score).toHaveProperty('tier');
  });

  it('rejects invalid input with 400 (not a blessed verdict)', async () => {
    const res = await onRequestPost(postCtx({ not: 'a deal' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid acquisition input/);
  });

  it('handles an empty body without throwing (400, fail-closed)', async () => {
    const res = await onRequestPost({
      request: new Request('https://mirror/api/warehouse/acquisition/score', { method: 'POST' }),
    });
    expect(res.status).toBe(400);
  });
});
