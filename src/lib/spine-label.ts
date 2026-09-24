/** User-facing basis names. "Spine A/B" is internal architecture vocabulary (CLAUDE.md §1). */
export function spineLabel(spine: 'A' | 'B' | 'cross'): string {
  return spine === 'A' ? 'Workbook' : spine === 'B' ? 'Ledger' : 'Combined';
}
