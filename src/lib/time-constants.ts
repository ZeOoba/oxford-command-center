/**
 * Shared time constants used by the client analytics/brain modules AND the server warehouse.
 * Lives under src/lib so the client never imports from server/** (layering rule enforced by
 * eslint no-restricted-imports); server/warehouse/time-constants.ts re-exports this module.
 */

/** Milliseconds in a day (24 * 60 * 60 * 1000) */
export const DAY_MS = 86400000 as const;

/** Milliseconds in a standard month (30.4375 days) */
export const MONTH_MS = 2629800000 as const; // DAY_MS * 30.4375

/** Milliseconds in a year (365.25 days) */
export const YEAR_MS = 31557600000 as const; // DAY_MS * 365.25
