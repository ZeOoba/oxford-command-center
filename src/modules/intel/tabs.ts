// Financials (module id `intel`) tab declaration — the five INTELLIGENCE tabs. The three data-ops
// tabs (Imports · Quality · Mappings) moved to the Data destination in IA decongestion Phase 4a.
// Kept in a tiny React-free file so the module registry / command palette can index these tabs
// without importing IntelModule (and its chunk) into the entry bundle.
import type { ModuleTabDef } from '@/shell/tab-types';

export type IntelTab = 'ownership' | 'property' | 'lease-run' | 'benchmarks' | 'managers';

export const INTEL_TABS: readonly ModuleTabDef[] = [
  { id: 'ownership', label: 'Ownership' },
  { id: 'property', label: 'Property' },
  { id: 'lease-run', label: 'Lease Run' },
  { id: 'benchmarks', label: 'Benchmarks' },
  { id: 'managers', label: 'Managers' },
];

export const INTEL_TAB_KEYS: readonly IntelTab[] = ['ownership', 'property', 'lease-run', 'benchmarks', 'managers'];
