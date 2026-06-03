import type { EntityType, EntityRef } from './ui-context';

/** The view shown for a bare `/` and any unknown module path. */
export const DEFAULT_MODULE = 'overview';

/**
 * The primary entity type a module's `/:id` segment selects. Modules without a
 * primary entity (overview, tasks, market) are absent — their `/:id` is ignored.
 */
export const MODULE_PRIMARY_TYPE: Partial<Record<string, EntityType>> = {
  portfolio: 'property',
  leases: 'lease',
  debt: 'loan',
  cash: 'cashEntity',
  insurance: 'insurance',
  relationships: 'counterparty',
  pipeline: 'deal',
};

/** Where each entity type's detail drawer lives (inverse of MODULE_PRIMARY_TYPE). */
export const HOME_MODULE: Record<EntityType, string> = {
  property: 'portfolio',
  lease: 'leases',
  loan: 'debt',
  cashEntity: 'cash',
  insurance: 'insurance',
  counterparty: 'relationships',
  deal: 'pipeline',
};

export interface RouteState {
  /** Resolved module id (falls back to DEFAULT_MODULE). */
  moduleId: string;
  /** True when the first path segment was a real module id. */
  known: boolean;
  /** The selected entity (drawer), derived from `/:moduleId/:id`. */
  selected: EntityRef | null;
}

/** Parse a pathname (e.g. "/debt/REDACTED-702") into module + selected entity. */
export function parseRoute(pathname: string, knownModuleIds: readonly string[]): RouteState {
  const segs = pathname.split('/').filter(Boolean);
  const first = segs[0];
  const known = !!first && knownModuleIds.includes(first);
  const moduleId = known ? first! : DEFAULT_MODULE;
  const entityId = segs[1] ? decodeURIComponent(segs[1]) : null;
  const type = MODULE_PRIMARY_TYPE[moduleId];
  const selected: EntityRef | null = entityId && type ? { type, id: entityId } : null;
  return { moduleId, known, selected };
}

/** The shareable path for an entity — its home module + id. */
export function entityPath(ref: EntityRef): string {
  return `/${HOME_MODULE[ref.type]}/${encodeURIComponent(ref.id)}`;
}
