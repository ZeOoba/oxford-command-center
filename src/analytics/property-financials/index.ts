// src/analytics/property-financials/index.ts — pure calc library for the Property Financials module.
// Deliberately NOT re-exported from src/analytics/index.ts: names like `yoy` / `median` / `usd` would
// collide with or shadow the Spine-A helpers there. Import by path: '@analytics/property-financials'.
export * from './periods';
export * from './metrics';
export * from './thresholds';
export * from './format';
export * from './csv';
export * from './aggregate';
