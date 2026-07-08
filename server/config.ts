import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The master workbook IS the company brain and the primary live data source.
 * Override with WORKBOOK_PATH env if the file moves.
 *
 * Resolved at CALL time (not module load) — mirrors server/overlay.ts's overlayPath(). A
 * top-level `const` here would freeze in whatever process.env held when config.ts was first
 * imported, which happens (per ES module import evaluation order) before any importing
 * module's own loadEnvFile() call runs — silently discarding every .env override. Confirmed
 * empirically 2026-07-08: see docs/superpowers/plans/2026-07-08-workbook-path-dual-library-
 * and-env-loading-fix-plan.md.
 */
export function workbookPath(): string {
  return (
    process.env.WORKBOOK_PATH ??
    join(
      homedir(),
      'OneDrive - Oxford Capital Partners (1)',
      'eric spreadsheets',
      'Master Excel Template Company Wide -- Oxford.xlsx',
    )
  );
}

export const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ?? join(process.cwd(), 'data', 'snapshots', 'portfolio.json');

export const SERVER_PORT = Number(process.env.BRAIN_SERVER_PORT ?? 8911);

/** The workbook's stated "As of" date for v1 (the file carries June 1, 2026). */
export const WORKBOOK_AS_OF = process.env.WORKBOOK_AS_OF ?? '2026-06-01';
