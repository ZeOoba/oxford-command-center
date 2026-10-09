// server/property-financials/config.ts
//
// Property Financials module (docs/superpowers/plans/2026-10-05-property-financials-module.md, T4).
// The ONE home of the dataset directory and status-store path defaults. Both are resolved at CALL
// time (same rationale as edge/config.ts and server/overlay.ts): a top-level const would freeze
// whatever process.env held when this module was first imported, before .env loading.
import { join } from 'node:path';

/**
 * Freshness window for the dataset's `as_of` date, in days. The dataset is a monthly-close product
 * (as_of = last closed month end), so one missed refresh is still inside 45 days; two are not.
 * Distinct from the firm's 7-day mirror rule (EDGE_STALE_DAYS), which governs live mirrors, not a
 * monthly close. 45 days ratified by Gabriel 2026-10-05.
 */
export const PF_STALE_DAYS = 45;

/** Directory holding dataset.json + monthly-long.csv. PROPERTY_FINANCIALS_DIR overrides; blank = unset. */
export function propertyFinancialsDir(): string {
  const fromEnv = process.env.PROPERTY_FINANCIALS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(process.cwd(), 'data', 'property-financials');
}

/**
 * Per-insight workflow store (owner / due date / status). Deliberately OUTSIDE the dataset directory:
 * the dataset files are source data and are never written back. Gitignored, like data/overlay.json.
 */
export function propertyFinancialsStatusPath(): string {
  const fromEnv = process.env.PROPERTY_FINANCIALS_STATUS_PATH?.trim();
  if (fromEnv) return fromEnv;
  return join(process.cwd(), 'data', 'property-financials-status.json');
}
