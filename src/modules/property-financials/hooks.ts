// src/modules/property-financials/hooks.ts
//
// Property Financials client layer (plan T5): TanStack Query hooks over the read-only API mounted at
// /api/warehouse/property-financials (server/property-financials/property-financials-api.ts).
//
// fetchJson only — never the Fat-Mirror fallback: these routes are deliberately NOT baked (firm
// financials, same stance as /edge), so on the static mirror fetchJson throws
// WarehouseUnavailableError and the module says it is local-only. The dataset is re-validated here
// through the strict contract parser, so a server/client drift fails loud instead of rendering junk.
// The one mutation (PUT insight-status) carries the X-ORA-Client header (server/host-guard.ts).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parsePropertyFinancialsDataset } from '@contracts/property-financials';
import { ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';
import { fetchJson, isWarehouseUnavailable, QUERY_OPTS } from '../intel/hooks';
import type {
  PfAvailability,
  PfDatasetResponse,
  PfInsightStatusBody,
  PfInsightStatusRecord,
  PfInsightStatusResponse,
  PfMappingResponse,
  PfMappingRow,
} from './types';

export const PF_API = '/api/warehouse/property-financials';

export const PF_KEYS = {
  dataset: ['warehouse', 'property-financials', 'dataset'] as const,
  mapping: ['warehouse', 'property-financials', 'mapping'] as const,
  insightStatus: ['warehouse', 'property-financials', 'insight-status'] as const,
};

const AVAILABILITY: readonly PfAvailability[] = ['ok', 'missing', 'unreadable', 'invalid'];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Validate the GET /dataset envelope; the dataset itself goes through the strict contract parser. */
export function parseDatasetResponse(raw: unknown): PfDatasetResponse {
  if (!isRecord(raw)) throw new Error('property-financials: dataset response is not an object');
  const availability = raw.availability as PfAvailability;
  if (!AVAILABILITY.includes(availability)) throw new Error('property-financials: unknown availability');
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((i): i is string => typeof i === 'string') : [];
  return {
    availability,
    readError: str(raw.readError),
    lastGoodLoadedAt: str(raw.lastGoodLoadedAt),
    issues,
    meta: isRecord(raw.meta) ? (raw.meta as unknown as PfDatasetResponse['meta']) : null,
    dataset: raw.dataset === null || raw.dataset === undefined ? null : parsePropertyFinancialsDataset(raw.dataset),
  };
}

const MAPPING_METHODS: ReadonlySet<string> = new Set(['exact', 'inferred', 'unmatched']);

/**
 * Validate the GET /mapping envelope (server-defined shape, no contract export): a malformed body
 * fails loud — the panel shows an error rather than an empty or half-read table.
 */
export function parseMappingResponse(raw: unknown): PfMappingResponse {
  if (!isRecord(raw) || !Array.isArray(raw.rows)) throw new Error('property-financials: mapping response is malformed');
  const availability = raw.availability as PfAvailability;
  if (!AVAILABILITY.includes(availability)) throw new Error('property-financials: unknown mapping availability');
  const rows = raw.rows.map((r, i): PfMappingRow => {
    const bad = () => new Error(`property-financials: mapping row ${i} is malformed`);
    if (!isRecord(r) || typeof r.entity !== 'string' || !(r.canonicalId === null || typeof r.canonicalId === 'string')) throw bad();
    if (typeof r.method !== 'string' || !MAPPING_METHODS.has(r.method) || !Array.isArray(r.flags)) throw bad();
    const flags = r.flags.map((f) => {
      if (!isRecord(f) || typeof f.code !== 'string' || typeof f.detail !== 'string') throw bad();
      return {
        code: f.code,
        detail: f.detail,
        ...(typeof f.datasetSf === 'number' ? { datasetSf: f.datasetSf } : {}),
        ...(typeof f.masterSf === 'number' ? { masterSf: f.masterSf } : {}),
      };
    });
    return { entity: r.entity, canonicalId: r.canonicalId, method: r.method as PfMappingRow['method'], flags };
  });
  return { availability, rows };
}

/** One retry for a real failure; none when the Brain Server is absent (mirror / server down). */
function retryUnlessUnavailable(failureCount: number, error: unknown): boolean {
  return !isWarehouseUnavailable(error) && failureCount < 1;
}

export function usePfDataset() {
  return useQuery({
    queryKey: PF_KEYS.dataset,
    queryFn: async () => parseDatasetResponse(await fetchJson<unknown>(`${PF_API}/dataset`)),
    staleTime: 5 * 60_000,
    retry: retryUnlessUnavailable,
  });
}

export function usePfMapping(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: PF_KEYS.mapping,
    queryFn: async () => parseMappingResponse(await fetchJson<unknown>(`${PF_API}/mapping`)),
    staleTime: 5 * 60_000,
    retry: retryUnlessUnavailable,
    enabled: opts.enabled ?? true,
  });
}

export function usePfInsightStatuses() {
  return useQuery({
    queryKey: PF_KEYS.insightStatus,
    queryFn: async () => fetchJson<PfInsightStatusResponse>(`${PF_API}/insight-status`),
    ...QUERY_OPTS,
    retry: retryUnlessUnavailable,
  });
}

/** PUT one insight's workflow state; the stored record replaces the cached one on success. */
export function useSaveInsightStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: PfInsightStatusBody }): Promise<PfInsightStatusRecord> => {
      let res: Response;
      try {
        res = await fetch(`${PF_API}/insight-status/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: ORA_JSON_MUTATION_HEADERS,
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error('The Brain Server is not reachable. Changes are local-only and need it running.');
      }
      const payload = (await res.json().catch(() => ({}))) as unknown;
      if (res.status >= 500) throw new Error('The server could not save that change. Try again shortly.');
      if (!res.ok) {
        const err = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `Save failed (${res.status})`;
        throw new Error(err);
      }
      return payload as PfInsightStatusRecord;
    },
    onSuccess: (record) => {
      qc.setQueryData<PfInsightStatusResponse>(PF_KEYS.insightStatus, (prev) => {
        const records = (prev?.records ?? []).filter((r) => r.insightId !== record.insightId);
        return { records: [...records, record], orphanedIds: prev?.orphanedIds ?? [] };
      });
      void qc.invalidateQueries({ queryKey: PF_KEYS.insightStatus });
    },
  });
}
