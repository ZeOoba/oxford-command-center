// src/primitives/AsOfChip.tsx
//
// Per-card "as of" stamp (roadmap 2026-10-30, item 1.2). The global stale banner says the snapshot
// is old; it does not say which date or source a given chart is drawn from. Every trend card states
// both, so a chart built from the Cash Balances sheet can't be read as current to the rent roll.
import { fmtDate } from '@analytics/format';

export function AsOfChip({ asOf, source }: { asOf: string | null | undefined; source: string }) {
  const date = fmtDate(asOf);
  return (
    <span
      className="num text-2xs whitespace-nowrap"
      style={{ color: 'var(--text-tertiary)' }}
      title={`Data as of ${date} · source: ${source}`}
    >
      as of {date} · {source}
    </span>
  );
}
