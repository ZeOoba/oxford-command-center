// src/modules/acquisitions/hooks.ts
//
// Data hooks for the Acquisition Intelligence module (Phase 4, Step 7).
// Fetches from the shipped GET /acq/intel + GET /acq/candidates + PATCH status routes.
// Reuses the Intel module's fetch infrastructure (fetchParsedOrMirror, QUERY_OPTS).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AcqIntelResponse, AcqCandidateRow } from '@contracts/acquisition';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';

const ACQ_KEYS = {
  intel:      (s?: string, m?: string, v?: string, l?: number) =>
    ['warehouse', 'acq', 'intel', s ?? '', m ?? '', v ?? '', l ?? 0] as const,
  candidates: (s?: string) =>
    ['warehouse', 'acq', 'candidates', s ?? ''] as const,
};

export function useAcqIntel(
  status?: string,
  market?: string,
  verdict?: string,
  limit?: number,
) {
  return useQuery({
    queryKey: ACQ_KEYS.intel(status, market, verdict, limit),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (status)  qs.set('status',  status);
      if (market)  qs.set('market',  market);
      if (verdict) qs.set('verdict', verdict);
      if (limit)   qs.set('limit',   String(limit));
      const q = qs.toString();
      return fetchParsedOrMirror(
        `/api/warehouse/acq/intel${q ? `?${q}` : ''}`,
        AcqIntelResponse,
      );
    },
    ...QUERY_OPTS,
  });
}

const CandidatesResponse = z.object({ candidates: z.array(AcqCandidateRow) });

export function useAcqCandidates(status?: string) {
  return useQuery({
    queryKey: ACQ_KEYS.candidates(status),
    queryFn: () => {
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      return fetchParsedOrMirror(
        `/api/warehouse/acq/candidates${qs}`,
        CandidatesResponse,
      ).then((r) => r.candidates);
    },
    ...QUERY_OPTS,
  });
}

export function useSetCandidateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      candidateId: string;
      status: 'active' | 'archived' | 'acquired' | 'passed';
    }) => {
      const res = await fetch(
        `/api/warehouse/acq/candidates/${encodeURIComponent(v.candidateId)}/status`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: v.status }),
        },
      );
      const payload = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? `Failed to update candidate status (${res.status})`);
      }
      return payload;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['warehouse', 'acq'] });
    },
  });
}
