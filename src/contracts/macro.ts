import { z } from 'zod';

export const MacroSeriesPoint = z.object({ date: z.string(), value: z.number() });
export type MacroSeriesPoint = z.infer<typeof MacroSeriesPoint>;

export const MacroIndicator = z.object({
  id: z.string(),
  label: z.string(),
  // Finite-or-null. A single-series FRED outage (5xx or '.' missing observation on, e.g., DGS10
  // alone) must travel as null end-to-end — never as a 0 sentinel that the AI agent's refi-spread
  // narrative would quote as "10Y at 0.00%". `.finite()` rejects NaN / ±Infinity at the parse
  // boundary, mirroring the producer-side `Number.isFinite` filter in server/macro/fred.ts:22 and
  // closing the loophole that zod's bare `z.number()` would otherwise accept NaN. Consumers
  // (server/ai/agent.ts summarizeMacro, src/modules/market/MarketModule.tsx) handle null explicitly.
  value: z.number().finite().nullable(),
  unit: z.string(),
  change: z.number().nullable(), // change vs prior period
});
export type MacroIndicator = z.infer<typeof MacroIndicator>;

/** Macro snapshot. Source: FRED (when wired) — mock until then. */
export const MacroSnapshot = z.object({
  asOf: z.string(),
  // 'live-fred' = fetched live from FRED API; 'seed' = static seeded snapshot (no API key).
  // 'mock' and 'fred' are legacy aliases kept for backward compat with persisted payloads.
  source: z.enum(['mock', 'fred', 'live-fred', 'seed']),
  indicators: z.array(MacroIndicator),
  tenYearHistory: z.array(MacroSeriesPoint),
});
export type MacroSnapshot = z.infer<typeof MacroSnapshot>;
