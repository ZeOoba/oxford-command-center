// src/modules/property-condition/AlertsBanner.tsx
//
// Report-currency alerts, always visible above the view switcher: DRAFT reports, reports older than 24
// months (computed from today's date, not a stored flag), and the stale 29000 Information Ln rent roll.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import type { CurrencyAlert } from '@/analytics/pca-intelligence';

const KIND_LABEL: Record<CurrencyAlert['kind'], string> = { draft: 'DRAFT', age: 'AGE', 'rent-roll': 'RENT ROLL' };

export function AlertsBanner({ alerts }: { alerts: CurrencyAlert[] }) {
  if (alerts.length === 0) return null;
  const warn = alerts.filter((a) => a.severity === 'warn').length;
  return (
    <Card>
      <CardHeader
        title="Report-currency alerts"
        trailing={<Badge tone={warn > 0 ? 'amber' : 'neutral'}>{alerts.length} alerts</Badge>}
      />
      <ul>
        {alerts.map((a) => (
          <li
            key={`${a.kind}|${a.propertyKey}`}
            className="flex items-baseline gap-3 px-4 py-1.5 text-xs"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <span style={{ width: 70, flexShrink: 0 }}>
              <Badge tone={a.severity === 'warn' ? 'amber' : 'neutral'}>{KIND_LABEL[a.kind]}</Badge>
            </span>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)', width: 190, flexShrink: 0 }}>{a.propertyLabel}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{a.message}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
