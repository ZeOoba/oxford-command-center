// tests/unit/property-financials-helpers.ts — shared loaders for the property-financials tests.
// Not a test file (no .test suffix); vitest ignores it, tsconfig includes it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePropertyFinancialsDataset, type PfDataset } from '@contracts/property-financials';

const DATA_DIR = new URL('../../data/property-financials/', import.meta.url);

export function loadDatasetText(): string {
  return readFileSync(fileURLToPath(new URL('dataset.json', DATA_DIR)), 'utf8');
}

let cached: PfDataset | null = null;
/** The committed dataset, parsed through the strict contract (memoised per test file). */
export function loadDataset(): PfDataset {
  if (!cached) cached = parsePropertyFinancialsDataset(JSON.parse(loadDatasetText()));
  return cached;
}

export function loadCsvText(): string {
  return readFileSync(fileURLToPath(new URL('monthly-long.csv', DATA_DIR)), 'utf8');
}
