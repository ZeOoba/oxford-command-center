// server/warehouse/governors.ts
//
// Single named import path for the ratified capital governor set. All warehouse engines
// MUST import through here — never directly from capital-config.ts for governor reads —
// so every consumer is traceable from one file and the orphaned-governor pattern (H5) can
// never silently recur. New Phase-2/5 engines: import loadGovernors here, call it once at
// the top of your scoring/recommendation function.
//
// Note: the cap-rate governors (dispositionCapRate, holdCapRate) require NOI / appraised
// value to produce a verdict. Appraised value is not yet in PeriodMetrics — that is a
// Phase-2 data hook. Until then, engines surface the threshold values in their reason
// strings (see scores.ts buildReasons) so a human reviewer can apply them manually.
export { loadCapitalConfig as loadGovernors, CAPITAL_CONFIG as GOVERNOR_DEFAULTS } from './capital-config';
export type { CapitalConfigRow as Governors } from './capital-config';
