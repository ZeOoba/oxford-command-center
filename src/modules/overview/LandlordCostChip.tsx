// src/modules/overview/LandlordCostChip.tsx
//
// The one rendering of a LandlordCostCaveat as a KPI caveat chip (Overview and Portfolio tiles), so
// the wording and tone cannot diverge between surfaces. The text may wrap: Badge is nowrap and the
// KPI card hides overflow, so an unwrapped chip would be clipped on a narrow tile. The explanation
// (what is overstated, which properties) is also in screen-reader text, not only in the hover title.
import { Badge } from '@/primitives/Badge';
import type { LandlordCostCaveat } from './landlord-cost-caveat';

export function LandlordCostChip({ caveat }: { caveat: LandlordCostCaveat | null }) {
  if (!caveat) return null;
  return (
    <span title={caveat.title} className="min-w-0">
      <Badge tone="amber">
        <span className="whitespace-normal">{caveat.text}</span>
        <span className="sr-only">. {caveat.title}</span>
      </Badge>
    </span>
  );
}
