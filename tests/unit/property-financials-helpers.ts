// tests/unit/property-financials-helpers.ts — shared loaders for the property-financials tests.
// Not a test file (no .test suffix); vitest ignores it, tsconfig includes it.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'vitest';
import { parsePropertyFinancialsDataset, type PfDataset } from '@contracts/property-financials';

// Resolved from the repo root (vitest's cwd), not import.meta.url: under the jsdom environment
// import.meta.url is not a file: URL, so fileURLToPath throws there (render tests use this too).
// PROPERTY_FINANCIALS_DIR (the server's own dataset-dir override, server/property-financials/config.ts)
// is honoured, read ONCE at import, so a run can point every test at another copy of the directory —
// e.g. a temp copy holding dataset.json but no CSV, to exercise the skip path below on this machine.
export const PF_DATA_DIR: string = process.env.PROPERTY_FINANCIALS_DIR?.trim() || resolve(process.cwd(), 'data', 'property-financials');

const dataPath = (file: string): string => join(PF_DATA_DIR, file);

export function loadDatasetText(): string {
  return readFileSync(dataPath('dataset.json'), 'utf8');
}

let cached: PfDataset | null = null;
/** The committed dataset, parsed through the strict contract (memoised per test file). */
export function loadDataset(): PfDataset {
  if (!cached) cached = parsePropertyFinancialsDataset(JSON.parse(loadDatasetText()));
  return cached;
}

// -------------------------------------------------------------------------------------------------
// monthly-long.csv — LOCAL-ONLY audit layer (Gabriel ruling 2026-10-06)
// -------------------------------------------------------------------------------------------------
// The GL-level CSV is gitignored and was purged from branch history (the pre-push confidential scan
// blocks CSVs under data/). dataset.json and data-dictionary.md stay committed. On a checkout without
// the CSV (hosted CI, a fresh clone) every test that needs it SKIPS — never fails, never passes on
// empty data — and auditCsvSkipMarker() puts a visible skipped entry carrying the reason in the report.

export const AUDIT_CSV_PATH: string = dataPath('monthly-long.csv');
export const HAVE_AUDIT_CSV: boolean = existsSync(AUDIT_CSV_PATH);
export const NO_AUDIT_CSV_REASON =
  'monthly-long.csv not present (local-only audit layer; regenerate with scripts/property-financials/normalize-raw.ts)';

/** describe / it that run only when the audit CSV is on disk. */
export const describeWithAuditCsv = describe.skipIf(!HAVE_AUDIT_CSV);
export const itWithAuditCsv = it.skipIf(!HAVE_AUDIT_CSV);

/** Registers one visibly SKIPPED test naming why the CSV-backed tests of this file did not run. No-op when present. */
export function auditCsvSkipMarker(): void {
  if (!HAVE_AUDIT_CSV) it.skip(NO_AUDIT_CSV_REASON, () => undefined);
}

/** The audit CSV text. Call only from CSV-gated code (or behind HAVE_AUDIT_CSV): throws when absent. */
export function loadCsvText(): string {
  return readFileSync(AUDIT_CSV_PATH, 'utf8');
}

/**
 * A tiny, well-formed monthly-long.csv stand-in for tests that only need SOME CSV bytes (the loader's
 * hash / memo / no-write paths, the API's csvSha256). Synthetic, so those tests run on every checkout.
 */
export const SYNTHETIC_CSV_TEXT =
  'entity,period,line_type,category,source_account,amount_usd\r\n' +
  'Synthetic Entity,2024-01,rev,Base rent,Rent Income,1000.0\r\n' +
  'Synthetic Entity,2024-01,opex,Repairs & maintenance,Repairs,250.5\r\n';
