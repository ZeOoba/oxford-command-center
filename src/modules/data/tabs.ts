// Data destination tab declaration (IA decongestion Phase 4a). React-free so the registry /
// palette can index it without importing DataModule.
import type { ModuleTabDef } from '@/shell/tab-types';

export type DataTab = 'imports' | 'quality' | 'mappings' | 'calibration' | 'documents';

export const DATA_TABS: readonly ModuleTabDef[] = [
  { id: 'imports', label: 'Imports' },
  { id: 'quality', label: 'Quality', aliases: ['data quality', 'issues'] },
  { id: 'mappings', label: 'Mappings' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'documents', label: 'Documents' },
];

export const DATA_TAB_KEYS: readonly DataTab[] = ['imports', 'quality', 'mappings', 'calibration', 'documents'];

/** The three warehouse data-ops tabs carry the portfolio data-ops KPI band above the strip. */
export const DATA_OPS_TABS: ReadonlySet<DataTab> = new Set<DataTab>(['imports', 'quality', 'mappings']);

/**
 * The Quality tab's `?view=` switch (R5: a SegmentedControl, never a nested strip). The tab strip is
 * already at MAX_TABS_PER_DESTINATION, so the Property Financials data-health panel (plan T8, the
 * reference artifact's "Command center data" tab made live) is a second view of Quality rather than
 * a sixth tab: Warehouse (default) · Property Financials.
 */
export type DataQualityView = 'warehouse' | 'property-financials';

export const DATA_QUALITY_VIEWS: ReadonlyArray<{ value: DataQualityView; label: string }> = [
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'property-financials', label: 'Property Financials' },
];

export const DATA_QUALITY_VIEW_KEYS: readonly DataQualityView[] = DATA_QUALITY_VIEWS.map((v) => v.value);

/** Deep link to the Property Financials data-health panel (used by the module's summary card). */
export const PF_DATA_HEALTH_HREF = '/data?tab=quality&view=property-financials';
