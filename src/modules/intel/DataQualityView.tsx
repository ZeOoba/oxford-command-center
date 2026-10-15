// src/modules/intel/DataQualityView.tsx
//
// Open data-quality issues across the warehouse (sign-normalized, foot-mismatch,
// unmapped-account, …) with one-click resolution. Resolving flips the issue to
// 'resolved' (never deleted) and invalidates the imports/noi/issues queries.
import { useMemo } from 'react';
import { fmtDate } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { DataTable, type Column } from '@/primitives/DataTable';
import { useResolveIssue, useWarehouseLive, type WarehouseIssue } from './hooks';
import { severityTone } from './constants';

export function DataQualityView({ issues }: { issues: WarehouseIssue[] }) {
  const resolve = useResolveIssue();
  // Resolving an issue is a server WRITE; on the baked mirror it has no edge home → read-only (Phase 1b).
  const live = useWarehouseLive();

  const cols = useMemo((): Column<WarehouseIssue>[] => [
    { key: 'severity', header: 'Severity', render: (i) => <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>, sortValue: (i) => i.severity },
    { key: 'kind', header: 'Kind', render: (i) => <span className="num text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-secondary)' }}>{i.kind}</span>, sortValue: (i) => i.kind },
    { key: 'propertyName', header: 'Property', render: (i) => i.propertyName ?? '—', sortValue: (i) => i.propertyName ?? '' },
    { key: 'fileName', header: 'File', render: (i) => i.fileName ?? '—', sortValue: (i) => i.fileName ?? '' },
    { key: 'detail', header: 'Detail', render: (i) => <span style={{ color: 'var(--text-secondary)' }}>{i.detail}</span>, sortValue: (i) => i.detail },
    { key: 'createdAt', header: 'Raised', align: 'right', render: (i) => fmtDate(i.createdAt), sortValue: (i) => i.createdAt },
    ...(live
      ? ([{
          key: 'resolve',
          header: '',
          align: 'right',
          render: (i) => (
            <Button
              size="sm"
              variant="subtle"
              onPress={() => resolve.mutate(i.id)}
              isDisabled={resolve.isPending}
              aria-label={
                i.kind === 'sign-undecidable'
                  ? `Mark sign verified for issue ${i.id} (check the import's ledger signs against the source statement first)`
                  : `Resolve issue ${i.id}`
              }
            >
              {/* For a sign-undecidable issue this click is the acknowledgement that unlocks Approve. */}
              {i.kind === 'sign-undecidable' ? 'Mark sign verified' : 'Resolve'}
            </Button>
          ),
        }] as Column<WarehouseIssue>[])
      : []),
  ], [live, resolve]);

  return (
    <Card>
      <CardHeader
        title="Open Data-Quality Issues"
        trailing={
          <div className="flex items-center gap-1.5">
            {!live && <Badge tone="neutral">read-only</Badge>}
            <Badge tone={issues.length === 0 ? 'green' : 'amber'}>{issues.length} open</Badge>
          </div>
        }
      />
      {issues.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No open issues — every committed import footed and resolved cleanly.
        </div>
      ) : (
        <DataTable columns={cols} rows={issues} getRowId={(i) => String(i.id)} initialSort={{ key: 'createdAt', dir: 'desc' }} />
      )}
    </Card>
  );
}
