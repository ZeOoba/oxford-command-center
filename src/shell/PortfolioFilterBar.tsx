import type { CSSProperties } from 'react';
import { Market, PropertyType } from '@contracts/index';
import { Button } from '@/primitives/Button';
import { usePortfolioFilter } from './PortfolioFilterContext';

const fieldCls = 'num h-8 rounded-[var(--radius-sm)] px-2.5 text-2xs outline-none';
const fieldStyle: CSSProperties = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
};

export interface PortfolioFilterBarProps {
  /** Distinct property-manager names, computed by the mounting component from its
   *  already-fetched data (see PortfolioFilterContext.tsx for why this may be empty). */
  managers: string[];
}

/**
 * Compact, always-visible global filter — production analog of the design handoff's
 * `filter.js` bar. Market / Type / Manager selects + a Clear button, wired to
 * `usePortfolioFilter()`. Display/wiring only — no fetching, no analytics recompute.
 */
export function PortfolioFilterBar({ managers }: PortfolioFilterBarProps) {
  const { filter, setMarket, setType, setManager, clear } = usePortfolioFilter();
  const isFiltered = filter.market !== 'all' || filter.propertyType !== 'all' || filter.manager !== 'all';

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4 lg:px-5"
      style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-base)' }}
    >
      <span className="num text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
        Portfolio filter
      </span>

      <select
        aria-label="Filter by market"
        value={filter.market}
        onChange={(e) => setMarket(e.target.value as Market | 'all')}
        className={fieldCls}
        style={fieldStyle}
      >
        <option value="all">All markets</option>
        {Market.options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by property type"
        value={filter.propertyType}
        onChange={(e) => setType(e.target.value as PropertyType | 'all')}
        className={fieldCls}
        style={fieldStyle}
      >
        <option value="all">All types</option>
        {PropertyType.options.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by property manager"
        value={filter.manager}
        onChange={(e) => setManager(e.target.value)}
        className={fieldCls}
        style={fieldStyle}
      >
        <option value="all">All managers</option>
        {managers.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      {isFiltered && (
        <Button size="sm" variant="ghost" onPress={clear} aria-label="Clear portfolio filter">
          Clear
        </Button>
      )}
    </div>
  );
}
