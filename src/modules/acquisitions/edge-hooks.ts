// src/modules/acquisitions/edge-hooks.ts
//
// Oxford Edge client layer (spec §8.7): TanStack Query hooks over /api/warehouse/edge/* plus the pure
// display helpers every Edge surface shares (board, data health, pull queue, deal readout, Sourcing
// column) and the deal→market resolver (Task 9 appends it to this file).
//
// fetchJson + Zod parse only. The mirror-fallback variant (fetchParsedOrMirror) is deliberately NOT
// used: nothing Edge is baked (CoStar-licensed, spec §5.4), so on the mirror fetchJson throws
// WarehouseUnavailableError and the UI says "Edge is local-only".
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EDGE_OBSERVED_STATUSES, EDGE_SERIES, EdgeMarketsResponse, EdgePullItem, EdgePullQueueResponse,
  type EdgeMarket, type EdgeSeriesCell, type EdgeSeriesKey, type EdgeStatus, type EdgeUnit, type RecordPullRequest,
} from '@contracts/edge';
import { ORA_CLIENT_HEADERS, ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';
import type { Deal, Market } from '@contracts/index';
import { fetchJson, isWarehouseUnavailable, QUERY_OPTS } from '../intel/hooks';

// ── Queries ────────────────────────────────────────────────────────────────────────────────────

export const EDGE_KEYS = {
  markets: ['warehouse', 'edge', 'markets'] as const,
  pullQueue: ['warehouse', 'edge', 'pull-queue'] as const,
};

/** One retry for a real failure; none when the Brain Server is absent (mirror / server down). */
function retryUnlessUnavailable(failureCount: number, error: unknown): boolean {
  return !isWarehouseUnavailable(error) && failureCount < 1;
}

export function useEdgeMarkets(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: EDGE_KEYS.markets,
    queryFn: async () => EdgeMarketsResponse.parse(await fetchJson<unknown>('/api/warehouse/edge/markets')),
    staleTime: 5 * 60_000,
    retry: retryUnlessUnavailable,
    enabled: opts.enabled ?? true,
  });
}

export function useEdgePullQueue() {
  return useQuery({
    queryKey: EDGE_KEYS.pullQueue,
    queryFn: async () => EdgePullQueueResponse.parse(await fetchJson<unknown>('/api/warehouse/edge/pull-queue')),
    ...QUERY_OPTS,
    retry: retryUnlessUnavailable,
  });
}

async function readPullItem(res: Response): Promise<EdgePullItem> {
  const payload = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = (payload as { error?: unknown }).error;
    throw new Error(typeof err === 'string' ? err : `Edge pull update failed (${res.status})`);
  }
  return EdgePullItem.parse(payload);
}

export function useRecordPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordPullRequest): Promise<EdgePullItem> => {
      const res = await fetch('/api/warehouse/edge/pull-queue', {
        method: 'POST',
        headers: ORA_JSON_MUTATION_HEADERS,
        body: JSON.stringify(input),
      });
      return readPullItem(res);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EDGE_KEYS.pullQueue });
    },
  });
}

export function useVoidPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (logId: number): Promise<EdgePullItem> => {
      const res = await fetch(`/api/warehouse/edge/pull-queue/${logId}/void`, {
        method: 'POST',
        headers: ORA_CLIENT_HEADERS,
      });
      return readPullItem(res);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EDGE_KEYS.pullQueue });
    },
  });
}

// ── Status + value display (one source for every surface) ────────────────────────────────────

export interface EdgeStatusLabel {
  /** Replacement text when the cell has no observed value; null for observed statuses. */
  text: string | null;
  title: string | null;
  /** Dotted underline (the Provenance "estimated" visual convention). */
  dotted: boolean;
}

export function edgeStatusLabel(status: EdgeStatus): EdgeStatusLabel {
  switch (status) {
    case 'actual':
      return { text: null, title: null, dotted: false };
    case 'estimated':
      return { text: null, title: 'Est.', dotted: true };
    case 'nowcast':
      return { text: null, title: 'Nowcast', dotted: true };
    case 'guide_only':
      return { text: 'Pending manual pull', title: 'Pending manual pull', dotted: false };
    case 'null':
      return { text: 'Not published', title: 'Not published', dotted: false };
  }
}

export interface EdgeLatest {
  value: number;
  year: number;
  status: EdgeStatus;
  isLatestYear: boolean;
}

