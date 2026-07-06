// src/modules/command-brain/MemoryBoard.tsx
//
// The "learned knowledge" board — NOT literal memory (nothing in the BrainReport contract stores
// memory entries). It renders confidenceByMarket + confidenceByManager, combined and bucketed by
// coverageConfidence, through TierBoard's 3-column layout. Every card keeps its row's own basisNote
// ('coverage-based, not predictive skill') visible as a caption — that note IS the point of the
// doctrine, never hidden. Empty confidence arrays fall through to TierBoard's own built-in
// empty-tier state (3 columns, each reading "Clear") rather than a fabricated placeholder card.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { TierBoard } from '@/primitives/TierBoard';
import { buildMemoryTiers, type ConfidenceRow } from './hooks';

export function MemoryBoard({
  confidenceByMarket,
  confidenceByManager,
}: {
  confidenceByMarket: ConfidenceRow[];
  confidenceByManager: ConfidenceRow[];
}) {
  const tiers = buildMemoryTiers(confidenceByMarket, confidenceByManager);
  const total = confidenceByMarket.length + confidenceByManager.length;

  return (
    <Card>
      <CardHeader
        title="Coverage Confidence — By Market & Manager"
        trailing={<Badge tone="neutral">{`${total} cohort${total === 1 ? '' : 's'}`}</Badge>}
      />
      <div className="px-4 pt-2 pb-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        Coverage confidence reflects how much resolved data backs a cohort — it is not a measure of
        predictive skill. See each card&rsquo;s caption.
      </div>
      <div className="p-3">
        <TierBoard tiers={tiers} columns={3} />
      </div>
    </Card>
  );
}
