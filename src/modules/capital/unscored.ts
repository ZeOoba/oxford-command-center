// src/modules/capital/unscored.ts
//
// The Capital page has two engines keyed by the same property slug: the ledger-based allocation
// verdicts (cards) and the workbook-based cap-rate report (table). The verdict engine needs a ledger
// P&L, so a property with only workbook data (e.g. Fishel, Sunburst) gets a cap-table row and no card.
// This names those properties so the gap is visible instead of looking like an omission.

/** Report properties with no allocation verdict, by name (id when unnamed), alphabetical. */
export function unscoredPropertyNames(
  verdicts: ReadonlyArray<{ propertyId: string }>,
  entries: ReadonlyArray<{ propertyId: string; propertyName: string | null }>,
): string[] {
  const scored = new Set(verdicts.map((v) => v.propertyId));
  return entries
    .filter((e) => !scored.has(e.propertyId))
    .map((e) => e.propertyName ?? e.propertyId)
    .sort((a, b) => a.localeCompare(b));
}