/** The last index whose status is observed (actual/estimated/nowcast) AND whose value is non-null. */
export function latestObserved(cell: EdgeSeriesCell, years: readonly number[]): EdgeLatest | null {
  for (let i = cell.values.length - 1; i >= 0; i--) {
    const value = cell.values[i];
    const status = cell.status[i];
    const year = years[i];
    if (value === null || value === undefined || status === undefined || year === undefined) continue;
    if (!EDGE_OBSERVED_STATUSES.includes(status)) continue;
    return { value, year, status, isLatestYear: i === years.length - 1 };
  }
  return null;
}

/** Never returns a number-looking string for null (F4): callers render the status label instead. */
export function formatEdgeValue(value: number | null, unit: EdgeUnit): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const signed = (s: string) => (value > 0 ? `+${s}` : s);
  switch (unit) {
    case 'pct_yoy':
      return `${signed(value.toFixed(1))}%`;
    case 'pct_level':
      return `${value.toFixed(1)}%`;
    case 'ksf':
      return `${Math.round(value).toLocaleString('en-US')} kSF`;
    case 'per_10k':
      return `${value.toFixed(1)} /10k`;
    case 'usd':
      return `$${Math.round(value).toLocaleString('en-US')}`;
    case 'persons':
      return signed(Math.round(value).toLocaleString('en-US'));
    case 'signal':
      return value.toFixed(2);
  }
}

export interface EdgeCellDisplay {
  text: string;
  title: string | null;
  dotted: boolean;
  observed: boolean;
}

export function edgeCellDisplay(
  cell: EdgeSeriesCell,
  unit: EdgeUnit,
  years: readonly number[],
  field: EdgeSeriesKey,
): EdgeCellDisplay {
  const latest = latestObserved(cell, years);
  if (latest) {
    const label = edgeStatusLabel(latest.status);
    const formatted = formatEdgeValue(latest.value, unit) ?? '—';
    return {
      text: latest.isLatestYear ? formatted : `${formatted} (${latest.year})`,
      title: label.title,
      dotted: label.dotted,
      observed: true,
    };
  }
  // Data dictionary: truck is never hidden and never reads as zero where it is null.
  if (field === 'truck') return { text: '— Not yet available', title: 'Not yet available', dotted: false, observed: false };
  const lastStatus: EdgeStatus = cell.status[cell.status.length - 1] ?? 'null';
  const text = edgeStatusLabel(lastStatus).text ?? 'Not published';
  return { text: `— ${text}`, title: text, dotted: false, observed: false };
}

/** Honest header: trueLabel from markets.json, + " [PROXY]" when isProxy. Never the raw key (F3). */
export function edgeSeriesHeader(field: EdgeSeriesKey, fieldMeta: EdgeMarketsResponse['fieldMeta']): string {
  const fm = fieldMeta[field];
  if (!fm) return 'Unlabelled series';
  return fm.isProxy ? `${fm.trueLabel} [PROXY]` : fm.trueLabel;
}

// ── Board model ────────────────────────────────────────────────────────────────────────────────

export type EdgeSetFilter = 'buybox' | 'all' | 'auto';
export type EdgeBoardSortKey = 'name' | EdgeSeriesKey;

/** Lifted into AcquisitionsModule so it survives a tab round-trip without force-mounting. */
export interface EdgeBoardState {
  set: EdgeSetFilter;
  pinBuyBox: boolean;
  sortKey: EdgeBoardSortKey;
  sortDir: 'asc' | 'desc';
  extraColumns: EdgeSeriesKey[];
}

export const EDGE_BOARD_DEFAULT_STATE: EdgeBoardState = {
  set: 'buybox',
  pinBuyBox: true,
  sortKey: 'trades',
  sortDir: 'desc',
  extraColumns: [],
};

/** Default board columns (spec §8.3). None is a proxy. */
export const EDGE_BOARD_COLUMNS: ReadonlyArray<{ field: EdgeSeriesKey; header: string }> = [
  { field: 'trades', header: 'Trades momentum' },
  { field: 'vac', header: 'Flex vacancy' },
  { field: 'rent', header: 'Flex rent growth' },
  { field: 'per', header: 'Pipeline' },
  { field: 'migration', header: 'Net migration' },
  { field: 'pop', header: 'Population' },
];

/** The other 12 series, offered in the column picker. */
export const EDGE_PICKER_SERIES: readonly EdgeSeriesKey[] = EDGE_SERIES.filter(
  (k) => !EDGE_BOARD_COLUMNS.some((c) => c.field === k),
);

