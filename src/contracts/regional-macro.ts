// src/contracts/regional-macro.ts
//
// Scope B — Regional Market Dynamics contracts.
//
// State-level unemployment for ORA's 7 markets (OH/MD/IN/WI/MO/KS/TN). This is the first
// sub-national economic signal in the capital-allocation layer: a tightening or loosening
// labor base is a leading indicator of industrial demand. DISPLAY-ONLY — these figures do
// NOT feed the priority score or capitalAction (mirrors the MacroContext / market-benchmark
// overlays, which are also diagnostic-only).
//
// Provenance is per-state: source:'fred' when that state's series was fetched live;
// source:'mock' when FRED was unavailable, the key was absent, or that single series 404'd.
// unemploymentRate is nullable end-to-end — a missing observation passes through as null,
// never a 0-lie (the same defect cured at server/macro/fred.ts).
import { z } from 'zod';

/**
 * One ORA-market state's labor signal.
 * stateCode is the 2-letter USPS code; unemploymentRate is the seasonally-adjusted monthly
 * rate as a percent (e.g. 4.1 = 4.1%), nullable when unavailable.
 */
export const StateEmploymentMetric = z.object({
  stateCode: z.string().length(2),
  stateName: z.string(),
  unemploymentRate: z.number().nullable(),
  source: z.enum(['fred', 'mock']),
  asOf: z.string().nullable(),
});
export type StateEmploymentMetric = z.infer<typeof StateEmploymentMetric>;

/**
 * Regional snapshot: one StateEmploymentMetric per ORA market state.
 * source is the snapshot-level provenance ('fred' when at least one state was live, else 'mock');
 * asOf is the latest observation date across the live states, or null when all states are mock.
 */
export const RegionalMacroSnapshot = z.object({
  asOf: z.string().nullable(),
  source: z.enum(['fred', 'mock']),
  states: z.array(StateEmploymentMetric),
});
export type RegionalMacroSnapshot = z.infer<typeof RegionalMacroSnapshot>;
