// src/analytics/pca-intelligence.ts
//
// Pure derivations over the Property Condition read model (contracts/property-condition.ts): the
// $/SF/yr derivation with explicit origin, report status, near-term capex rollup + concentration,
// report-currency alerts, the warranty/useful-life clock, and a provenance-carrying overlay that
// corrects known register errors (29000 Information Ln Immediate / Short-Term) without touching the
// warehouse. Display/intelligence only — nothing here feeds scoring, governors, DSCR/LTV or capital
// allocation (Phase 4 wiring is separate and sits behind refute-financial-change).
//
// Basis discipline: every dollar here is a PCA consultant ESTIMATE. Contractor quotes live in a
// different table and are never blended into anything computed in this file.
import type { PcaPropertySummary, PcaReportBrief, PropertyConditionReport } from '../contracts/property-condition';

// ── provenance + overlay types ──────────────────────────────────────────────────────────────

export type PcaStatus = 'CURRENT' | 'DRAFT' | 'STALE';
export type PcaPriceBasis = 'PCA_CONSULTANT_ESTIMATE' | 'CONTRACTOR_QUOTE' | 'CONTRACTOR_ACTUAL';

/** Every figure the overlay introduces carries where it came from, as data (not a comment). */
export interface Provenance {
  sourceFile: string;
  sourceDate: string;
  priceBasis: PcaPriceBasis;
  status: PcaStatus;
}

export type CorrectableField =
  | 'reportDate' | 'consultant' | 'usabilityClass' | 'sf' | 'immediateUsd' | 'shortTermUsd'
  | 'reservesUninflUsd' | 'reservesInflUsd' | 'psfYrStated';

export interface ReportCorrection {
  propertyKey: string;
  /** Only applied to this report — if the property's current report changes, the correction retires itself. */
  reportId: string;
  set: Partial<Pick<PcaReportBrief, CorrectableField>>;
  reason: string;
  provenance: Provenance;
}

export interface RentRollRecord {
  propertyKey: string;
  propertyLabel: string;
  /** YYYY-MM-DD the roll was struck. */
  asOf: string;
  stale: boolean;
  note: string;
  provenance: Provenance;
}

export interface PcaOverlay {
  corrections: ReportCorrection[];
  /** Data-quality flags per propertyKey, rendered wherever the property's numbers appear. */
  flags: Record<string, string[]>;
  rentRolls: RentRollRecord[];
}

// ── status / age ────────────────────────────────────────────────────────────────────────────

/** Reports dated before this year feed install-date / EUL history only — never totals or forecasts. */
export const STALE_BEFORE_YEAR = 2024;
export const AGE_ALERT_MONTHS = 24;

function ymOf(partial: string): { y: number; m: number } | null {
  const [ys, ms] = partial.split('-');
  const y = Number(ys);
  if (!Number.isInteger(y)) return null;
  const m = ms === undefined ? 1 : Number(ms);
  return { y, m: Number.isInteger(m) && m >= 1 && m <= 12 ? m : 1 };
}

/** Whole calendar months from a YYYY / YYYY-MM / YYYY-MM-DD date to `asOf` (YYYY-MM-DD). Day is ignored. */
export function monthsSince(partial: string | null, asOf: string): number | null {
  if (partial === null) return null;
  const a = ymOf(partial);
  const b = ymOf(asOf);
  if (!a || !b) return null;
  return b.y * 12 + b.m - (a.y * 12 + a.m);
}

export function reportStatus(b: Pick<PcaReportBrief, 'usabilityClass' | 'reportDate'>): PcaStatus {
  const y = b.reportDate === null ? null : ymOf(b.reportDate)?.y ?? null;
  if (y !== null && y < STALE_BEFORE_YEAR) return 'STALE';
  if (b.usabilityClass === 'stale') return 'STALE';
  if (b.usabilityClass === 'draft') return 'DRAFT';
  return 'CURRENT';
}

// ── $/SF/yr ─────────────────────────────────────────────────────────────────────────────────

export type PsfOrigin = 'stated' | 'derived' | 'n/a';
export interface PsfResult {
  value: number | null;
  origin: PsfOrigin;
  /** The figure the report printed, kept for display even when it does not reconcile. */
  stated: number | null;
}

const PSF_RECONCILE_TOLERANCE = 0.01;

/**
 * reserves(uninflated) ÷ SF ÷ term, computed here. 'stated' only when the printed figure reconciles to the
 * computation; otherwise 'derived'. No uninflated reserve (or no SF / term) → n/a — nothing is imputed.
 */
