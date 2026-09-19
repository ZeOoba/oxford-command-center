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
