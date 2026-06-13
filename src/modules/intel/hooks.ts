// src/modules/intel/hooks.ts
//
// TanStack Query hooks + pure response-shaping helpers for the Property Financial
// Intelligence module. All fetches hit the relative /api/warehouse/* routes (Task 3).
// On the deployed static mirror those routes are absent (a 503 from the brain server, or
// the SPA index.html served for an unknown path → non-JSON), so `fetchJson` throws a
// typed WarehouseUnavailableError and the module renders an informational empty state
// instead of crashing. Patterns mirror src/data/queries.ts (staleTime 30s, retry 1).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Classification } from '@contracts/warehouse';

// ---------------------------------------------------------------------------
// Response shapes — mirror the hand-aliased camelCase rows from server/warehouse.
// ---------------------------------------------------------------------------

export interface ImportSummary {
  id: number;
  fileName: string;
  propertyId: string | null;
  propertyName: string | null;
  period: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  grain: string | null;
  basis: string;
  sourceSystem: string;
  version: number;
  status: string;
  confidence: number | null;
  importedAt: string;
}

export interface LedgerRowView {
  rawAccount: string;
  glCode: string | null;
  amount: number;
  normalizedCategory: string;
  classification: string;
  isActive: boolean;
}

export interface IssueView {
  id: number;
  kind: string;
  detail: string;
  severity: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface WarehouseIssue extends IssueView {
  importId: number | null;
  fileName: string | null;
  propertyId: string | null;
  propertyName: string | null;
}

export interface ImportDetail extends ImportSummary {
  rows: LedgerRowView[];
  issues: IssueView[];
}

export interface NoiMatrixCell {
  propertyId: string;
  propertyName: string | null;
  period: string;
  noi: number;
}

export type ApproveResult = { ok: true } | { ok: false; unmapped: string[]; error?: string };
export type SimpleResult = { ok: true } | { ok: false; error?: string };
export interface AddMappingResult {
  mappingId: number;
  rederived: number;
}

export interface AddMappingInput {
  account: string;
  normalizedCategory: string;
  classification: Classification;
  propertyId?: string;
}

// ---------------------------------------------------------------------------
// Shared fetch — typed unavailability on the static mirror.
// ---------------------------------------------------------------------------

/** Thrown when the warehouse routes are absent (mirror) or report 503. Hooks surface
 *  this as `isUnavailable` so the module degrades to an informational empty state. */
export class WarehouseUnavailableError extends Error {
  constructor(message = 'warehouse unavailable') {
    super(message);
    this.name = 'WarehouseUnavailableError';
  }
}

/** True when a query error is the warehouse-unavailable sentinel. */
export function isWarehouseUnavailable(error: unknown): boolean {
  return error instanceof WarehouseUnavailableError;
}

async function readJson<T>(res: Response): Promise<T> {
  // The static mirror serves the SPA index.html for unknown paths; a 503 from the brain
  // server carries JSON but still means "no warehouse here". Either way → unavailable.
  if (res.status === 503) throw new WarehouseUnavailableError();
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new WarehouseUnavailableError('warehouse routes not present');
  return (await res.json()) as T;
}

/** Shared GET → typed JSON. Exported so analytics-hooks.ts reuses the SAME unavailability
 *  semantics (503 / non-JSON mirror) rather than duplicating the fetch path. */
export async function fetchJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    throw new WarehouseUnavailableError('brain server offline');
  }
  if (!res.ok && res.status !== 503) {
    // A 4xx/5xx with a JSON error body is a real failure to surface; non-JSON is mirror.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) throw new WarehouseUnavailableError('warehouse routes not present');
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return readJson<T>(res);
}

/** Read-then-act POST: returns the parsed JSON regardless of HTTP status (the caller
 *  inspects `ok`); a 409 approve refusal carries the unmapped list, not an Error. */
async function postJson<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new WarehouseUnavailableError('brain server offline');
  }
  return readJson<T>(res);
}

// ---------------------------------------------------------------------------
// Query keys.
// ---------------------------------------------------------------------------

export const WAREHOUSE_KEYS = {
  imports: ['warehouse', 'imports'] as const,
  importDetail: (id: number) => ['warehouse', 'imports', id] as const,
  issues: ['warehouse', 'issues'] as const,
  noi: ['warehouse', 'noi'] as const,
};

/** Shared query options (staleTime 30s, retry 1). Exported for analytics-hooks.ts reuse. */
export const QUERY_OPTS = { staleTime: 30_000, retry: 1 } as const;

