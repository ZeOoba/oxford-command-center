/** User-facing basis names. "Spine A/B" is internal architecture vocabulary (CLAUDE.md §1). */
export function spineLabel(spine: 'A' | 'B' | 'cross'): string {
  return spine === 'A' ? 'Workbook' : spine === 'B' ? 'Ledger' : 'Combined';
}

/**
 * Display label for a server `noiBasis` wire value (debt-scoring.ts emits 'spine-b/warehouse-ledger';
 * capital-allocation emits 'spine-a'). Maps at render time only — the wire value itself is a data
 * contract and is never changed. Unknown values pass through unchanged.
 */
export function noiBasisLabel(basis: string): string {
  if (basis === 'spine-b/warehouse-ledger') return 'Ledger (warehouse)';
  if (basis.startsWith('spine-a')) return 'Workbook';
  return basis;
}
