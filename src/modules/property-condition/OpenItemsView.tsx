// src/modules/property-condition/OpenItemsView.tsx
//
// The extraction register's discrepancies and decisions, as printed. These are Gabriel's call (or a
// source-document fix) — the command center lists them, it does not resolve or reinterpret them.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import type { PcaOpenItem } from '@contracts/property-condition';

const muted = { color: 'var(--text-tertiary)' } as const;

const SEVERITY_TONE: Record<PcaOpenItem['severity'], BadgeTone> = {
  High: 'red',
  Med: 'amber',
  Low: 'neutral',
  Info: 'blue',
};

export function OpenItemsView({ items }: { items: PcaOpenItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title="Register open items" trailing={<Badge tone="neutral">{items.length} items</Badge>} />
        {items.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No open items loaded.</div>
        ) : (
          <ul>
            {items.map((i) => (
              <li
                key={i.itemNo}
                className="flex gap-3 px-4 py-3"
                style={{ borderTop: '1px solid var(--border-subtle)', fontSize: 13 }}
              >
                <div style={{ width: 52, flexShrink: 0 }}>
                  <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {i.propertyText ?? 'Portfolio'}
                  </div>
                  <div style={{ color: 'var(--text-secondary)' }}>{i.issue}</div>
                  {i.actionNeeded && (
                    <div className="text-2xs" style={muted}>
                      Action: {i.actionNeeded}
                    </div>
                  )}
                </div>
                <div className="num text-2xs" style={muted}>#{i.itemNo}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
