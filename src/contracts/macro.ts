import { z } from 'zod';

export const MacroSeriesPoint = z.object({ date: z.string(), value: z.number() });
export type MacroSeriesPoint = z.infer<typeof MacroSeriesPoint>;

export const MacroIndicator = z.object({
  id: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.string(),
  change: z.number().nullable(), // change vs prior period
});
export type MacroIndicator = z.infer<typeof MacroIndicator>;

/** Macro snapshot. Source: FRED (when wired) — mock until then. */
export const MacroSnapshot = z.object({
  asOf: z.string(),
  source: z.enum(['mock', 'fred']),
  indicators: z.array(MacroIndicator),
  tenYearHistory: z.array(MacroSeriesPoint),
});
export type MacroSnapshot = z.infer<typeof MacroSnapshot>;
