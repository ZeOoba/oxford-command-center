import { z } from 'zod';

export const ScenarioName = z.enum(['Base', 'Upside', 'Downside']);
export type ScenarioName = z.infer<typeof ScenarioName>;

/** Scenario engine + alert thresholds. Source: master workbook `Assumptions`. */
export const Assumptions = z.object({
  activeScenario: ScenarioName,
  revenueFactor: z.number(),
  vacancyFactor: z.number(),
  exitCapFactor: z.number(),
  thresholds: z.object({
    balloonAlertMonths: z.number(), // 18
    concentrationYellow: z.number(), // 0.25
    concentrationRed: z.number(), // 0.50
  }),
  asOf: z.string(),
});
export type Assumptions = z.infer<typeof Assumptions>;

export const SCENARIO_PRESETS: Record<
  ScenarioName,
  { revenueFactor: number; vacancyFactor: number; exitCapFactor: number }
> = {
  Base: { revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1 },
  Upside: { revenueFactor: 1.1, vacancyFactor: 0.95, exitCapFactor: 0.95 },
  Downside: { revenueFactor: 0.9, vacancyFactor: 1.05, exitCapFactor: 1.05 },
};