export function reservePsfYr(i: {
  reservesUninflUsd: number | null;
  sf: number | null;
  termYears: number | null;
  psfYrStated: number | null;
}): PsfResult {
  const { reservesUninflUsd, sf, termYears, psfYrStated } = i;
  if (reservesUninflUsd === null || sf === null || sf <= 0 || termYears === null || termYears <= 0) {
    return { value: null, origin: 'n/a', stated: psfYrStated };
  }
  const value = reservesUninflUsd / sf / termYears;
  const reconciles = psfYrStated !== null && Math.abs(psfYrStated - value) <= PSF_RECONCILE_TOLERANCE;
  return { value, origin: reconciles ? 'stated' : 'derived', stated: psfYrStated };
}

// ── overlay application ─────────────────────────────────────────────────────────────────────

export interface AdjustedProperty extends PcaPropertySummary {
  flags: string[];
  psf: PsfResult;
  status: PcaStatus;
}

export interface AppliedCorrection {
  propertyKey: string;
  reportId: string;
  reason: string;
  provenance: Provenance;
  changes: Array<{ field: CorrectableField; from: unknown; to: unknown }>;
}

export type AdjustedReport = Omit<PropertyConditionReport, 'properties'> & {
  properties: AdjustedProperty[];
  corrections: AppliedCorrection[];
};

function sumOf(values: Array<number | null>): number {
  return values.reduce<number>((a, v) => a + (v ?? 0), 0);
}

/**
 * Applies the curated corrections + flags to the warehouse read model and recomputes totals. Idempotent:
 * a correction whose values are already present (register fixed upstream) records no change.
 */
export function applyPcaOverlay(report: PropertyConditionReport, overlay: PcaOverlay): AdjustedReport {
  const corrections: AppliedCorrection[] = [];

  const properties: AdjustedProperty[] = report.properties.map((p) => {
    let current: PcaReportBrief = p.current;
    for (const c of overlay.corrections) {
      if (c.propertyKey !== p.propertyKey || c.reportId !== current.reportId) continue;
      const changes: AppliedCorrection['changes'] = [];
      const next = { ...current };
      for (const [field, to] of Object.entries(c.set) as Array<[CorrectableField, never]>) {
        if (current[field] !== to) {
          changes.push({ field, from: current[field], to });
          (next as Record<string, unknown>)[field] = to;
        }
      }
      current = next;
      if (changes.length > 0) {
        corrections.push({ propertyKey: c.propertyKey, reportId: c.reportId, reason: c.reason, provenance: c.provenance, changes });
      }
    }
    const psf = reservePsfYr(current);
    return {
      ...p,
      current,
      reservesPsfYr: psf.value,
      hasDollarFigures: [current.immediateUsd, current.shortTermUsd, current.reservesUninflUsd, current.reservesInflUsd].some((v) => v !== null),
      flags: overlay.flags[p.propertyKey] ?? [],
      psf,
      status: reportStatus(current),
    };
  });

  // Dollar totals exclude STALE (pre-2024) reports: they feed install-date history only, never totals.
  const currents = properties.filter((p) => p.status !== 'STALE').map((p) => p.current);
  return {
    ...report,
    properties,
    corrections,
    totals: {
      propertiesTotal: properties.length,
      propertiesWithFigures: properties.filter((p) => p.hasDollarFigures).length,
      immediateUsd: sumOf(currents.map((c) => c.immediateUsd)),
      shortTermUsd: sumOf(currents.map((c) => c.shortTermUsd)),
      reservesUninflUsd: sumOf(currents.map((c) => c.reservesUninflUsd)),
    },
  };
}

// ── near-term rollup ────────────────────────────────────────────────────────────────────────

export interface RollupRow {
  propertyKey: string;
  propertyLabel: string;
  immediateUsd: number;
  shortTermUsd: number;
  totalUsd: number;
  /** totalUsd ÷ rollup total. */
  share: number;
  status: PcaStatus;
}

export interface NearTermRollup {
  rows: RollupRow[];
  totalUsd: number;
  /** Share of the largest single property — the concentration figure. */
  topShare: number;
  /** STALE reports left out (install-date history only, never totals). */
  excludedStale: number;
}

