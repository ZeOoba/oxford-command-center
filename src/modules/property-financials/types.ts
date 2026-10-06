// src/modules/property-financials/types.ts
//
// Client-side response types for the Property Financials read-only API
// (server/property-financials/property-financials-api.ts). The dataset itself is the contract type
// (src/contracts/property-financials.ts PfDataset); the envelope, data-health meta, insight-status
// records and mapping rows are server-defined shapes that have no contract export, so they are
// declared here TYPE-ONLY (the server modules import node:fs and cannot enter the client bundle).
// tests/unit/property-financials-insight-workflow.test.ts assigns the server types to these and back,
// so tsc fails if the two drift.
import type { PfDataset } from '@contracts/property-financials';
import type { PfLiveSfBlock } from '@analytics/property-financials/live-sf';

export type PfAvailability = 'ok' | 'missing' | 'unreadable' | 'invalid';

/** Mirrors server/property-financials/loader.ts PfDataHealthMeta. */
export interface PfDataHealthMeta {
  version: string;
  generated: string;
  as_of: string;
  basis: 'cash';
  sha256: string;
  csvSha256: string | null;
  csvError: string | null;
  ageDays: number;
  staleness: 'fresh' | 'stale';
  /** Why the dataset is stale (e.g. 'as-of date is in the future'), null when fresh. Optional: older servers omit it. */
  stalenessReason?: string | null;
}

/** GET /api/warehouse/property-financials/dataset */
export interface PfDatasetResponse {
  availability: PfAvailability;
  readError: string | null;
  lastGoodLoadedAt: string | null;
  issues: string[];
  meta: PfDataHealthMeta | null;
  dataset: PfDataset | null;
  /**
   * Live square footage from Spine A (T9b part 2; server/property-financials/live-sf.ts). Additive:
   * absent on older servers, null when the envelope carried no readable block. The preference rule
   * (live only when present, Spine A and fresh) lives in @analytics/property-financials/live-sf.
   */
  liveSf?: PfLiveSfBlock | null;
}

export type PfInsightStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';

/** Mirrors server/property-financials/status-store.ts InsightStatusRecord. */
export interface PfInsightStatusRecord {
  insightId: string;
  owner: string | null;
  dueDate: string | null;
  status: PfInsightStatus;
  dismissReason: string | null;
  updatedAt: string;
}

/** GET /api/warehouse/property-financials/insight-status */
export interface PfInsightStatusResponse {
  records: PfInsightStatusRecord[];
  orphanedIds: string[];
}

/** PUT /api/warehouse/property-financials/insight-status/:id body. */
export interface PfInsightStatusBody {
  owner: string | null;
  dueDate: string | null;
  status: PfInsightStatus;
  dismissReason: string | null;
}

/** Mirrors server/property-financials/mapping.ts PfMappingRow. */
export interface PfMappingRow {
  entity: string;
  canonicalId: string | null;
  method: 'exact' | 'inferred' | 'unmatched';
  flags: Array<{ code: string; detail: string; datasetSf?: number; masterSf?: number }>;
}

/** GET /api/warehouse/property-financials/mapping */
export interface PfMappingResponse {
  availability: PfAvailability;
  rows: PfMappingRow[];
}
