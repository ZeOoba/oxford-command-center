/**
 * Shared time constants used across the warehouse and analytics modules.
 */

/** Milliseconds in a day (24 * 60 * 60 * 1000) */
export const DAY_MS = 86400000 as const;

/** Milliseconds in a standard month (30.4375 days) */
export const MONTH_MS = 2629800000 as const; // DAY_MS * 30.4375

/** Milliseconds in a year (365.25 days) */
export const YEAR_MS = 31557600000 as const; // DAY_MS * 365.25

/**
 * Today's calendar date (YYYY-MM-DD) in the America/New_York zone for the wall-clock instant
 * `now` (ms epoch, defaults to Date.now()). The shared "today" anchor for day-count math
 * (lease expiry, balloon maturity, LOI deadlines, etc.) — callers must derive "today" from this,
 * never from a snapshot's meta.asOf, which is a frozen workbook-label constant (see WORKBOOK_AS_OF
 * in server/config.ts) that never advances with the calendar.
 */
export function todayEastern(now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}
