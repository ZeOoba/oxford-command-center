// src/contracts/capital-allocation.ts
// Phase 5 — Capital Allocation Capstone contracts.
// Single-sourced Zod schemas for the GET /api/warehouse/capital-allocation response.
// Every field carries explicit spine tagging: noiBasis:'spine-a' (ownership layer, NOT the
// Spine-B warehouse ledger). This contract is the H6 read boundary for capital-allocation routes.
import { z } from 'zod';
import { CapitalAction } from './warehouse';

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
});
export type CapitalAllocationReport = z.infer<typeof CapitalAllocationReport>;
