// src/modules/property-condition/hooks.ts
//
// Property Condition data hook + pure display helpers (unit-testable; no React dependency).
//
// Read: GET /api/warehouse/property-condition/report → PropertyConditionReport. Degrades to the offline
// empty state like taxes/hooks.ts and intel/hooks.ts (fetchParsedOrMirror + QUERY_OPTS). The route is not
// in the baked static mirror yet, so a deployed mirror reads as offline by design.
//
// Doctrine (contracts/property-condition.ts): "current" = the most recent report we have, with NO age
// cutoff — age and usability render as caveat badges, never as exclusions. Consultant estimates and
// contractor prices are shown in separate tables and never blended.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { PropertyConditionReport } from '@contracts/property-condition';
import type {
  PcaEvidenceClass,
  PcaUsabilityClass,
  PcaWarrantyStatus,
} from '@contracts/property-condition';
import type { BadgeTone } from '@/primitives/Badge';

export type { PropertyConditionReport };

export const PROPERTY_CONDITION_KEYS = {
  report: ['warehouse', 'property-condition', 'report'] as const,
};

export function usePropertyCondition(opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: PROPERTY_CONDITION_KEYS.report,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/property-condition/report', PropertyConditionReport),
    ...QUERY_OPTS,
  });
}

/** Near-term PCA repair dollars on file for one property_master id (immediate + Yr 1–2, current reports only). */
export interface PcaNearTerm {
  dollars: number;
  immediateUsd: number;
  shortTermUsd: number;
  /** Consultant when a single report covers the property, else null (several reports roll up). */
  consultant: string | null;
  /** Oldest covered report date, null when any covered report is undated. */
  reportDate: string | null;
  reportCount: number;
}

/**
 * Near-term PCA repairs for a property_master id, summed over the CURRENT (newest) report of every
 * property_key mapped to it — the same "current = newest, no age cutoff" rule the engine's improve gate
 * uses (server/warehouse/pca-capex.ts). Dollars only (the calculator needs a $ amount, not an intensity),
 * so unlike the engine this does not require an SF. null when the property has no PCA dollars on file.
 */
export function pcaNearTermForProperty(
  report: PropertyConditionReport | undefined,
  propertyId: string | null | undefined,
): PcaNearTerm | null {
  if (!report || !report.loaded || !propertyId) return null;
  const mine = report.properties.filter(
    (p) => p.propertyMasterId === propertyId && (p.current.immediateUsd !== null || p.current.shortTermUsd !== null),
  );
  // Same rule as the engine loader (server/warehouse/pca-capex.ts): a portfolio-scope report covers the same
  // buildings as its sibling building reports, so it is dropped when any building report exists.
  const isPortfolio = (k: string): boolean => /portfolio/i.test(k);
  const rows = mine.some((p) => !isPortfolio(p.propertyKey)) ? mine.filter((p) => !isPortfolio(p.propertyKey)) : mine;
  if (rows.length === 0) return null;
  const immediateUsd = rows.reduce((a, p) => a + (p.current.immediateUsd ?? 0), 0);
  const shortTermUsd = rows.reduce((a, p) => a + (p.current.shortTermUsd ?? 0), 0);
  const dollars = immediateUsd + shortTermUsd;
  if (!(dollars > 0)) return null;
  const dates = rows.map((p) => p.current.reportDate);
  const dated = dates.filter((d): d is string => d !== null);
  return {
    dollars,
    immediateUsd,
    shortTermUsd,
    consultant: rows.length === 1 ? rows[0]!.current.consultant : null,
    reportDate: dated.length === dates.length ? [...dated].sort()[0] ?? null : null,
    reportCount: rows.length,
  };
}

// ── display helpers ──────────────────────────────────────────────────────────────────────────

export function usabilityBadge(c: PcaUsabilityClass): { label: string; tone: BadgeTone } {
  switch (c) {
    case 'current': return { label: 'Usable', tone: 'green' };
    case 'draft': return { label: 'Draft', tone: 'amber' };
    case 'limited': return { label: 'Limited', tone: 'amber' };
    case 'stale': return { label: 'Dated', tone: 'neutral' };
    default: return { label: 'Unclassified', tone: 'neutral' };
  }
}

export function ageLabel(years: number | null): string {
  if (years === null) return 'undated';
  return years < 1 ? '<1 yr' : `${years} yr${years === 1 ? '' : 's'}`;
}

/** Age is a caveat, not a verdict: neutral up to 5 yrs, amber 6–9, red 10+. */
export function ageTone(years: number | null): BadgeTone {
  if (years === null) return 'neutral';
  if (years >= 10) return 'red';
  if (years >= 6) return 'amber';
  return 'neutral';
}

export function warrantyBadge(s: PcaWarrantyStatus): { label: string; tone: BadgeTone } {
  switch (s) {
    case 'expired': return { label: 'Expired', tone: 'red' };
    case 'ends-this-year': return { label: 'Ends this year', tone: 'amber' };
    case 'expiring': return { label: 'Expiring ≤2 yrs', tone: 'amber' };
    case 'active': return { label: 'Active', tone: 'green' };
    default: return { label: 'Not stated', tone: 'neutral' };
  }
}

export function evidenceBadge(c: PcaEvidenceClass): { label: string; tone: BadgeTone } {
  switch (c) {
    case 'executed': return { label: 'Executed', tone: 'green' };
    case 'quoted': return { label: 'Quoted', tone: 'blue' };
    case 'budget': return { label: 'Budget', tone: 'amber' };
    default: return { label: 'Superseded', tone: 'neutral' };
  }
}

/** contractor ÷ estimate − 1 → '+213%' / '−60%' / '—'. */
export function fmtDeltaPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  // Round the MAGNITUDE: Math.round(-59.5) is -59 (rounds toward +Infinity), which would make -59.5% and
  // +59.5% display asymmetrically.
  const pct = Math.round(Math.abs(n) * 100);
  return `${n < 0 ? '−' : '+'}${pct}%`;
}

export function fmtPsf(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(digits)}`;
}

/** '2025-11' → 'Nov 2025'; '2025-11-25' → '25 Nov 2025'; '2016' → '2016'; null → '—'. Pure string math (no Date/timezone). */
export function fmtPartialDate(d: string | null): string {
  if (d === null) return '—';
  const [y, m, day] = d.split('-');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = m ? MONTHS[Number(m) - 1] : undefined;
  if (!mon) return y ?? '—';
  return day ? `${Number(day)} ${mon} ${y}` : `${mon} ${y}`;
}

export function truncate(s: string | null, max: number): string {
  if (s === null) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
