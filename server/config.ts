import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The master workbook IS the company brain and the primary live data source.
 * Override with WORKBOOK_PATH env if the file moves.
 */
export const WORKBOOK_PATH =
  process.env.WORKBOOK_PATH ??
  join(
    homedir(),
    'OneDrive - Oxford Capital Partners (1)',
    'eric spreadsheets',
    'Master Excel Template Company Wide -- Oxford.xlsx',
  );

export const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ?? join(process.cwd(), 'data', 'snapshots', 'portfolio.json');

export const SERVER_PORT = Number(process.env.BRAIN_SERVER_PORT ?? 8911);

/** The workbook's stated "As of" date for v1 (the file carries June 1, 2026). */
export const WORKBOOK_AS_OF = process.env.WORKBOOK_AS_OF ?? '2026-06-01';
