/** TopBar page-title overrides per destination id; ids without an entry fall back to the module's rail label.
 *  Every key must be a registered module id (guarded in tests/unit/ia-registry.test.ts). */
export const TITLES: Record<string, string> = {
  overview: 'Command Overview',
  pipeline: 'Acquisitions Pipeline',
  portfolio: 'Portfolio Health',
  'property-financials': 'Property Financials',
  intel: 'Financials',
  worklist: 'Worklist',
  data: 'Data',
  capital: 'Capital & Treasury',
  'property-condition': 'Property Condition',
  leasing: 'Leasing & Tenants',
  obligations: 'Insurance & Taxes',
  'command-brain': 'Brain',
  market: 'Market & Macro',
  health: 'System Health',
};
