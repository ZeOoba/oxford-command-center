/**
 * Shared time constants used across the warehouse and analytics modules.
 */

/** Milliseconds in a day (24 * 60 * 60 * 1000) */
export const DAY_MS = 86400000 as const;

/** Milliseconds in a standard month (30.4375 days) */
export const MONTH_MS = 2629800000 as const; // DAY_MS * 30.4375

/** Milliseconds in a year (365.25 days) */
export const YEAR_MS = 31557600000 as const; // DAY_MS * 365.25
