// server/warehouse/pca-capex.ts
//
// PCA near-term capex intensity per property_master id — the real-data input to the capital-allocation
// engine's `improve` gate (Phase 4 of docs/capital/2026-10-07-pca-capex-ledger-integration-plan.md).
//
// WHAT IT IS: for each property_master id, the near-term repair dollars its CURRENT PCA(s) call for —
// immediate + short-term (Yr 1–2) — divided by the SF those same reports cover. "Current" is exactly the
// Property Condition read model's definition (buildPropertyConditionReport): the most recent report per
// property_key, NO age cutoff (Gabriel, 2026-10-07). One source of truth, so the engine and the
// Property Condition destination can never disagree about which report is current.
//
// WHAT IT IS NOT: it is not a value-add budget. A PCA lists deferred maintenance the building needs
// regardless; it says nothing about the spend that would close an NOI gap to peers. The engine therefore
// uses the LARGER of this and its assumed value-add spend (the $10/SF assumption is a floor; never summed) — see capitalAllocation.capexIrrEstimate.
// Replacing the assumption outright would let a clean building with a tiny PCA total ($0.04/SF) produce a
// capex yield 250× too high and fire a spurious `improve`.
//
// AGGREGATION: several property_keys can roll up to one master id (the Sepich portfolio row carries
// Banwick, Old Morrison and Fairground Village). Dollars and SF are summed across the keys that have BOTH
// a dollar figure and a positive SF, then divided — an intensity over the SF actually covered, not the
// rollup's whole footprint. coveredSf is returned so callers can disclose partial coverage.
//
// A key is EXCLUDED (never guessed) when its current report has no SF > 0 (reported via loadPcaCapexCoverage's
// excludedByProperty so the engine can say so), when a portfolio-scope key would overlap its sibling building
// keys, or when it has neither an immediate nor a short-term figure (narrative-only / letter reports). Reserves are deliberately not used: they are
// 10–12-year replacement estimates, not an improve-decision cost.
//
// FAIL-OPEN to an empty map when migration 035 is absent or the ledger is empty/unreadable: the engine
// then runs on its pre-existing proxy unchanged. Read errors are logged, never thrown (this runs inside
// the allocation route, which must not 500 on an optional enrichment).
//
// PURE READ. NOT NOI, and never aggregated with Spine A/B NOI (CLAUDE.md §1).
import type { WarehouseDb } from './db';
import { buildPropertyConditionReport } from './property-condition';

export interface PcaNearTermCapex {
  /** property_master id this entry is keyed by. */
  propertyId: string;
  /** (Σ immediate + short-term $) ÷ (Σ SF), over the covered keys. Always finite and ≥ 0. */
  psf: number;
  dollars: number;
  /** SF the covered reports describe (may be less than the property's full footprint). */
  coveredSf: number;
  reportIds: string[];
  /** Oldest of the covered reports' dates (YYYY[-MM[-DD]]), null if any covered report is undated. */
  oldestReportDate: string | null;
  /** True when any covered report is a draft or limited-reliance document. */
  anyDraftOrLimited: boolean;
}

function tableExists(db: WarehouseDb, name: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}

/** A current report the loader could not use, kept so callers can disclose it instead of implying "no PCA". */
export interface PcaExclusion {
  reportId: string;
  reason: 'no-sf' | 'portfolio-overlap';
  /** Near-term dollars (immediate + short-term) the excluded report calls for. */
  dollars: number;
}

export interface PcaCapexCoverage {
  byProperty: ReadonlyMap<string, PcaNearTermCapex>;
  /** property_master id → current reports with near-term dollars that were NOT used in psf. */
  excludedByProperty: ReadonlyMap<string, PcaExclusion[]>;
}

/** Portfolio-scope keys (e.g. 'sepich-portfolio') describe the same buildings as their sibling building keys. */
const isPortfolioKey = (propertyKey: string): boolean => /portfolio/i.test(propertyKey);

/**
 * property_master id → near-term PCA capex intensity, plus what was excluded and why. Empty (never throws)
 * when unavailable. `asOf` is normalized to its date part; a value that is still not a date fails open.
 */
export function loadPcaCapexCoverage(db: WarehouseDb, asOf: string): PcaCapexCoverage {
  const out = new Map<string, PcaNearTermCapex>();
  const excluded = new Map<string, PcaExclusion[]>();
  try {
    if (!tableExists(db, 'pca_reports')) return { byProperty: out, excludedByProperty: excluded };
    const report = buildPropertyConditionReport(db, asOf.slice(0, 10));
    if (!report.loaded) return { byProperty: out, excludedByProperty: excluded };

    type Acc = { dollars: number; sf: number; ids: string[]; dates: Array<string | null>; flagged: boolean };
    const acc = new Map<string, Acc>();
    const withDollars = report.properties.filter(
      (p) => p.propertyMasterId !== null && (p.current.immediateUsd !== null || p.current.shortTermUsd !== null),
    );
    const note = (id: string, x: PcaExclusion): void => {
      excluded.set(id, [...(excluded.get(id) ?? []), x]);
    };
    for (const p of withDollars) {
      const id = p.propertyMasterId as string;
      const c = p.current;
      const dollars = (c.immediateUsd ?? 0) + (c.shortTermUsd ?? 0);
      if (c.sf === null || !(c.sf > 0)) {
        note(id, { reportId: c.reportId, reason: 'no-sf', dollars });
        continue;
      }
      // A portfolio-wide report and its building reports cover the same space: summing them double-counts.
      // Building-level reports win; the portfolio report is used only when it is the sole coverage.
      const hasBuildingSibling = withDollars.some(
        (q) => q !== p && q.propertyMasterId === id && !isPortfolioKey(q.propertyKey) && (q.current.sf ?? 0) > 0,
      );
      if (isPortfolioKey(p.propertyKey) && hasBuildingSibling) {
        note(id, { reportId: c.reportId, reason: 'portfolio-overlap', dollars });
        continue;
      }
      const entry = acc.get(id) ?? { dollars: 0, sf: 0, ids: [], dates: [], flagged: false };
      entry.dollars += dollars;
      entry.sf += c.sf;
      entry.ids.push(c.reportId);
      entry.dates.push(c.reportDate);
      entry.flagged = entry.flagged || c.usabilityClass === 'draft' || c.usabilityClass === 'limited';
      acc.set(id, entry);
    }

    for (const [propertyId, e] of acc) {
      const psf = e.dollars / e.sf;
      // psf 0 cannot move the gate; leaving it out keeps the engine, reason text and calibration digest in agreement.
      if (!Number.isFinite(psf) || !(psf > 0)) continue;
      const dated = e.dates.filter((d): d is string => d !== null);
      out.set(propertyId, {
        propertyId,
        psf,
        dollars: e.dollars,
        coveredSf: e.sf,
        reportIds: [...e.ids].sort(),
        oldestReportDate: dated.length === e.dates.length ? [...dated].sort()[0] ?? null : null,
        anyDraftOrLimited: e.flagged,
      });
    }
  } catch (err) {
    console.warn(`[pca-capex] PCA near-term capex unavailable — engine falls back to its proxy: ${err instanceof Error ? err.message : String(err)}`);
    out.clear();
    excluded.clear();
  }
  return { byProperty: out, excludedByProperty: excluded };
}

/** property_master id → near-term PCA capex intensity. Empty (never throws) when unavailable. */
export function loadPcaNearTermCapex(db: WarehouseDb, asOf: string): ReadonlyMap<string, PcaNearTermCapex> {
  return loadPcaCapexCoverage(db, asOf).byProperty;
}
