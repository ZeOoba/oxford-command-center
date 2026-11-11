// src/modules/property-condition/pca-overlay.ts
//
// Curated PCA facts that the 2026-10-06 extraction register (v01_2) does not carry or carries wrongly,
// each with provenance IN THE DATA (source_file / source_date / price_basis / status). Seeded from the
// 2026-10-13 PCA Command Center report; the register + underlying PCR remain the source of record — every
// divergence is listed in PCA_RECONCILIATION.md. Nothing here is invented: a field a source does not state
// is null and renders "n/a".
//
// The curated tables are real firm data, so they live in the gitignored operator table
// config/local/pca-overlay.json (ruling 2026-11-10: real firm data is never tracked; a real-data manifest
// path with a synthetic stand-in under fixtures/synthetic/, seeded for CI and tests). On the operator
// machine it is rebuilt from the pre-untrack commit by scripts/extract-local-tables.ts.
//
// This file is display data only. It feeds no scoring, governor, DSCR/LTV or capital-allocation path.
import type { PcaOverlay, Provenance } from '@/analytics/pca-intelligence';
import table from '../../../config/local/pca-overlay.json';

/** Derived from the live ledger counts (never a stored "n=1"): adding an observation is a data change only. */
export function calibrationLabel(counts: number[]): string {
  const ns = counts.filter((n) => n > 0);
  const nPart = ns.length === 0 ? 'no countable observations' : Math.min(...ns) === Math.max(...ns) ? `n=${ns[0]} each` : `n=${Math.min(...ns)}–${Math.max(...ns)} per component`;
  return `PCA consultant estimate vs contractor quote; ${nPart}; directional only below n=5`;
}

export interface InfoLaneDetail {
  propertyKey: string;
  label: string;
  sf: number;
  provenance: Provenance;
  facts: Array<{ label: string; value: string }>;
  immediateUsd: number;
  immediateItems: Array<{ item: string; usd: number }>;
  shortTermUsd: number;
  reservesUninflUsd: number;
  reservesInflUsd: number;
  termYears: number;
  /** Uninflated reserve outlays by year. yr1 / yr2 are RESERVE outlays — never Immediate / Short-term. */
  reserveScheduleUninfl: Record<'yr1' | 'yr2' | 'yr6' | 'yr7' | 'yr10' | 'yr11', number>;
  systems: Array<{ system: string; usd: number }>;
  unitCosts: Array<{ item: string; usd: number; uom: string }>;
  conflicts: Array<{ text: string; speculative: boolean }>;
  correctionNote: string;
  rentRoll: {
    asOf: string;
    leases: number;
    baseRentUsd: number;
    baseRentPsf: number;
    waltYears: number;
    nnnLeases: number;
    grossLeases: number;
    rolloverSfByLeaseEndYear: Record<string, number>;
  };
}

export interface ExtraAssetFact {
  propertyKey: string;
  propertyLabel: string;
  component: string;
  installYear: number | null;
  eul: number | null;
  rul: number | null;
  rulAsOfYear: number | null;
  warrantyEndYear: number | null;
  note: string | null;
  /** Register component text this row replaces (matched by startsWith) so the clock never lists a roof twice. */
  supersedes: string | null;
  /** The register's own property_key for the row being replaced (it can differ from propertyKey). */
  supersedesPropertyKey?: string;
  provenance: Provenance;
}

export interface PcaIssue {
  no: number;
  property: string;
  title: string;
  detail: string;
  status: 'Open';
  owner: string;
}

/** The operator table's shape (config/local/pca-overlay.json). */
export interface PcaOverlayTable {
  overlay: PcaOverlay;
  infoLaneDetail: InfoLaneDetail;
  extraAssetFacts: ExtraAssetFact[];
  issues: PcaIssue[];
}

const T = table as unknown as PcaOverlayTable;

export const PCA_OVERLAY: PcaOverlay = T.overlay;
export const INFO_LANE_DETAIL: InfoLaneDetail = T.infoLaneDetail;
export const EXTRA_ASSET_FACTS: ExtraAssetFact[] = T.extraAssetFacts;
export const PCA_ISSUES: PcaIssue[] = T.issues;
