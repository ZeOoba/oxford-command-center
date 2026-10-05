// src/modules/property-financials/views.ts
//
// The module's in-destination views (the reference artifact's tab strip). Selected via `?view=`; the
// Explorer also reads `?p=<entity id>`. Six views exceed MAX_TABS_PER_DESTINATION (5), so they are an
// internal strip, not registry tabs (src/shell/modules.tsx). The artifact's seventh tab, "Command
// center data", becomes the live data-health panel in the Data destination (plan T8).

export const PF_VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'explorer', label: 'Property explorer' },
  { id: 'scorecard', label: 'Scorecard table' },
  { id: 'levers', label: 'Rent & NOI levers' },
  { id: 'watchlist', label: 'Expense watchlist' },
  { id: 'evaluation', label: 'Evaluation scorecard' },
] as const;

export type PfViewId = (typeof PF_VIEWS)[number]['id'];

export const PF_VIEW_IDS: readonly PfViewId[] = PF_VIEWS.map((v) => v.id);

/** Search params the module owns besides `view`. */
export const PF_PROPERTY_PARAM = 'p';