/** The four values the deal readout shows (spec §8.4). */
export const EDGE_READOUT_SERIES: ReadonlyArray<{ field: EdgeSeriesKey; label: string }> = [
  { field: 'vac', label: 'Flex vacancy' },
  { field: 'rent', label: 'Flex rent growth' },
  { field: 'per', label: 'Pipeline (new supply, kSF)' },
  { field: 'trades', label: 'Trades momentum' },
];

/** Series that have a manual-pull queue item (Data health links them). */
export const EDGE_PULL_SERIES: ReadonlySet<EdgeSeriesKey> = new Set<EdgeSeriesKey>(['storage', 'ios', 'mfgInvest', 'truck']);

export function isBuyBox(m: EdgeMarket): boolean {
  return m.type === 'named' || m.type === 'named_custom';
}

export function filterEdgeMarkets(markets: readonly EdgeMarket[], set: EdgeSetFilter): EdgeMarket[] {
  if (set === 'all') return [...markets];
  return markets.filter((m) => (set === 'buybox' ? isBuyBox(m) : !isBuyBox(m)));
}

/** Sort by name or by the latest OBSERVED value; nulls last in both directions; under "All" with
 *  the pin on, the buy-box group comes first and each group keeps the sort order (stable sort). */
export function sortEdgeMarkets(
  markets: readonly EdgeMarket[],
  state: Pick<EdgeBoardState, 'set' | 'pinBuyBox' | 'sortKey' | 'sortDir'>,
  years: readonly number[],
): EdgeMarket[] {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const valueOf = (m: EdgeMarket): number | string | null =>
    state.sortKey === 'name' ? m.name : (latestObserved(m.series[state.sortKey], years)?.value ?? null);
  const sorted = [...markets].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  if (state.set !== 'all' || !state.pinBuyBox) return sorted;
  return [...sorted.filter(isBuyBox), ...sorted.filter((m) => !isBuyBox(m))];
}

/** Client local date for the "Mark done" form default (server re-validates against its own clock). */
export function localIsoToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── Deal → Edge market resolver (spec §8.4; F2, F13) ───────────────────────────────────────────
// Pure, two tiers, no fuzzy matching, no default. Tier 1 decides whenever it applies. Runs
// client-side against the snapshot the client already holds: no deal identity reaches the Edge API.

export type EdgeUnmatchedReason = 'no_location' | 'no_market_for_location' | 'ambiguous' | 'edge_id_absent';

export type EdgeResolution =
  | { kind: 'matched'; market: EdgeMarket; via: 'tier1_market' | 'tier2_location' }
  | { kind: 'unmatched'; reason: EdgeUnmatchedReason };

/** Reviewed Tier-1 table. Every Market member is here or in EDGE_TIER2_MARKETS
 *  (tests/unit/edge-resolver.test.ts fails the build otherwise). */
export const EDGE_TIER1_TABLE: Readonly<Partial<Record<Market, string>>> = {
  'Columbus OH': 'columbus',
  'Toledo OH': 'toledo',
  'Cleveland MSA': 'cleveland',
  'Kansas City MO': 'kansas_city',
  // Full CBSA. indianapolis_south is a 3-county submarket cut (Johnson/Morgan/Shelby) and a deal
  // tagged only "Indianapolis IN" is not known to sit inside it. Phase 2's county crosswalk revisits.
  'Indianapolis IN': 'indianapolis_carmel_greenwood',
  'Cincinnati OH': 'cincinnati',
  'Madison WI': 'madison',
  'Grand Rapids MI': 'grand_rapids',
  'Des Moines IA': 'des_moines',
  'Louisville KY': 'louisville',
  'Richmond VA': 'richmond',
};

/** Market members (plus a null market) that defer to the Tier-2 location match. */
export const EDGE_TIER2_MARKETS: ReadonlySet<Market> = new Set<Market>(['Mid-Atlantic', 'Other', 'Unknown']);

export const EDGE_UNMATCHED_TEXT: Readonly<Record<EdgeUnmatchedReason, string>> = {
  no_location: 'no parseable "City, ST" in the deal location',
  no_market_for_location: 'no Edge market for this city and state',
  ambiguous: 'more than one Edge market matches this city and state',
  edge_id_absent: 'the mapped Edge market is missing from markets.json',
};