// ---------------------------------------------------------------------------
// Read hooks.
// ---------------------------------------------------------------------------

export function useWarehouseImports() {
  return useQuery({
    queryKey: WAREHOUSE_KEYS.imports,
    queryFn: () => fetchJson<{ imports: ImportSummary[] }>('/api/warehouse/imports').then((r) => r.imports),
    ...QUERY_OPTS,
  });
}

export function useImportDetail(id: number | null) {
  return useQuery({
    queryKey: id === null ? ['warehouse', 'imports', 'none'] : WAREHOUSE_KEYS.importDetail(id),
    queryFn: () => fetchJson<ImportDetail>(`/api/warehouse/imports/${id}`),
    enabled: id !== null,
    ...QUERY_OPTS,
  });
}

export function useWarehouseIssues() {
  return useQuery({
    queryKey: WAREHOUSE_KEYS.issues,
    queryFn: () => fetchJson<{ issues: WarehouseIssue[] }>('/api/warehouse/issues').then((r) => r.issues),
    ...QUERY_OPTS,
  });
}

export function useNoiMatrix() {
  return useQuery({
    queryKey: WAREHOUSE_KEYS.noi,
    queryFn: () => fetchJson<{ matrix: NoiMatrixCell[] }>('/api/warehouse/noi').then((r) => r.matrix),
    ...QUERY_OPTS,
  });
}

// ---------------------------------------------------------------------------
// Mutations — invalidate imports + noi + issues on success (an approve/reject/mapping
// change can move ledger rows in or out of the active NOI set and resolve issues).
// Also drops the ['warehouse','analytics'] prefix so every analytics query (scores,
// metrics, growth, anomalies, pm, benchmarks, drivers) refetches — an approve/override
// re-derives the active ledger set the score engine reads from (pre-mortem #4).
// ---------------------------------------------------------------------------

function useWarehouseInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: WAREHOUSE_KEYS.imports });
    void qc.invalidateQueries({ queryKey: WAREHOUSE_KEYS.noi });
    void qc.invalidateQueries({ queryKey: WAREHOUSE_KEYS.issues });
    void qc.invalidateQueries({ queryKey: ['warehouse', 'analytics'] });
  };
}

export function useImportAction() {
  const invalidate = useWarehouseInvalidate();
  return useMutation({
    mutationFn: (v: { id: number; action: 'approve' | 'reject' }) =>
      postJson<ApproveResult | SimpleResult>(`/api/warehouse/imports/${v.id}/action`, { action: v.action }),
    onSuccess: invalidate,
  });
}

export function useAddMapping() {
  const invalidate = useWarehouseInvalidate();
  return useMutation({
    mutationFn: (input: AddMappingInput) => postJson<AddMappingResult>('/api/warehouse/mappings', input),
    onSuccess: invalidate,
  });
}

export function useResolveIssue() {
  const invalidate = useWarehouseInvalidate();
  return useMutation({
    mutationFn: (id: number) => postJson<SimpleResult>(`/api/warehouse/issues/${id}/resolve`),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Pure response-shaping helpers (unit-tested).
// ---------------------------------------------------------------------------

export interface NoiPropertyRow {
  propertyId: string;
  /** Display name; falls back to the property id when the master row has no name. */
  propertyName: string;
  /** period → NOI. A missing period has no key (renders em-dash, never 0). */
  byPeriod: Record<string, number>;
}

export interface NoiGrouped {
  /** Distinct periods across all properties, ascending — the table's columns. */
  periods: string[];
  /** One row per property, sorted by display name (id fallback). */
  rows: NoiPropertyRow[];
}

/** Pivot the flat (property, period, noi) matrix into one row per property with a
 *  period→noi map, plus the sorted union of periods used as table columns. */
export function groupNoiByProperty(matrix: NoiMatrixCell[]): NoiGrouped {
  const periodSet = new Set<string>();
  const byId = new Map<string, NoiPropertyRow>();

  for (const cell of matrix) {
    periodSet.add(cell.period);
    let row = byId.get(cell.propertyId);
    if (!row) {
      row = { propertyId: cell.propertyId, propertyName: cell.propertyName ?? cell.propertyId, byPeriod: {} };
      byId.set(cell.propertyId, row);
    }
    row.byPeriod[cell.period] = cell.noi;
  }

  const periods = [...periodSet].sort((a, b) => a.localeCompare(b));
  const rows = [...byId.values()].sort(
    (a, b) => a.propertyName.localeCompare(b.propertyName) || a.propertyId.localeCompare(b.propertyId),
  );
  return { periods, rows };
}
