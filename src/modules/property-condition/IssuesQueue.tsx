// src/modules/property-condition/IssuesQueue.tsx
//
// The 8-item PCA decision queue from the 2026-10-13 PCA report. Status defaults to "Open" and owner to
// blank — this view is a display of the queue; it does not write to Notion or anywhere else (assignment
// and resolution are Gabriel's, tracked outside this surface for now).
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { PCA_ISSUES } from './pca-overlay';

const muted = { color: 'var(--text-tertiary)' } as const;

export function IssuesQueue() {
  return (
    <Card>
      <CardHeader title="PCA decision queue" trailing={<Badge tone="amber">{PCA_ISSUES.length} open</Badge>} />
      <ul>
        {PCA_ISSUES.map((i) => (
          <li
            key={i.no}
            className="flex gap-3 px-4 py-3"
            style={{ borderTop: '1px solid var(--border-subtle)', fontSize: 13 }}
          >
            <div className="num text-2xs" style={{ width: 20, flexShrink: 0, ...muted }}>{i.no}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                {i.property} — {i.title}
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>{i.detail}</div>
            </div>
            <div className="text-2xs" style={{ width: 120, flexShrink: 0, textAlign: 'right', ...muted }}>
              <Badge tone="amber">{i.status}</Badge>
              <div>Owner: {i.owner === '' ? 'unassigned' : i.owner}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
