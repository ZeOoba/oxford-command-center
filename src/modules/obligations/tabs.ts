// Obligations destination tab declaration (IA decongestion Phase 4c). React-free so the registry and
// the palette can index tabs without importing the Insurance/Taxes chunks. Legacy ids insurance/taxes
// alias here (src/brain/routing.ts LEGACY_ALIASES).
import type { ModuleTabDef } from '@/shell/tab-types';

export type ObligationsTab = 'insurance' | 'taxes';

export const OBLIGATIONS_TABS: readonly ModuleTabDef[] = [
  { id: 'insurance', label: 'Insurance', aliases: ['policies', 'coverage', 'renewal', 'premium'] },
  { id: 'taxes', label: 'Taxes', aliases: ['assessments', 'millage', 'appeals', 'cost seg'] },
];
