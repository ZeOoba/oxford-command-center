// src/modules/acquisitions/RankedCandidateList.tsx
//
// Renders the ranked acquisition candidate list from GET /acq/intel (Phase 4, Step 7).
// Tier badges: T1=Gold, T2=Navy, PASS=neutral, KILLED=red.
// Governor breach indicator: ⚠ when DSCR governor failed.
// ltvCleared is always null at screen time (no loan amount in AcquisitionInput — indeterminate);
// the ltvCleared === false branch below is reserved for the future financing-stage LTV gate.
import type { RankedCandidate } from '@contracts/acquisition';
import { DataTable, type Column } from '@/primitives/DataTable';
import { useSetCandidateStatus } from './hooks';

const TIER_STYLES: Record<string, { label: string; bg: string; color: string }> = {
  T1:     { label: 'T1 · PURSUE', bg: '#C9A96E', color: '#1B2A4A' },
  T2:     { label: 'T2 · WATCH',  bg: '#1B2A4A', color: '#F5F3EF' },
  PASS:   { label: 'PASS',        bg: 'var(--surface-overlay)',   color: 'var(--text-tertiary)' },
  KILLED: { label: 'KILLED',      bg: 'var(--color-neg)',         color: '#fff' },
};

function TierBadge({ tier, verdict }: { tier: string | null; verdict: string | null }) {
  const key = tier ?? verdict ?? 'PASS';
  const style = TIER_STYLES[key] ?? TIER_STYLES['PASS']!;
  return (
    <span style={{
      display: 'inline-block',
      padding: '0.125rem 0.5rem',
      borderRadius: '0.25rem',
      fontSize: '0.6875rem',
      fontFamily: 'var(--font-mono)',
      fontWeight: 600,
      background: style.bg,
      color: style.color,
    }}>
      {style.label}
    </span>
  );
}

type GovernorCellProps = {
  dscrCleared: boolean | null;
  ltvCleared: boolean | null;
};
function GovernorCell({ dscrCleared, ltvCleared }: GovernorCellProps) {
  const breach = dscrCleared === false || ltvCleared === false;
  if (!breach && dscrCleared === null && ltvCleared === null) {
    return <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>–</span>;
  }
  if (!breach) {
    return <span style={{ color: 'var(--color-pos)', fontSize: '0.75rem' }}>✓</span>;
  }
  const tip = [
    dscrCleared === false ? 'DSCR governor failed (proxy < 1.25x)' : '',
    ltvCleared === false  ? 'LTV governor failed (> 40%)'          : '',
  ].filter(Boolean).join(' · ');
  return (
    <span
      title={tip}
      style={{ color: 'var(--color-neg)', fontSize: '0.75rem', cursor: 'default' }}
    >
      ⚠
    </span>
  );
}

type Props = {
  items: RankedCandidate[];
  advisoryOnly: boolean;
  writesEnabled: boolean;
};

export function RankedCandidateList({ items, advisoryOnly, writesEnabled }: Props) {
  const setStatus = useSetCandidateStatus();

  if (items.length === 0) {
    return (
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>
        No candidates match the current filters.
      </p>
    );
  }

  const columns: Column<RankedCandidate>[] = [
    {
      key: 'tier',
      header: 'Tier',
      render: (item) => (
        <TierBadge
          tier={item.latestScore?.tier ?? null}
          verdict={item.latestScore?.verdict ?? null}
        />
      ),
      sortValue: (item) => item.latestScore?.tier ?? item.latestScore?.verdict ?? 'PASS',
    },
    {
      key: 'address',
      header: 'Address',
      render: (item) => item.candidate.address ?? <em style={{ color: 'var(--text-tertiary)' }}>no address</em>,
      sortValue: (item) => item.candidate.address ?? '',
    },
    {
      key: 'market',
      header: 'Market',
      render: (item) => <span style={{ color: 'var(--text-secondary)' }}>{item.candidate.market ?? '—'}</span>,
      sortValue: (item) => item.candidate.market ?? '',
    },
    {
      key: 'sf',
      header: 'SF',
      align: 'right',
      render: (item) => (
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          {item.candidate.rentableSf !== null ? item.candidate.rentableSf.toLocaleString() : '—'}
        </span>
      ),
      sortValue: (item) => item.candidate.rentableSf ?? 0,
    },
    {
      key: 'gov',
      header: 'Gov',
      render: (item) => (
        <GovernorCell dscrCleared={item.governorDscrCleared} ltvCleared={item.governorLtvCleared} />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (item) =>
        writesEnabled ? (
          <select
            value={item.candidate.status}
            disabled={setStatus.isPending}
            onChange={(e) =>
              void setStatus.mutate({
                candidateId: item.candidate.id,
                status: e.target.value as 'active' | 'archived' | 'acquired' | 'passed',
              })
            }
            style={{ fontSize: '0.75rem', padding: '0.125rem 0.25rem', border: '1px solid var(--border-subtle)', borderRadius: '0.25rem', background: 'var(--surface-raised)', color: 'var(--text-primary)' }}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="acquired">Acquired ✓</option>
            <option value="passed">Passed ✗</option>
          </select>
        ) : (
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
            {item.candidate.status}
          </span>
        ),
      sortValue: (item) => item.candidate.status,
    },
    ...(advisoryOnly
      ? [{
          key: 'advisory',
          header: '⚠',
          render: (_item: RankedCandidate) => (
            <span style={{ color: 'var(--color-warn)', fontSize: '0.6875rem' }}>advisory</span>
          ),
        } satisfies Column<RankedCandidate>]
      : []),
  ];

  return (
    <DataTable
      columns={columns}
      rows={items}
      getRowId={(item) => item.candidate.id}
      initialSort={{ key: 'tier', dir: 'asc' }}
    />
  );
}
