// src/primitives/BasisChip.tsx
//
// Design review 2026-10-31 finding 8: "NOI" appears on adjacent screens over different bases — the
// Master Workbook (current state, Oxford share) and the P&L ledger (warehouse full-year statements,
// entity 100% unless stated) — and most NOI surfaces did not say which. The two-spine doctrine
// (CLAUDE.md §1) forbids comparing or summing them without basis-matching; a reader can only follow
// it when the basis is printed beside the figure. One primitive keeps the words identical everywhere;
// they match spineLabel() and the Priority Actions basis chips ("Workbook", "Ledger").
import type { ReactNode } from 'react';
import { spineLabel } from '@/lib/spine-label';
import { Badge } from './Badge';

export type Basis = 'workbook' | 'ledger';

const LABEL: Record<Basis, string> = {
  workbook: spineLabel('A'),
  ledger: spineLabel('B'),
};

const TITLE: Record<Basis, string> = {
  workbook:
    'Workbook basis: the current-state figure from the Master Workbook. Not comparable with the P&L ledger without basis-matching.',
  ledger:
    'Ledger basis: property P&L statements in the warehouse, full-year or year-to-date as labelled. Not comparable with the workbook without basis-matching.',
};

/** The basis name as a small neutral chip, with what it means on hover. */
export function BasisChip({ basis }: { basis: Basis }) {
  return (
    <span title={TITLE[basis]} data-basis={basis} className="inline-flex shrink-0">
      <Badge tone="neutral">{LABEL[basis]}</Badge>
    </span>
  );
}

/** A KPI sublabel led by its basis chip: `[Ledger] FY2025 · entity 100%`. Block-level flex capped
 *  at its container's width, so the text (not the chip) truncates with an ellipsis inside KpiStat's
 *  truncating sublabel; an inline-flex box sized to its content and was clipped mid-word instead.
 *  The text keeps its full value on hover, which KpiStat only supplies for plain-string sublabels. */
export function BasisSublabel({ basis, children }: { basis: Basis; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5">
      <BasisChip basis={basis} />
      {children != null && children !== '' && (
        <span className="min-w-0 truncate" title={typeof children === 'string' ? children : undefined}>
          {children}
        </span>
      )}
    </span>
  );
}
