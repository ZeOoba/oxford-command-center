// src/modules/health/reconciliation-card.ts
//
// System Health › Reconciliation card state (item 13, 2026-09-24). Round 1 put the Overview-vs-
// Capital debt-basis flag on entity 'debt' (so it would not fire the CRITICAL reconcile-fail
// insight); this card only listed entity==='reconciliation' flags, so it read "Consistent" beside a
// live ~$0.7M basis gap. It now lists reconciliation flags AND debt-basis flags and colours by
// severity: red only for an error, amber for warn-only rows, green only when both lists are empty.
import { isDebtBasisFlag } from '@analytics/index';
import type { DataQualityFlag } from '@contracts/index';

export interface ReconciliationCardState {
  badgeTone: 'green' | 'amber' | 'red';
  badgeLabel: string;
  rows: DataQualityFlag[];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function reconciliationCardState(flags: readonly DataQualityFlag[]): ReconciliationCardState {
  const recon = flags.filter((f) => f.entity === 'reconciliation');
  const basis = flags.filter(isDebtBasisFlag);
  const rows = [...recon, ...basis];
  if (rows.length === 0) return { badgeTone: 'green', badgeLabel: 'Consistent', rows };
  if (rows.some((f) => f.severity === 'error')) return { badgeTone: 'red', badgeLabel: plural(rows.length, 'issue'), rows };
  if (recon.length === 0) return { badgeTone: 'amber', badgeLabel: plural(basis.length, 'debt basis gap'), rows };
  return { badgeTone: 'amber', badgeLabel: plural(rows.length, 'warning'), rows };
}
