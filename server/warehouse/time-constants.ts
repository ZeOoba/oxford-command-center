/**
 * Shared time constants — canonical copy lives in src/lib/time-constants.ts (client-safe, no
 * server import from src/**). Server code keeps importing from here; this is a pure re-export.
 */
export { DAY_MS, MONTH_MS, YEAR_MS } from '../../src/lib/time-constants';
