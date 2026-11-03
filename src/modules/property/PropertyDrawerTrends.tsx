// src/modules/property/PropertyDrawerTrends.tsx
//
// The property drawer's trend strip (roadmap 2.2): "Open property page" plus two labelled
// sparklines — ledger T12 NOI (entity 100%) and lease-SF occupancy. Each states its basis; the
// drawer's own rows are workbook figures, so nothing here is presented as the same number.
import { Link, useLocation } from 'react-router-dom';
import type { PortfolioSnapshot, Property } from '@contracts/index';
import { Sparkline } from '@/charts/Sparkline';
import { fmtPct, fmtUsdCompact } from '@analytics/index';
import { propertyPageHref } from './property-page-model';
import { usePropertyLedger, usePropertyOccupancy } from './hooks';

function Strip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="num mb-1 text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const none = (text: string) => (
  <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
    {text}
  </div>
);

export function PropertyDrawerTrends({ property, snapshot }: { property: Property; snapshot: PortfolioSnapshot }) {
  const location = useLocation();
  const ledger = usePropertyLedger(property.id);
  const occupancy = usePropertyOccupancy(snapshot, property);
  const t12 = ledger?.t12.map((t) => t.value) ?? [];
  const occ = occupancy?.points.slice(-24).map((p) => 1 - p.vacancyPct) ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-md)] p-3" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex gap-4">
        <Strip label="NOI · ledger T12 (entity 100%)">
          {t12.length > 1 ? <Sparkline data={t12} label={`${property.name} trailing-12 NOI, P&L ledger entity basis`} valueFormat={fmtUsdCompact} width={160} height={36} /> : none('Not enough ledger months')}
        </Strip>
        <Strip label="Occupancy · lease-SF basis">
          {occ.length > 1 ? (
            <Sparkline data={occ} label={`${property.name} occupancy, lease-SF basis`} valueFormat={(n) => fmtPct(n)} width={160} height={36} color="var(--color-info)" />
          ) : (
            none('No lease-SF series')
          )}
        </Strip>
      </div>
      <Link to={propertyPageHref(property.id, location.search)} className="self-start text-2xs font-semibold" style={{ color: 'var(--accent)' }}>
        Open property page →
      </Link>
    </div>
  );
}
