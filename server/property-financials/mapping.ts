// server/property-financials/mapping.ts
//
// Entity → canonical property id table (plan T4, "one-page mapping deliverable"). The dataset names
// its 11 entities by short labels ("1100 Rarig", "FVC"); the firm's canonical ids live in
// server/warehouse/property-master.ts CANON_PROPERTIES. This module READS that array (never writes
// it, never touches the property_master table) and reports:
//   - method 'exact'     — the entity is one property, matched by address in the ratified table below
//   - method 'inferred'  — matched by reconciliation, not by a property-level export (FVC → Sepich)
//   - method 'unmatched' — no ratified entry, or the ratified id is absent from the master
// plus flags: UNMATCHED, FVC_SEPICH_MAPPING_INFERRED (from the dataset's own sf.FVC.note via
// fvcSepichMappingFlag), and SF_MISMATCH where dataset sf.<entity>.sf ≠ master rentableSf (computed,
// shown as a flag, never written back to either side).
//
// 2203-2207 Northwood is excluded from the dataset by instruction (financials pending) and is
// suppressed here even if a future input names it.
import { fvcSepichMappingFlag, FVC_MAPPING_FLAG_ID } from '../../src/analytics/property-financials/metrics';
import type { PropertyMasterRow } from '../../src/contracts/warehouse';
import { CANON_PROPERTIES } from '../warehouse/property-master';

export type PfMappingMethod = 'exact' | 'inferred' | 'unmatched';

export type PfMappingFlag =
  | { code: 'UNMATCHED'; detail: string }
  | { code: typeof FVC_MAPPING_FLAG_ID; detail: string }
  | { code: 'SF_MISMATCH'; detail: string; datasetSf: number; masterSf: number };

export interface PfMappingRow {
  entity: string;
  canonicalId: string | null;
  method: PfMappingMethod;
  flags: PfMappingFlag[];
}

/** Ratified entity → canonical id table (Gabriel, plan T4 2026-10-05). */
export const ENTITY_TO_CANONICAL: Readonly<Record<string, { id: string; method: Exclude<PfMappingMethod, 'unmatched'> }>> = {
  '1100 Rarig': { id: '1100-rarig-ave-columbus-oh', method: 'exact' },
  '1900 Broadway': { id: '1900-n-broadway-baltimore-md', method: 'exact' },
  '29000 Info Lane': { id: '29000-information-lane-easton-md', method: 'exact' },
  '3034 Westerville': { id: '3034-westerville-rd-columbus-oh', method: 'exact' },
  '3540 E 5th': { id: '3540-e-5th-ave-columbus-oh', method: 'exact' },
  '3883 Livingston': { id: '3875-3883-e-livingston-ave-columbus-oh', method: 'exact' },
  '9050 Red Branch': { id: '9050-red-branch-rd-columbia-md', method: 'exact' },
  '9620 State 350': { id: '9620-e-state-route-350-raytown-mo', method: 'exact' },
  FVC: { id: 'sepich-portfolio-columbus-oh-8-props', method: 'inferred' },
  '55 New Plant (EGFLLC)': { id: '55-new-plant-ct-owings-mills-md', method: 'exact' },
  '1851 South Club Solar': { id: '1851-s-club-solar', method: 'exact' },
};

const EXCLUDED = /northwood/i;

type SfLookup = Readonly<Partial<Record<string, { sf: number | null; note: string }>>>;

const fmtSf = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

export function buildEntityMapping(
  entities: readonly string[],
  sf: SfLookup,
  canon: readonly Pick<PropertyMasterRow, 'id' | 'rentableSf'>[] = CANON_PROPERTIES,
): PfMappingRow[] {
  const byId = new Map(canon.map((p) => [p.id, p]));
  const rows: PfMappingRow[] = [];
  for (const entity of entities) {
    if (EXCLUDED.test(entity)) continue;
    const entry = ENTITY_TO_CANONICAL[entity];
    const master = entry ? byId.get(entry.id) : undefined;
    if (!entry || !master || EXCLUDED.test(entry.id)) {
      rows.push({
        entity,
        canonicalId: null,
        method: 'unmatched',
        flags: [{ code: 'UNMATCHED', detail: entry ? 'mapped id is not in the property master' : 'no ratified mapping for this entity' }],
      });
      continue;
    }
    const flags: PfMappingFlag[] = [];
    const ds = sf[entity];
    if (entity === 'FVC') {
      const f = fvcSepichMappingFlag({ note: ds?.note ?? 'inferred' });
      if (f.active) flags.push({ code: FVC_MAPPING_FLAG_ID, detail: f.text || 'FVC → Sepich portfolio mapping is inferred; confirm.' });
    }
    const datasetSf = ds?.sf ?? null;
    const masterSf = master.rentableSf ?? null;
    if (datasetSf !== null && masterSf !== null && datasetSf !== masterSf) {
      flags.push({
        code: 'SF_MISMATCH',
        detail: `dataset ${fmtSf(datasetSf)} SF vs property master ${fmtSf(masterSf)} SF`,
        datasetSf,
        masterSf,
      });
    }
    rows.push({ entity, canonicalId: master.id, method: entry.method, flags });
  }
  return rows;
}