export function nearTermRollup(properties: Array<PcaPropertySummary & { status?: PcaStatus }>): NearTermRollup {
  let excludedStale = 0;
  const base: Array<Omit<RollupRow, 'share'>> = [];
  for (const p of properties) {
    const status = p.status ?? reportStatus(p.current);
    if (status === 'STALE') {
      excludedStale += 1;
      continue;
    }
    const immediateUsd = p.current.immediateUsd ?? 0;
    const shortTermUsd = p.current.shortTermUsd ?? 0;
    const totalUsd = immediateUsd + shortTermUsd;
    if (totalUsd <= 0) continue;
    base.push({ propertyKey: p.propertyKey, propertyLabel: p.propertyLabel, immediateUsd, shortTermUsd, totalUsd, status });
  }
  base.sort((a, b) => b.totalUsd - a.totalUsd || a.propertyLabel.localeCompare(b.propertyLabel));
  const totalUsd = base.reduce((a, r) => a + r.totalUsd, 0);
  const rows = base.map((r) => ({ ...r, share: totalUsd > 0 ? r.totalUsd / totalUsd : 0 }));
  return { rows, totalUsd, topShare: rows[0]?.share ?? 0, excludedStale };
}

// ── report-currency alerts ──────────────────────────────────────────────────────────────────

export type CurrencyAlertKind = 'draft' | 'age' | 'rent-roll';
export interface CurrencyAlert {
  kind: CurrencyAlertKind;
  severity: 'warn' | 'info';
  propertyKey: string;
  propertyLabel: string;
  message: string;
}

export function currencyAlerts(
  properties: Array<PcaPropertySummary & { status?: PcaStatus }>,
  asOf: string,
  overlay: Pick<PcaOverlay, 'rentRolls'>,
): CurrencyAlert[] {
  const alerts: CurrencyAlert[] = [];
  const staleLabels: string[] = [];
  for (const p of properties) {
    const status = p.status ?? reportStatus(p.current);
    if (status === 'DRAFT') {
      alerts.push({
        kind: 'draft', severity: 'warn', propertyKey: p.propertyKey, propertyLabel: p.propertyLabel,
        message: `Report is a DRAFT${p.current.consultant ? ` (${p.current.consultant})` : ''} — final not on file`,
      });
    }
    const months = monthsSince(p.current.reportDate, asOf);
    if (months !== null && months > AGE_ALERT_MONTHS) {
      if (status === 'STALE') {
        staleLabels.push(p.propertyLabel);
      } else {
        alerts.push({
          kind: 'age', severity: 'warn', propertyKey: p.propertyKey, propertyLabel: p.propertyLabel,
          message: `Report is ${months} months old (> ${AGE_ALERT_MONTHS})`,
        });
      }
    }
  }
  // STALE reports are already excluded from totals; one summary line instead of a row per report.
  if (staleLabels.length > 0) {
    alerts.push({
      kind: 'age', severity: 'info', propertyKey: '_stale', propertyLabel: `${staleLabels.length} stale reports`,
      message: `Older than ${AGE_ALERT_MONTHS} months and dated pre-${STALE_BEFORE_YEAR} — install-date history only, excluded from totals: ${staleLabels.join('; ')}`,
    });
  }
  for (const r of overlay.rentRolls) {
    if (!r.stale) continue;
    const months = monthsSince(r.asOf, asOf);
    alerts.push({
      kind: 'rent-roll', severity: 'warn', propertyKey: r.propertyKey, propertyLabel: r.propertyLabel,
      message: `Rent roll dated ${r.asOf} is stale${months === null ? '' : ` (${months} months)`} — ${r.note}`,
    });
  }
  return alerts;
}

// ── warranty / useful-life clock ────────────────────────────────────────────────────────────

export interface ClockInput {
  installYear: number | null;
  eul: number | null;
  rul: number | null;
  /** Year the RUL was stated in; the RUL is rolled forward from here. */
  rulAsOfYear: number | null;
  warrantyEndYear: number | null;
}

export type ClockRow<T extends ClockInput> = T & {
  warrantyYearsRemaining: number | null;
  lifeYearsRemaining: number | null;
};

/** Years left are computed from `asOf` on every call — never stored. Negative = past due / expired. */
export function warrantyClock<T extends ClockInput>(rows: T[], asOf: string): Array<ClockRow<T>> {
  const asOfYear = Number(asOf.slice(0, 4));
  return rows.map((r) => {
    let life: number | null = null;
    if (r.installYear !== null && r.eul !== null) life = r.installYear + r.eul - asOfYear;
    else if (r.rul !== null && r.rulAsOfYear !== null) life = r.rul - (asOfYear - r.rulAsOfYear);
    return {
      ...r,
      warrantyYearsRemaining: r.warrantyEndYear === null ? null : r.warrantyEndYear - asOfYear,
      lifeYearsRemaining: life,
    };
  });
}
