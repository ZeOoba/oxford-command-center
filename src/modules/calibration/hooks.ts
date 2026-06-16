// src/modules/calibration/hooks.ts
//
// TanStack Query hooks over the /api/warehouse/calibration/* routes (the 40-year feedback loop's
// read + manual-resolution write surface). Reuses fetchJson / QUERY_OPTS / WarehouseUnavailableError
// from the intel module's hooks.ts — NO duplicate fetch logic. Every READ crosses a Zod schema from
// src/contracts/warehouse.ts (the SAME schemas the server .parse()s before c.json — the H6 read
// boundary); the resolve WRITE validates its body against CalibrationResolveRequestSchema before POST.
//
// On the static mirror (or a cold/headless brain) the calibration routes 503 / serve non-JSON →
// fetchJson throws WarehouseUnavailableError → the panel degrades to the offline Card, never crashes.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  fetchJson, fetchParsedOrMirror, isWarehouseUnavailable, QUERY_OPTS, WarehouseUnavailableError,
} from '../intel/hooks';
import { loadWarehouseMirror, getMirrorEndpoint, filterCalibrationLogRows } from '../../lib/warehouse-mirror';
import {
  CalibrationLogResponseSchema,
  CalibrationPendingResponseSchema,
  CalibrationReportSchema,
  CalibrationResolveRequestSchema,
  CalibrationResolveResponseSchema,
} from '@contracts/warehouse';
import type {
  CalibrationLogRow,
  CalibrationReportResponse,
  CalibrationResolveRequest,
  CalibrationResolveResponse,
  VerdictKind,
} from '@contracts/warehouse';

export type { CalibrationLogRow, CalibrationReportResponse, CalibrationResolveRequest } from '@contracts/warehouse';

/** Fetch a route then .parse() its body through the contract schema (client half of the H6 boundary).
 *  Delegates to fetchParsedOrMirror: live-first, then the Fat-Mirror precomputed payload on a 503 /
 *  non-JSON mirror (Phase 1b). Used for the pending + report reads (whole-payload keys). */
async function fetchParsed<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
  return fetchParsedOrMirror(path, schema);
}

/**
 * Calibration LOG read with the Fat-Mirror fallback. The bake stores only the UNFILTERED log (filter
 * combos are open-ended), so on the mirror we fetch that one baked payload and re-apply the filter
 * client-side via filterCalibrationLogRows (pure row selection mirroring the server WHERE — NOT engine
 * math). The live path keeps server-side filtering. A real live parse failure is NOT swallowed.
 */
async function fetchCalibrationLogOrMirror(query: CalibrationLogQuery): Promise<CalibrationLogRow[]> {
  const { subject = null, kind = null, status = null } = query;
  const qs = new URLSearchParams();
  if (subject) qs.set('subject', subject);
  if (kind) qs.set('kind', kind);
  if (status) qs.set('status', status);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  try {
    return CalibrationLogResponseSchema.parse(
      await fetchJson<unknown>(`/api/warehouse/calibration/log${suffix}`),
    ).log;
  } catch (e) {
    if (!isWarehouseUnavailable(e)) throw e;
    const env = await loadWarehouseMirror();
    if (!env) throw e;
    const payload = getMirrorEndpoint(env, '/api/warehouse/calibration/log');
    if (payload === undefined) throw new WarehouseUnavailableError('calibration log not in baked mirror');
    return filterCalibrationLogRows(CalibrationLogResponseSchema.parse(payload).log, { subject, kind, status });
  }
}

export const CALIBRATION_KEYS = {
  log: (subject: string | null, kind: string | null, status: string | null) =>
    ['warehouse', 'calibration', 'log', subject ?? '', kind ?? '', status ?? ''] as const,
  pending: ['warehouse', 'calibration', 'pending'] as const,
  report: ['warehouse', 'calibration', 'report'] as const,
};

export interface CalibrationLogQuery {
  subject?: string | null;
  kind?: VerdictKind | null;
  status?: 'open' | 'resolved' | null;
}

/** The verdict log, filterable by subject / kind / open|resolved. Empty [] on a no-verdict warehouse. */
export function useCalibrationLog(query: CalibrationLogQuery = {}) {
  const { subject = null, kind = null, status = null } = query;
  return useQuery({
    queryKey: CALIBRATION_KEYS.log(subject, kind, status),
    queryFn: () => fetchCalibrationLogOrMirror({ subject, kind, status }),
    ...QUERY_OPTS,
  });
}

/** The pending-resolution queue: verdicts whose horizon is due but unresolved. Empty [] normally. */
export function useCalibrationPending() {
  return useQuery({
    queryKey: CALIBRATION_KEYS.pending,
    queryFn: () =>
      fetchParsed('/api/warehouse/calibration/pending', CalibrationPendingResponseSchema).then((r) => r.pending),
    ...QUERY_OPTS,
  });
}

/** The aggregated §4 report. Zeroed counts + null rates (never NaN) on an empty dataset. */
export function useCalibrationReport() {
  return useQuery({
    queryKey: CALIBRATION_KEYS.report,
    queryFn: (): Promise<CalibrationReportResponse> =>
      fetchParsed('/api/warehouse/calibration/report', CalibrationReportSchema),
    ...QUERY_OPTS,
  });
}

/** Read-then-act POST: returns the parsed JSON regardless of HTTP status; the caller inspects `ok`.
 *  A 4xx (404 bad id / 400 bad body / 422 grain rule) carries a JSON {error}; surfaced as a thrown
 *  Error so the mutation's onError can show it. */
async function postResolve(id: number, body: CalibrationResolveRequest): Promise<CalibrationResolveResponse> {
  let res: Response;
  try {
    res = await fetch(`/api/warehouse/calibration/${id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new WarehouseUnavailableError('brain server offline');
  }
  if (res.status === 503) throw new WarehouseUnavailableError();
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new WarehouseUnavailableError('warehouse routes not present');
  const json = (await res.json()) as CalibrationResolveResponse | { error?: string };
  if (!res.ok) throw new Error(('error' in json && json.error) || `resolve failed (${res.status})`);
  return CalibrationResolveResponseSchema.parse(json);
}

/** Record a manual resolution (the ONLY calibration write). Validates the body against the contract
 *  before POST (confirm-before-write happens in the UI). On success invalidates the log/pending/report
 *  queries so the panel reflects the new outcome. */
export function useResolveVerdict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; body: CalibrationResolveRequest }) => {
      // Validate at the call boundary too — a malformed body never reaches the network.
      const parsed = CalibrationResolveRequestSchema.parse(vars.body);
      return postResolve(vars.id, parsed);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['warehouse', 'calibration'] });
    },
  });
}
