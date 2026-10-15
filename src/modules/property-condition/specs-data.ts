/// <reference types="vite/client" />
// src/modules/property-condition/specs-data.ts
//
// Loads the committed building-spec extractions (data/building-specs/*) and stamps them with each report's vintage.
// The per-report extraction files are lazy chunks (import.meta.glob, not eager) so the ~700 KB of facts is only
// fetched when the Building specs view opens. UNREADABLE reports contribute no rows and render as such.
import { useQuery } from '@tanstack/react-query';
import {
  RawExtraction,
  ReportMeta,
  Resolution,
  coverageSummary,
  stampReport,
  type CoverageRow,
  type FindingT,
  type ReportMetaT,
  type ResolutionT,
  type SpecFactT,
} from '@/analytics/building-specs';
import reportsRaw from '../../../data/building-specs/reports.json';
import resolutionsRaw from '../../../data/building-specs/resolutions.json';

const loaders = import.meta.glob('../../../data/building-specs/extractions/*.json', { import: 'default' }) as Record<string, () => Promise<unknown>>;

export interface BuildingSpecsModel {
  metas: ReportMetaT[];
  facts: SpecFactT[];
  findings: FindingT[];
  resolutions: ResolutionT[];
  coverage: CoverageRow[];
}

export async function loadBuildingSpecs(): Promise<BuildingSpecsModel> {
  const metas = (reportsRaw as unknown[]).map((m) => ReportMeta.parse(m));
  const resolutions = (resolutionsRaw as unknown[]).map((r) => Resolution.parse(r));
  const byId = new Map<string, () => Promise<unknown>>();
  for (const [path, load] of Object.entries(loaders)) {
    const id = /\/([^/]+)\.json$/.exec(path)?.[1];
    if (id) byId.set(id, load);
  }
  const stamped = await Promise.all(
    metas.map(async (m) => {
      const load = byId.get(m.report_id);
      if (m.status === 'UNREADABLE') return { facts: [] as SpecFactT[], findings: [] as FindingT[] };
      if (!load) throw new Error(`building specs: report ${m.report_id} is ${m.status} but data/building-specs/extractions/${m.report_id}.json is missing`);
      return stampReport(m, RawExtraction.parse(await load()));
    }),
  );
  return {
    metas,
    facts: stamped.flatMap((s) => s.facts),
    findings: stamped.flatMap((s) => s.findings),
    resolutions,
    coverage: coverageSummary(metas, stamped),
  };
}

export function useBuildingSpecs(enabled: boolean) {
  return useQuery({ queryKey: ['property-condition', 'building-specs'], queryFn: loadBuildingSpecs, enabled, staleTime: Infinity });
}
