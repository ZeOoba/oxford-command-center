import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

/** GET /api/documents — the RAG corpus status the Brain Server reports (mirror: no server → offline). */
export const DocStatus = z.object({
  configured: z.boolean(),
  dir: z.string().nullable(),
  documents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  docs: z.array(z.object({ name: z.string(), chunks: z.number().int().nonnegative() })),
});
export type DocStatus = z.infer<typeof DocStatus>;

/** Typed fetch for the corpus status; rejects (→ "offline") on no server OR on a payload that
 *  drifted from the contract, so shape drift never reaches the UI as a silent NaN/undefined. */
export async function fetchDocStatus(fetchImpl: typeof fetch = fetch): Promise<DocStatus> {
  const res = await fetchImpl('/api/documents');
  if (!res.ok) throw new Error('no server');
  return DocStatus.parse(await res.json());
}

export interface DocSearchHit { doc: string; snippet: string; score: number; docId: string; chunkIdx: number; }

async function fetchDocSearch(q: string): Promise<DocSearchHit[]> {
  if (!q.trim()) return [];
  const res = await fetch(`/api/documents/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error('Search unavailable (Brain Server only).');
  const json = (await res.json()) as { hits?: DocSearchHit[] };
  return json.hits ?? [];
}

export function useDocSearch(query: string) {
  return useQuery({
    queryKey: ['doc-search', query],
    queryFn: () => fetchDocSearch(query),
    enabled: query.trim().length > 2,
    staleTime: 60_000,
  });
}