/** The LAST "City, ST" pair in a location string, after stripping parentheticals. */
export function parseCityState(location: string | null): { city: string; state: string } | null {
  if (!location) return null;
  const stripped = location.replace(/\([^)]*\)/g, ' ');
  const re = /([A-Za-z][A-Za-z .'-]*?)\s*,\s*([A-Z]{2})\b/g;
  let last: { city: string; state: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const city = m[1]?.trim();
    const state = m[2];
    if (city && state) last = { city, state };
  }
  return last;
}

/** First hyphen-segment of a CBSA title = its principal city ("Scranton--Wilkes-Barre" → "scranton"). */
function principalCity(name: string): string {
  return (name.split('-')[0] ?? name).trim().toLowerCase();
}

export function resolveEdgeMarket(deal: Pick<Deal, 'market' | 'location'>, markets: readonly EdgeMarket[]): EdgeResolution {
  const tier1Id = deal.market !== null ? EDGE_TIER1_TABLE[deal.market] : undefined;
  if (tier1Id !== undefined) {
    const market = markets.find((m) => m.id === tier1Id);
    return market ? { kind: 'matched', market, via: 'tier1_market' } : { kind: 'unmatched', reason: 'edge_id_absent' };
  }
  const pair = parseCityState(deal.location);
  if (!pair) return { kind: 'unmatched', reason: 'no_location' };
  const city = pair.city.toLowerCase();
  const hits = markets.filter(
    (m) => m.state === pair.state && (m.name.trim().toLowerCase() === city || principalCity(m.name) === city),
  );
  const only = hits.length === 1 ? hits[0] : undefined;
  if (only) return { kind: 'matched', market: only, via: 'tier2_location' };
  return { kind: 'unmatched', reason: hits.length === 0 ? 'no_market_for_location' : 'ambiguous' };
}

/**
 * Sourcing candidate → snapshot Deal. The join is `Deal.id === candidate.notionDealId`: both carry the
 * Notion PAGE id (server/warehouse/acq-notion-sync.ts stores page.id in acq_candidates.notion_deal_id;
 * server/sources/notion-deals.ts sets Deal.id = page.id for live pipeline rows). This is the same join
 * DealDrawer.findRankedCandidateForDeal and PipelineTierBoard already use. Deal.notionDealId holds the
 * Notion "Deal ID" unique-id ("DEAL-3"), which never equals a page id, so joining on it would leave
 * every candidate unlinked. `null` = unjoinable; never fall back to a name match.
 */
export function findDealForCandidate(deals: readonly Deal[], notionDealId: string | null): Deal | null {
  if (notionDealId === null) return null;
  return deals.find((d) => d.id === notionDealId) ?? null;
}

const SERIES_UNIT_OF = (field: EdgeSeriesKey, data: EdgeMarketsResponse): EdgeUnit =>
  data.fieldMeta[field]?.unit ?? 'signal';

export function edgeReadoutTitle(market: EdgeMarket, data: EdgeMarketsResponse): string {
  const parts = EDGE_READOUT_SERIES.map(
    ({ field, label }) => `${label}: ${edgeCellDisplay(market.series[field], SERIES_UNIT_OF(field, data), data.years, field).text}`,
  );
  const f = data.freshness;
  const fresh = f ? (f.stale ? ` · STALE (as of ${f.asOf})` : ` · as of ${f.asOf}`) : '';
  return `${market.name}, ${market.state} — ${parts.join(' · ')}${fresh}`;
}

export type EdgeQueryState = 'idle' | 'loading' | 'error' | 'ready';

/** Compact Sourcing-list cell: "vacancy · rent growth" (+ STALE), full readout in the tooltip. */
export function edgeCandidateCell(
  notionDealId: string | null,
  deals: readonly Deal[],
  data: EdgeMarketsResponse | undefined,
  state: EdgeQueryState,
): { text: string; title: string | null } {
  const deal = findDealForCandidate(deals, notionDealId);
  if (!deal) return { text: 'No Edge market (no linked deal)', title: null };
  if (state === 'idle' || state === 'loading') return { text: '—', title: null };
  if (state === 'error' || !data || data.availability !== 'ok') {
    return { text: 'Edge unavailable', title: data ? `Edge dataset ${data.availability}` : 'Edge is local-only (Brain Server)' };
  }
  const res = resolveEdgeMarket(deal, data.markets);
  if (res.kind === 'unmatched') return { text: 'No Edge market', title: EDGE_UNMATCHED_TEXT[res.reason] };
  const vac = edgeCellDisplay(res.market.series.vac, SERIES_UNIT_OF('vac', data), data.years, 'vac').text;
  const rent = edgeCellDisplay(res.market.series.rent, SERIES_UNIT_OF('rent', data), data.years, 'rent').text;
  return { text: `${vac} · ${rent}${data.freshness?.stale ? ' · STALE' : ''}`, title: edgeReadoutTitle(res.market, data) };
}
