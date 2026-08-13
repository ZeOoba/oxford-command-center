import type { CSSProperties } from 'react';
import { Market, PROPERTY_MARKETS, PropertyType } from '@contracts/index';
import { Button } from '@/primitives/Button';
import { usePortfolioFilter } from './PortfolioFilterContext';

const fieldCls = 'num h-8 rounded-[var(--radius-sm)] px-2.5 text-2xs outline-none';
const fieldStyle: CSSProperties = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
};
const fieldStyleSet: CSSProperties = {
  ...fieldStyle,
  border: '1px solid var(--accent)',
  color: 'var(--text-accent)',
};

export interface PortfolioFilterBarProps {
  /** Distinct property-manager names, computed by the mounting component from its
   *  already-fetched data (see PortfolioFilterContext.tsx for why this may be empty). */
  managers: string[];
  /** Display-only slice readout ("12 of 31 assets · $4.2M NOI"), computed by the
   *  mounting component from already-fetched data — no new fetching here. */
  slice?: { shown: number; total: number; noiUsd?: number };
}

export function PortfolioFilterBar({ managers, slice }: PortfolioFilterBarProps) {
  const { filter, setMarket, setType, setManager, clear } = usePortfolioFilter();
  const isFiltered = filter.market !== 'all' || filter.propertyType !== 'all' || filter.manager !== 'all';

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4 lg:px-5"
      style={{
        borderBottom: `1px solid ${isFiltered ? 'color-mix(in oklab, var(--accent) 35%, transparent)' : 'var(--border-subtle)'}`,
        background: isFiltered ? 'var(--accent-quiet)' : 'var(--surface-base)',
      }}
    >
      <span className="num text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
        Portfolio filter
      </span>

      <select
        aria-label="Filter by market"
        value={filter.market}
        onChange={(e) => setMarket(e.target.value as Market | 'all')}
        className={fieldCls}
        style={filter.market !== 'all' ? fieldStyleSet : fieldStyle}
      >
        <option value="all">All markets</option>
        {/* PROPERTY_MARKETS, not Market.options: the 2026-08-12 enum additions are pipeline-deal
            metros where ORA owns nothing, and this filter matches PROPERTIES (matchesFilter takes a
            PortfolioRow). Listing them would offer options that can only ever match zero rows. */}
        {PROPERTY_MARKETS.map((m) => (
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
        style={filter.propertyType !== 'all' ? fieldStyleSet : fieldStyle}
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
        style={filter.manager !== 'all' ? fieldStyleSet : fieldStyle}
      >
        <option value="all">All managers</option>
        {managers.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      {isFiltered && slice && (
        <span className="num ml-auto text-2xs" style={{ color: 'var(--text-secondary)' }}>
          {slice.shown} of {slice.total} assets
          {slice.noiUsd != null && ` · $${(slice.noiUsd / 1_000_000).toFixed(1)}M NOI`}
        </span>
      )}

      {isFiltered && (
        <Button size="sm" variant="ghost" onPress={clear} aria-label="Clear portfolio filter">
          Clear
        </Button>
      )}
    </div>
  );
}
