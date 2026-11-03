// src/modules/property-financials/expense-matrix.ts
//
// Property × expense-line $/SF matrix (roadmap 3.2) on the existing annual P&L ledger. Each cell is a
// full year's postings for one opex line ÷ the entity's SF, entity 100% basis. Cells shade by
// PORTFOLIO QUARTILE within their column — an interim until the per-column thresholds for design
// step 7 are ratified; quartiles say "high vs the other properties", never "too high".
//
// Honesty rules: a line with no postings in the year is "no postings" (null), never $0, and stays
// out of the quartile cut; an entity with no SF, or whose year is partial, gets no cells at all.
// A year is full on the Explorer's rule: 12 months of data for a monthly entity (the contract's
// `partial` flag stays false on an in-progress monthly year), the statement's `partial` flag otherwise.
import { PF_ENTITY_IDS, type OpexCategory, type PfDataset, type PfEntityId } from '@contracts/property-financials';

/** The six lines the roadmap names, in display order. */
export const MATRIX_LINES = [
  'Real estate & property tax',
  'Insurance',
  'Repairs & maintenance',
  'Utilities',
  'Grounds / snow / lot',
  'Management fees',
] as const satisfies readonly OpexCategory[];
export type MatrixLine = (typeof MATRIX_LINES)[number];

export const MATRIX_LINE_LABEL: Readonly<Record<MatrixLine, string>> = {
  'Real estate & property tax': 'Taxes',
  Insurance: 'Insurance',
  'Repairs & maintenance': 'R&M',
  Utilities: 'Utilities',
  'Grounds / snow / lot': 'Grounds',
  'Management fees': 'Mgmt fee',
};

/** 1 = lowest $/SF quarter of the column … 4 = highest; null = unranked (no value, or column too thin). */
export type Quartile = 1 | 2 | 3 | 4 | null;

export interface MatrixCell {
  /** $/SF for the year; null = no postings on this line. */
  perSf: number | null;
  /** Dollars posted (entity 100%); null = no postings. */
  usd: number | null;
  quartile: Quartile;
}

export interface MatrixRow {
  entity: PfEntityId;
  sf: number;
  cells: Record<MatrixLine, MatrixCell>;
}

export interface ExpenseMatrix {
  year: string;
  rows: MatrixRow[];
  /** Entities left out, with the reason (no SF, no full year). */
  excluded: { entity: PfEntityId; reason: string }[];
}

/** Below this many valued cells a column is not quartiled (four buckets need at least four points). */
export const MIN_QUARTILE_N = 4;

/** Quartile of `v` within `values` by rank (ties share the lower rank). Pure; exported for tests. */
export function quartileOf(v: number, values: readonly number[]): Quartile {
  if (values.length < MIN_QUARTILE_N) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const below = sorted.findIndex((x) => x >= v);
  const rank = below === -1 ? sorted.length - 1 : below;
  return (Math.min(3, Math.floor((rank / sorted.length) * 4)) + 1) as Quartile;
}

type HistoryYear = PfDataset['history'][PfEntityId]['yr'][string];

/** Full year on the Explorer's rule (explorer-model.ts periodGroups). */
export function isFullYear(monthly: boolean, y: HistoryYear | undefined): boolean {
  return !!y && (monthly ? y.n === 12 : !y.partial);
}

/** Build the matrix for one full year (e.g. '2025'). */
export function buildExpenseMatrix(d: PfDataset, year: string): ExpenseMatrix {
  const rows: MatrixRow[] = [];
  const excluded: ExpenseMatrix['excluded'] = [];
  for (const entity of PF_ENTITY_IDS) {
    const sf = d.sf[entity]?.sf ?? null;
    const h = d.history[entity];
    const y = h?.yr[year];
    if (!sf || sf <= 0) {
      excluded.push({ entity, reason: 'no square footage' });
      continue;
    }
    if (!y || !isFullYear(!!h?.monthly, y)) {
      excluded.push({ entity, reason: y ? `${year} is a partial year` : `no ${year} statements` });
      continue;
    }
    const cells = {} as Record<MatrixLine, MatrixCell>;
    for (const line of MATRIX_LINES) {
      const usd = y.cats[line];
      cells[line] = usd === undefined ? { perSf: null, usd: null, quartile: null } : { perSf: usd / sf, usd, quartile: null };
    }
    rows.push({ entity, sf, cells });
  }
  for (const line of MATRIX_LINES) {
    const values = rows.map((r) => r.cells[line].perSf).filter((v): v is number => v !== null);
    for (const r of rows) {
      const c = r.cells[line];
      if (c.perSf !== null) c.quartile = quartileOf(c.perSf, values);
    }
  }
  return { year, rows, excluded };
}

/** The latest year that is a full (non-partial) year for at least one SF-bearing entity; null if none. */
export function latestFullYear(d: PfDataset): string | null {
  let best: string | null = null;
  for (const entity of PF_ENTITY_IDS) {
    if (!d.sf[entity]?.sf) continue;
    const h = d.history[entity];
    for (const [year, y] of Object.entries(h?.yr ?? {})) if (isFullYear(!!h?.monthly, y) && (best === null || year > best)) best = year;
  }
  return best;
}
