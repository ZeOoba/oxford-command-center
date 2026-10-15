// src/modules/property-condition/views.ts
//
// The module's in-destination views. Selected via `?view=`. Eight views exceed MAX_TABS_PER_DESTINATION (5)
// only marginally, but the destination is a standalone rail entry (group 'Capital'), so — like Property
// Financials — they are an internal SegmentedControl strip, not registry tabs (src/shell/modules.tsx).
// Capital itself is already at the 5-tab cap, which is why this is not a sixth Capital tab.

export const PC_VIEWS = [
  { id: 'outlook', label: 'Capex outlook' },
  { id: 'schedule', label: 'Replacement schedule' },
  { id: 'calibration', label: 'Estimate vs actual' },
  { id: 'prices', label: 'Quotes & prices' },
  { id: 'open', label: 'Open items' },
  { id: 'infolane', label: '29000 Info Ln' },
  { id: 'specs', label: 'Building specs' },
  { id: 'costseg', label: 'Cost seg' },
] as const;

export type PcViewId = (typeof PC_VIEWS)[number]['id'];

export const PC_VIEW_IDS: readonly PcViewId[] = PC_VIEWS.map((v) => v.id);
