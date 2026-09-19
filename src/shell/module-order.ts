import { MODULES, type ModuleDef } from './modules';
import type { ViewProfile } from '@/brain/view-profile';

/** Rail order per profile (flat module-id lists). Capital ahead of Assets for the principal. */
export const MODULE_ORDER: Record<ViewProfile, string[]> = {
  acquisitions: ['overview', 'pipeline', 'worklist', 'principal', 'portfolio', 'intel', 'leases', 'debt', 'cash', 'insurance', 'market', 'data', 'health'],
  principal: ['principal', 'overview', 'worklist', 'cash', 'debt', 'insurance', 'portfolio', 'intel', 'leases', 'market', 'pipeline', 'data', 'health'],
};

/** Where each profile lands from `/`. */
export const PROFILE_HOME: Record<ViewProfile, string> = {
  acquisitions: 'pipeline',
  principal: 'principal',
};

/** Registry sorted by the profile's order; unlisted ids append at the end (never disappear). */
export function orderedModules(profile: ViewProfile, modules: ModuleDef[] = MODULES): ModuleDef[] {
  const order = MODULE_ORDER[profile];
  const rank = (id: string) => { const i = order.indexOf(id); return i === -1 ? order.length : i; };
  return [...modules].sort((a, b) => rank(a.id) - rank(b.id));
}

/** The sidebar rail: the ordered registry minus modules that opt out (`rail: false`, e.g. System Health). */
export function railModules(profile: ViewProfile, modules: ModuleDef[] = MODULES): ModuleDef[] {
  return orderedModules(profile, modules).filter((m) => m.rail !== false);
}
