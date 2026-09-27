/* eslint-disable react-refresh/only-export-components -- store helpers + context + Provider colocated by design */
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Market } from '@contracts/index';
import { PROPERTY_MARKETS, PropertyType } from '@contracts/index';

/**
 * Global, shell-level portfolio filter — the production analog of the design
 * handoff's `filter.js` (market / subtype / property manager slice). v1 filters
 * client-side over data each module has already fetched (no query-key changes,
 * `src/data/` untouched) — any consuming module calls `matchesProperty`/
 * `filterProperties` on its own already-fetched rows to narrow to the active slice.
 *
 * Manager attribution note: `Property` (Spine A / `PortfolioSnapshot.properties`,
 * see src/contracts/property.ts) carries no `propertyManager` field today — that
 * attribution lives only in the Spine B warehouse (`server/warehouse/property-master.ts`,
 * surfaced via `server/warehouse/*` routes into modules like ManagersView). `PortfolioRow`
 * below models `propertyManager` as optional for exactly this reason: a plain `Property`
 * satisfies it (manager filtering is simply a no-op for rows that don't carry the field),
 * while a module that joins in manager-enriched rows gets real manager filtering for free.
 */

const STORAGE_KEY = 'ora-portfolio-filter';

export interface PortfolioFilterState {
  market: Market | 'all';
  propertyType: PropertyType | 'all';
  manager: string | 'all';
}

export const DEFAULT_PORTFOLIO_FILTER: PortfolioFilterState = {
  market: 'all',
  propertyType: 'all',
  manager: 'all',
};

/** The minimal shape the filter needs from a per-property row. A raw `Property` satisfies
 *  this (propertyManager simply absent); a module-joined, manager-enriched row does too. */
export interface PortfolioRow {
  market: Market;
  type: PropertyType;
  propertyManager?: string | null;
}

// PROPERTY_MARKETS, not the full Market enum: this filter matches PortfolioRow (properties), and
// PortfolioFilterBar's dropdown (fixed in e2aff7b) can no longer WRITE one of the 2026-08-12
// deal-only markets into this filter's state. Left as the full enum here, a persisted/stale
// sessionStorage value equal to one of those markets would validate and silently match zero
// property rows — the same failure class the dropdown fix closed, one layer over.
// (Code review, 2026-08-13.)
const MARKET_VALUES = new Set<string>(PROPERTY_MARKETS);
const PROPERTY_TYPE_VALUES = new Set<string>(PropertyType.options);

function isMarket(v: unknown): v is Market {
  return typeof v === 'string' && MARKET_VALUES.has(v);
}

function isPropertyType(v: unknown): v is PropertyType {
  return typeof v === 'string' && PROPERTY_TYPE_VALUES.has(v);
}

function readStoredFilter(): PortfolioFilterState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PORTFOLIO_FILTER;
    const parsed = JSON.parse(raw) as Partial<Record<keyof PortfolioFilterState, unknown>>;
    const market = parsed.market === 'all' || isMarket(parsed.market) ? (parsed.market as Market | 'all') : 'all';
    const propertyType =
      parsed.propertyType === 'all' || isPropertyType(parsed.propertyType) ? (parsed.propertyType as PropertyType | 'all') : 'all';
    const manager = typeof parsed.manager === 'string' && parsed.manager.length > 0 ? parsed.manager : 'all';
    return { market, propertyType, manager };
  } catch {
    return DEFAULT_PORTFOLIO_FILTER;
  }
}

function persistFilter(filter: PortfolioFilterState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(filter));
  } catch {
    /* sessionStorage unavailable (e.g. private browsing quota) — filter still works in-memory */
  }
}

/** Pure predicate — does `row` match `filter`? 'all' bypasses that dimension. */
export function matchesFilter(row: PortfolioRow, filter: PortfolioFilterState): boolean {
  if (filter.market !== 'all' && row.market !== filter.market) return false;
  if (filter.propertyType !== 'all' && row.type !== filter.propertyType) return false;
  if (filter.manager !== 'all' && row.propertyManager !== filter.manager) return false;
  return true;
}

/** Pure, unit-testable-without-React helper — filters an already-fetched row array to the slice. */
export function filterProperties<T extends PortfolioRow>(properties: T[], filter: PortfolioFilterState): T[] {
  return properties.filter((row) => matchesFilter(row, filter));
}

/** True when any dimension is narrowed — shared by the bar's styling and the shell's readout. */
export function isPortfolioFiltered(f: PortfolioFilterState): boolean {
  return f.market !== 'all' || f.propertyType !== 'all' || f.manager !== 'all';
}

export interface PortfolioFilterApi {
  filter: PortfolioFilterState;
  setMarket: (market: Market | 'all') => void;
  setType: (propertyType: PropertyType | 'all') => void;
  setManager: (manager: string | 'all') => void;
  clear: () => void;
  matchesProperty: (row: PortfolioRow) => boolean;
}

const PortfolioFilterContext = createContext<PortfolioFilterApi | null>(null);

export function PortfolioFilterProvider({ children }: { children: ReactNode }) {
  const [filter, setFilter] = useState<PortfolioFilterState>(() => readStoredFilter());

  const update = (patch: Partial<PortfolioFilterState>) => {
    setFilter((prev) => {
      const next = { ...prev, ...patch };
      persistFilter(next);
      return next;
    });
  };

  const setMarket = (market: Market | 'all') => update({ market });
  const setType = (propertyType: PropertyType | 'all') => update({ propertyType });
  const setManager = (manager: string | 'all') => update({ manager });
  const clear = () => {
    setFilter(DEFAULT_PORTFOLIO_FILTER);
    persistFilter(DEFAULT_PORTFOLIO_FILTER);
  };
  const matchesProperty = (row: PortfolioRow) => matchesFilter(row, filter);

  const value: PortfolioFilterApi = { filter, setMarket, setType, setManager, clear, matchesProperty };

  return <PortfolioFilterContext.Provider value={value}>{children}</PortfolioFilterContext.Provider>;
}

export function usePortfolioFilter(): PortfolioFilterApi {
  const ctx = useContext(PortfolioFilterContext);
  if (!ctx) throw new Error('usePortfolioFilter must be used within PortfolioFilterProvider');
  return ctx;
}
