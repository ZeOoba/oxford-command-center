// tests/unit/property-financials-helpers.ts — shared loaders for the property-financials tests.
// Not a test file (no .test suffix); vitest ignores it, tsconfig includes it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePropertyFinancialsDataset, type PfDataset } from '@contracts/property-financials';

// Resolved from the repo root (vitest's cwd), not import.meta.url: under the jsdom environment
// import.meta.url is not a file: URL, so fileURLToPath throws there (render tests use this too).
const dataPath = (file: string): string => resolve(process.cwd(), 'data', 'property-financials', file);

export function loadDatasetText(): string {
  return readFileSync(dataPath('dataset.json'), 'utf8');
}

let cached: PfDataset | null = null;
/** The committed dataset, parsed through the strict contract (memoised per test file). */
export function loadDataset(): PfDataset {
  if (!cached) cached = parsePropertyFinancialsDataset(JSON.parse(loadDatasetText()));
  return cached;
}

export function loadCsvText(): string {
  return readFileSync(dataPath('monthly-long.csv'), 'utf8');
}
