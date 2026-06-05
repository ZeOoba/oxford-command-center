import { useQuery } from '@tanstack/react-query';

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
