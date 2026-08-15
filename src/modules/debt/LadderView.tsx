// src/modules/debt/LadderView.tsx
//
// Phase 2 Step 6 — Maturity ladder: visual timeline with 12/24/36-month buckets,
// balloon flags, and signal badges.
// Consumes useDebtMaturity() — degrades gracefully when warehouse is unavailable.
import { AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/primitives/Skeleton';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { fmtUsdCompact, fmtMonths, fmtDate } from '@analytics/index';
import { isWarehouseUnavailable } from '../intel/hooks';
import { useDebtMaturity, groupByBucket, bucketBalance, bucketTone, signalTone, signalLabel } from './hooks';
import type { MaturityLadderEntry } from './hooks';

// ── Bucket configuration ─────────────────────────────────────────────────────────────────

const BUCKET_DEFS: Array<{
  id: MaturityLadderEntry['bucket'];
  label: string;
  sublabel: string;
}> = [
  { id: '0-12',  label: '0–12 months',  sublabel: 'Imminent' },
  { id: '13-24', label: '13–24 months', sublabel: 'Near-term' },
  { id: '25-36', label: '25–36 months', sublabel: 'Medium' },
  { id: '37+',   label: '37+ months',   sublabel: 'Long-dated / demand' },
];

// ── Bucket panel ─────────────────────────────────────────────────────────────────────────

function BucketPanel({
  def,
  entries,
}: {
  def: (typeof BUCKET_DEFS)[number];
  entries: MaturityLadderEntry[];
}) {
  const tone = bucketTone(def.id);
  const totalBalance = bucketBalance(entries);

  return (
    <Card>
      {/* Bucket header */}
      <div
        className="flex items-center justify-between gap-2 px-4 py-3"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center gap-2">
          <Badge tone={tone}>{def.label}</Badge>
          <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {def.sublabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <span className="num text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
              {fmtUsdCompact(totalBalance)}
            </span>
          )}
          <Badge tone="neutral">{entries.length} loan{entries.length !== 1 ? 's' : ''}</Badge>
        </div>
      </div>

      {/* Loan rows */}
      {entries.length === 0 ? (
        <div className="px-4 py-4 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          No active loans in this bucket.
        </div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {entries.map((entry) => (
            <LoanRow key={entry.loanId} entry={entry} />
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Individual loan row ──────────────────────────────────────────────────────────────────

function LoanRow({ entry }: { entry: MaturityLadderEntry }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      {/* Property + loan name */}
      <div className="min-w-0 flex-1">
        <div className="num text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {entry.propertyName}
        </div>
        <div className="num text-2xs truncate" style={{ color: 'var(--text-tertiary)' }}>
          {entry.loanName}
        </div>
      </div>

      {/* Balance */}
      <div className="num text-xs font-semibold shrink-0" style={{ color: 'var(--text-secondary)' }}>
        {fmtUsdCompact(entry.currentBalance)}
      </div>

      {/* Maturity / demand */}
      <div className="num text-2xs shrink-0 text-right" style={{ color: 'var(--text-tertiary)', minWidth: 80 }}>
        {entry.isDemand ? (
          <span style={{ color: 'var(--text-warn)' }}>Demand</span>
        ) : (
          <>
            <div>{fmtDate(entry.maturityDate)}</div>
            {entry.monthsToMaturity !== null && (
              <div>{fmtMonths(entry.monthsToMaturity)}</div>
            )}
          </>
        )}
      </div>

      {/* Balloon flag */}
      {entry.balloon && (
        <AlertTriangle size={13} className="shrink-0" style={{ color: 'var(--color-neg)' }} />
      )}

      {/* Signal badge */}
      <Badge tone={signalTone(entry.signal)}>{signalLabel(entry.signal)}</Badge>
    </div>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────────────────

export function LadderView() {
  const { data, isLoading, error } = useDebtMaturity();

  if (isLoading) return <Skeleton style={{ height: 320 }} />;

  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Maturity Ladder" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Maturity ladder requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            Loan maturity data is sourced from the warehouse debt_positions snapshot. The
            deployed mirror does not include the live warehouse.
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Maturity Ladder" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load maturity ladder.'}
        </div>
      </Card>
    );
  }

  // Round 19e: LadderView previously read the ladder array directly; the hook now returns the
  // whole envelope (see hooks.ts's useDebtMaturity note) so the trust banner below has a field
  // to read even when the ladder is empty — the same fix ScorecardView got in round 19d.
  const ladder = data?.ladder ?? [];
  const bookTrust = data?.bookTrust ?? 'trusted';
  const grouped = groupByBucket(ladder);

  const imminentCount = (grouped.get('0-12') ?? []).length;
  const totalLoans = ladder.length;
  const demandCount = ladder.filter((e) => e.isDemand).length;
  const balloonCount = ladder.filter((e) => e.balloon).length;

  const distrusted = bookTrust !== 'trusted';
  const trustHeadline =
    bookTrust === 'degraded'
      ? 'Debt book DEGRADED — rows were lost by the last snapshot write.'
      : bookTrust === 'refused'
        ? 'Debt book STALE — the last snapshot write was refused.'
        : 'Debt book NOT LOADED — no debt snapshot has been written.';
  const trustDetail =
    bookTrust === 'degraded'
      ? 'This ladder may be missing loans lost by the last write. Clearance-direction signals below are withheld — but a measured per-loan breach (governor-block) still displays if present.'
      : bookTrust === 'refused'
        ? 'This ladder is the last trusted book and may be out of date.'
        : 'No debt snapshot has populated this ladder yet.';

  return (
    <div className="flex flex-col gap-4">
      {/* Summary bar */}
      <Card>
        <CardHeader
          title="Maturity Ladder"
          trailing={
            <div className="flex items-center gap-1.5">
              {distrusted && (
                <Badge tone={bookTrust === 'unknown' ? 'amber' : 'red'}>
                  {bookTrust === 'unknown' ? 'book not loaded' : 'book not trusted'}
                </Badge>
              )}
              {imminentCount > 0 && <Badge tone="red">{imminentCount} ≤12 mo</Badge>}
              {balloonCount > 0 && <Badge tone="amber">{balloonCount} balloon</Badge>}
              {demandCount > 0 && <Badge tone="amber">{demandCount} demand</Badge>}
              <Badge tone="neutral">{totalLoans} total</Badge>
            </div>
          }
        />
        {distrusted && (
          <div
            className="px-4 py-3 text-2xs"
            style={{ color: 'var(--text-neg)', borderBottom: '1px solid var(--border-subtle)' }}
          >
            <strong>{trustHeadline}</strong> {trustDetail}
          </div>
        )}
        {totalLoans === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>No active debt positions.</div>
            <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 380 }}>
              Run a debt snapshot after the master workbook is refreshed to populate the ladder.
            </div>
          </div>
        )}
      </Card>

      {/* One panel per bucket */}
      {totalLoans > 0 && BUCKET_DEFS.map((def) => (
        <BucketPanel
          key={def.id}
          def={def}
          entries={grouped.get(def.id) ?? []}
        />
      ))}
    </div>
  );
}
