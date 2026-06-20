// src/modules/acquisitions/RankedCandidateList.tsx
//
// Renders the ranked acquisition candidate list from GET /acq/intel (Phase 4, Step 7).
// Tier badges: T1=Gold, T2=Navy, PASS=neutral, KILLED=red.
// Governor breach indicator: ⚠ when DSCR governor failed.
// ltvCleared is always null at screen time (no loan amount in AcquisitionInput — indeterminate);
// the ltvCleared === false branch below is reserved for the future financing-stage LTV gate.
import type { RankedCandidate } from '@contracts/acquisition';
import { useSetCandidateStatus } from './hooks';

const TIER_STYLES: Record<string, { label: string; bg: string; color: string }> = {
  T1:     { label: 'T1 · PURSUE', bg: '#C9A96E', color: '#1B2A4A' },
  T2:     { label: 'T2 · WATCH',  bg: '#1B2A4A', color: '#F5F3EF' },
  PASS:   { label: 'PASS',        bg: 'var(--bg-tertiary)',   color: 'var(--text-tertiary)' },
  KILLED: { label: 'KILLED',      bg: 'var(--color-neg)',     color: '#fff' },
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

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {['Tier', 'Address', 'Market', 'SF', 'Gov', 'Status', ...(advisoryOnly ? ['⚠'] : [])].map((h) => (
              <th key={h} style={{ padding: '0.375rem 0.5rem', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 500, fontSize: '0.6875rem', fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const tier = item.latestScore?.tier ?? null;
            const verdict = item.latestScore?.verdict ?? null;
            return (
              <tr key={item.candidate.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '0.5rem' }}>
                  <TierBadge tier={tier} verdict={verdict} />
                </td>
                <td style={{ padding: '0.5rem', color: 'var(--text-primary)' }}>
                  {item.candidate.address ?? <em style={{ color: 'var(--text-tertiary)' }}>no address</em>}
                </td>
                <td style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  {item.candidate.market ?? '—'}
                </td>
                <td style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  {item.candidate.rentableSf !== null ? item.candidate.rentableSf.toLocaleString() : '—'}
                </td>
                <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                  <GovernorCell dscrCleared={item.governorDscrCleared} ltvCleared={item.governorLtvCleared} />
                </td>
                <td style={{ padding: '0.5rem' }}>
                  {writesEnabled ? (
                    <select
                      value={item.candidate.status}
                      disabled={setStatus.isPending}
                      onChange={(e) =>
                        void setStatus.mutate({
                          candidateId: item.candidate.id,
                          status: e.target.value as 'active' | 'archived' | 'acquired' | 'passed',
                        })
                      }
                      style={{ fontSize: '0.75rem', padding: '0.125rem 0.25rem', border: '1px solid var(--border)', borderRadius: '0.25rem', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
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
                  )}
                </td>
                {advisoryOnly && (
                  <td style={{ padding: '0.5rem', color: 'var(--color-warn)', fontSize: '0.6875rem' }}>
                    advisory
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
