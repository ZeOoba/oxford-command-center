// src/modules/acquisitions/PipelineTierBoard.tsx
//
// Pipeline board for the OM Grader — groups ranked acquisition candidates (GET /acq/intel) into
// exactly 4 tiers using the ENGINE'S OWN persisted `tier` field, never re-derived from composite
// in the UI (the same invariant RankedCandidateList.tsx already carries for the table view of this
// same data; see that file's header). Unscored candidates (no latestScore yet) have no tier to
// bucket into and are omitted from the board — they still show up in the plain candidate list.
//
// The column is the VERDICT's tier (effectiveTier), matching the ranked list, the /acq/intel sort
// and the capital BUY gate: a legacy row persisted tier T1/T2 next to a governor-demoted PASS lands
// in Pass, so the T1/T2 columns only hold governor-cleared deals. Every governor-demoted PASS (that
// legacy shape, or the current engine's tier PASS + "Governor demotion:" reason) is marked
// "Governor-demoted (was T1)" (src/analytics/acq-governor-demotion.ts).
//
// Detail navigation reuses the existing `ui.openEntity({ type: 'deal', ... })` mechanism already
// used by AcquisitionsModule.tsx's Active Deals table (onRowClick) — the only "open a detail view"
// pattern this module has. It only applies once a candidate is synced to a Notion pipeline deal
// (candidate.notionDealId is null until then), so the action is omitted otherwise.
import { useUi } from '@/brain/ui-context';
import { TierBoard, type Tier, type TierItem } from '@/primitives/TierBoard';
import type { RankedCandidate } from '@contracts/acquisition';
import { effectiveTier, governorDemotedLabel } from '@analytics/acq-governor-demotion';
import { useAcqIntel } from './grader-hooks';

const TIER_DEFS: ReadonlyArray<{ key: 'T1' | 'T2' | 'PASS' | 'KILLED'; title: string; tone: Tier['tone'] }> = [
  { key: 'T1', title: 'T1 · Pursue', tone: 'pos' },
  { key: 'T2', title: 'T2 · Watch', tone: 'accent' },
  { key: 'PASS', title: 'Pass', tone: 'info' },
  { key: 'KILLED', title: 'Killed', tone: 'neg' },
];

const MARKET_LABEL: Record<string, string> = {
  'owned-submarket': 'Owned submarket',
  established: 'Established',
  entry: 'Entry',
  satellite: 'Satellite',
  none: 'No market',
};

function toTierItem(ranked: RankedCandidate, onOpenDeal: (dealId: string) => void): TierItem {
  const { candidate, latestScore } = ranked;
  const market = candidate.market ? (MARKET_LABEL[candidate.market] ?? candidate.market) : undefined;
  const sf = candidate.rentableSf !== null ? `${candidate.rentableSf.toLocaleString()} SF` : null;
  const dealId = candidate.notionDealId;
  const demoted = governorDemotedLabel(latestScore);
  return {
    id: candidate.id,
    title: candidate.address ?? `${market ?? 'Unknown market'} candidate`,
    category: market,
    detail: [`${latestScore?.composite ?? '—'}/100`, latestScore?.verdict ?? '—', sf].filter(Boolean).join(' · '),
    chips: demoted ? [demoted] : undefined,
    action: dealId ? { label: 'Open in Workbench', onPress: () => onOpenDeal(dealId) } : undefined,
  };
}

export function PipelineTierBoard() {
  // includeKilled: this board has a Killed column; /acq/intel hides KILLED by default (audit G4).
  const { data } = useAcqIntel(undefined, undefined, undefined, undefined, true);
  const ui = useUi();
  const candidates = data?.rankedCandidates ?? [];
  const onOpenDeal = (dealId: string) => ui.openEntity({ type: 'deal', id: dealId });

  const tiers: Tier[] = TIER_DEFS.map((def) => ({
    key: def.key,
    title: def.title,
    tone: def.tone,
    items: candidates
      .filter((c) => effectiveTier(c.latestScore) === def.key)
      .map((c) => toTierItem(c, onOpenDeal)),
  }));

  return <TierBoard tiers={tiers} columns={4} />;
}
