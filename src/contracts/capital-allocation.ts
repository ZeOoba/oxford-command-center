// src/contracts/capital-allocation.ts
// Phase 5 — Capital Allocation Capstone contracts.
// Single-sourced Zod schemas for the GET /api/warehouse/capital-allocation response.
// Every field carries explicit spine tagging: noiBasis:'spine-a' (ownership layer, NOT the
// Spine-B warehouse ledger). This contract is the H6 read boundary for capital-allocation routes.
import { z } from 'zod';
import { CapitalAction } from './warehouse';
import { CapRatePercentile } from './market-intelligence';
import { RegionalMacroSnapshot } from './regional-macro';

/**
 * Per-property synthesis row.
 *
 * Identity + size from Spine A snapshot; health/attention/capitalAction from scores.ts;
 * leasing signals from lease-forecast.ts; debt signals from debt-scoring.ts.
 * noiBasis is always 'spine-a' — this is the ownership capital-allocation layer,
 * not the Spine-B analytics layer. Never mix with warehouse-ledger NOI.
 */
export const CapitalAllocationEntry = z.object({
  propertyId: z.string(),
  propertyName: z.string().nullable(),
  market: z.string().nullable(),
  sf: z.number(),
  capitalAction: CapitalAction,
  priorityScore: z.number().min(0).max(100),
  healthScore: z.number().nullable(),
  attentionScore: z.number().nullable(),
  nearTermExpiryRent: z.number(),
  atRiskLikelihoodCount: z.number(),
  debtScore: z.number().min(0).max(100).nullable(),
  balloonMonths: z.number().nullable(),
  dscr: z.number().nullable(),
  rationale: z.array(z.string()).max(3),
  noi: z.number(),
  noiPerSf: z.number().nullable(),
  noiBasis: z.literal('spine-a'),

  // ── Market Intelligence overlay (Phase 5 Track 3) — DIAGNOSTIC ONLY ──────────────────────
  // These three fields position the property's in-place economics against external market
  // cap-rate benchmarks. They are display-layer diagnostics: they DO NOT feed priorityScore,
  // capitalAction, or any ranking. All null when the benchmark provider is unavailable, the
  // property has no positive value, or its market+type has no benchmark band (fail-open).
  //
  // impliedCapRate = Spine-A NOI / workbook value (decimal fraction). Same Spine-A NOI as `noi`
  // above — see basis label. capRateGap = impliedCapRate − market p50 (positive = higher yield /
  // cheaper than market median). capRatePercentile = discrete band vs market (bottom/median/top).
  impliedCapRate: z.number().nullable(),
  capRateGap: z.number().nullable(),
  capRatePercentile: CapRatePercentile.nullable(),
});
export type CapitalAllocationEntry = z.infer<typeof CapitalAllocationEntry>;

/**
 * FRED macro snapshot subset.
 * source:'fred' when live data was fetched; 'mock' when FRED was unavailable or key absent.
 */
export const MacroContext = z.object({
  tenYearRate: z.number().nullable(),
  cpi: z.number().nullable(),
  source: z.enum(['fred', 'mock']),
  asOf: z.string().nullable(),
});
export type MacroContext = z.infer<typeof MacroContext>;

/**
 * Top-level capital allocation report envelope.
 * entries are sorted DESC by priorityScore.
 * portfolioNoBasis is always 'spine-a' — asserted at the H6 boundary so callers never need to guess.
 */
export const CapitalAllocationReport = z.object({
  asOf: z.string(),
  propertyCount: z.number(),
  entries: z.array(CapitalAllocationEntry),
  portfolioNoi: z.number(),
  portfolioNoBasis: z.literal('spine-a'),
  investCount: z.number(),
  holdCount: z.number(),
  monitorCount: z.number(),
  dispositionCount: z.number(),
  macro: MacroContext,
  /**
   * Market cap-rate benchmark provenance (Phase 5 Track 3). source:'unavailable' + available:false
   * is the fail-open state — the UI then renders all per-entry cap-rate columns as '—'.
   * The full per-market bands are NOT echoed here (the UI only needs the source/asOf badge);
   * each entry already carries its classified band in capRatePercentile.
   */
  marketBenchmarks: z.object({
    available: z.boolean(),
    source: z.enum(['fred', 'seed', 'unavailable']),
    asOf: z.string().nullable(),
  }),
  /**
   * Regional market dynamics (Scope B) — state-level unemployment for ORA's 7 markets.
   * DIAGNOSTIC / DISPLAY-ONLY: a labor-tightening/loosening context signal that does NOT
   * feed priorityScore or capitalAction. null is the fail-open state (provider unreachable);
   * the UI then omits the regional row. Per-state provenance lives inside the snapshot.
   */
  regionalMacro: RegionalMacroSnapshot.nullable(),
});
export type CapitalAllocationReport = z.infer<typeof CapitalAllocationReport>;
