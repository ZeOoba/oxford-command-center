import type { EntityType, EntityRef } from './ui-context';

/** The view shown for a bare `/` and any unknown module path. */
export const DEFAULT_MODULE = 'overview';

/**
 * The primary entity type a module's `/:id` segment selects. Modules without a
 * primary entity (overview, tasks, market) are absent — their `/:id` is ignored.
 */
export const MODULE_PRIMARY_TYPE: Partial<Record<string, EntityType>> = {
  portfolio: 'property',
  leasing: 'lease',
  obligations: 'insurance',
  pipeline: 'deal',
};

/** Where each entity type's detail drawer lives (inverse of MODULE_PRIMARY_TYPE). */
export const HOME_MODULE: Record<EntityType, string> = {
  property: 'portfolio',
  lease: 'leasing',
  loan: 'capital',
  cashEntity: 'capital',
  insurance: 'obligations',
  counterparty: 'overview',
  deal: 'pipeline',
};

/**
 * Multi-drawer destinations: which entity type `/:moduleId/:id` selects, keyed by `?tab=`
 * (Capital hosts loans on Debt and cash entities on Cash). Single-type modules stay in
 * MODULE_PRIMARY_TYPE and ignore the tab. Populated per destination PR (IA decongestion Phase 4).
 */
export const TAB_PRIMARY_TYPE: Readonly<Record<string, Readonly<Record<string, EntityType>>>> = {
  capital: { debt: 'loan', cash: 'cashEntity' },
};

/** The tab an entity's drawer route lands on when its home module is a multi-tab destination and
 *  the jump comes from ANOTHER module. Same-module jumps keep the user's current tab. */
export const HOME_TAB: Readonly<Partial<Record<EntityType, string>>> = { loan: 'debt', cashEntity: 'cash', insurance: 'insurance', lease: 'rent-roll' };

/**
 * Legacy-module alias table (IA decongestion Phase 4a). A module id that was absorbed into a
 * two-level destination stays a valid URL: `/alerts` → `/worklist?tab=alerts`. The tab is carried
 * in `?tab=` (built by `useTabParam`), NOT a path segment — segment 2 is the entity id
 * (`/debt/:loanId`, `/intel/:propertyId`), so a path tab would be ambiguous with it.
 *
 * `innerViews`: the absorbed module used to own its own `?tab=` strip (calibration:
 * report/pending/log; documents: search/corpus). Inside a destination those become a
 * SegmentedControl on `?view=` (rule R5: no nested tab strips), so an old
 * `/calibration?tab=pending` maps to `/data?tab=calibration&view=pending`.
 */
export interface LegacyAlias {
  destination: string;
  tab: string;
  innerViews?: readonly string[];
}

export const LEGACY_ALIASES: Readonly<Record<string, LegacyAlias>> = {
  tasks: { destination: 'worklist', tab: 'today' },
  alerts: { destination: 'worklist', tab: 'alerts' },
  calendar: { destination: 'worklist', tab: 'calendar' },
  renewals: { destination: 'worklist', tab: 'renewals' },
  calibration: { destination: 'data', tab: 'calibration', innerViews: ['report', 'pending', 'log'] },
  documents: { destination: 'data', tab: 'documents', innerViews: ['search', 'corpus'] },
  debt: { destination: 'capital', tab: 'debt', innerViews: ['positions', 'maturities', 'scorecard'] },
  cash: { destination: 'capital', tab: 'cash' },
  close: { destination: 'capital', tab: 'close' },
  insurance: { destination: 'obligations', tab: 'insurance', innerViews: ['savings', 'register', 'selfinsure'] },
  taxes: { destination: 'obligations', tab: 'taxes', innerViews: ['strategy', 'assessments', 'returns'] },
  'prospect-demand': { destination: 'market', tab: 'demand' },
  leases: { destination: 'leasing', tab: 'rent-roll', innerViews: ['rent-roll', 'rollover'] },
  tenants: { destination: 'leasing', tab: 'tenants' },
  principal: { destination: 'command-brain', tab: 'digest' },
  insights: { destination: 'command-brain', tab: 'insights' },
};

/** Tabs that LEFT a surviving module for another destination (Intel's data-ops tabs → Data) or became a
 *  view of another tab (Brain's Versions → Memory `?view=versions`; `view` is set when present).
 *  `/intel?tab=imports` must not silently fall back to Ownership. */
export const LEGACY_TAB_ALIASES: Readonly<Record<string, Readonly<Record<string, { destination: string; tab: string; view?: string }>>>> = {
  intel: {
    imports: { destination: 'data', tab: 'imports' },
    quality: { destination: 'data', tab: 'quality' },
    mappings: { destination: 'data', tab: 'mappings' },
  },
  'command-brain': {
    versions: { destination: 'command-brain', tab: 'memory', view: 'versions' },
  },
};

/**
 * If `pathname` addresses a legacy module id (or a legacy tab of a surviving module), returns the
 * canonical target (path + search) — every OTHER query param (`scenario`, `still`, …) is preserved.
 * Callers navigate with `replace` so the back button isn't trapped on the alias. Null when the
 * path is already canonical.
 */
export function resolveLegacyRoute(pathname: string, search: string): string | null {
  const segs = pathname.split('/').filter(Boolean);
  const first = segs[0];
  if (!first) return null;
  const params = new URLSearchParams(search);
  const rest = segs.slice(1).map(encodeURIComponent);

  const alias = LEGACY_ALIASES[first];
  if (alias) {
    const inner = params.get('tab');
    if (inner && alias.innerViews?.includes(inner)) params.set('view', inner);
    params.set('tab', alias.tab);
    const qs = params.toString();
    return `/${[alias.destination, ...rest].join('/')}${qs ? `?${qs}` : ''}`;
  }

  const tabAliases = LEGACY_TAB_ALIASES[first];
  const legacyTab = params.get('tab');
  const moved = tabAliases && legacyTab ? tabAliases[legacyTab] : undefined;
  if (moved) {
    params.set('tab', moved.tab);
    if (moved.view) params.set('view', moved.view);
    const qs = params.toString();
    return `/${moved.destination}${qs ? `?${qs}` : ''}`;
  }
  return null;
}

export interface RouteState {
  /** Resolved module id (falls back to DEFAULT_MODULE). */
  moduleId: string;
  /** True when the first path segment was a real module id. */
  known: boolean;
  /** The selected entity (drawer), derived from `/:moduleId/:id`. */
  selected: EntityRef | null;
  /** The intel module's deep-linked property (PFI Phase B.3 item 5) — set ONLY for
   *  `/intel/:propertyId`. Deliberately NOT an `EntityRef`: intel has no MODULE_PRIMARY_TYPE,
   *  so `selected` stays null and the global EntityDrawer never opens for an intel deep link.
   *  This is additive and distinct from the `/portfolio/:id` property drawer. */
  intelPropertyId: string | null;
}

/** Parse a pathname (e.g. "/debt/REDACTED-702") into module + selected entity. */
export function parseRoute(
  pathname: string,
  knownModuleIds: readonly string[],
  tab: string | null = null,
  tabTypes: Readonly<Record<string, Readonly<Record<string, EntityType>>>> = TAB_PRIMARY_TYPE,
): RouteState {
  const segs = pathname.split('/').filter(Boolean);
  const first = segs[0];
  // A legacy id resolves to its destination so the very first render (before AppShell's replace
  // redirect lands) already shows the right module — but only when the destination is registered.
  const legacyAlias = first ? LEGACY_ALIASES[first] : undefined;
  const legacyDest = legacyAlias?.destination;
  const direct = !!first && knownModuleIds.includes(first);
  const viaAlias = !direct && !!legacyDest && knownModuleIds.includes(legacyDest);
  const known = direct || viaAlias;
  const moduleId = direct ? first! : viaAlias ? legacyDest! : DEFAULT_MODULE;
  // First render of `/debt/l1` (before AppShell's replace-redirect adds ?tab=debt): the alias row
  // already knows the tab, so the drawer opens without a flash.
  const effectiveTab = tab ?? (viaAlias ? legacyAlias!.tab : null);
  const entityId = segs[1] ? decodeURIComponent(segs[1]) : null;
  const type = (effectiveTab ? tabTypes[moduleId]?.[effectiveTab] : undefined) ?? MODULE_PRIMARY_TYPE[moduleId];
  const selected: EntityRef | null = entityId && type ? { type, id: entityId } : null;
  const intelPropertyId = moduleId === 'intel' && entityId ? entityId : null;
  return { moduleId, known, selected, intelPropertyId };
}

/** The shareable path for an entity — its home module + id. */
export function entityPath(ref: EntityRef): string {
  return `/${HOME_MODULE[ref.type]}/${encodeURIComponent(ref.id)}`;
}

/**
 * The full drawer URL for an entity, given the current query string and the module the click came
 * from. Cross-module: drop `tab`/`view` (they belong to the page being left — with shared tab ids a
 * stale one is valid-but-wrong) and land on the entity's home tab. Same-module: keep `tab`/`view`
 * UNCHANGED when the current tab already hosts the entity's drawer (a single-type module hosts it on
 * every tab; a multi-drawer destination hosts it only on its declared tab). Otherwise — e.g. a loan
 * opened from Capital's Cash or Allocation tab, where no loan drawer would open — switch to the
 * entity's home tab and drop `view`. Types with no home tab are left alone.
 */
export function entityHref(
  ref: EntityRef,
  search: string,
  fromModuleId: string,
  homes: {
    module: Record<EntityType, string>;
    tab: Partial<Record<EntityType, string>>;
    /** Defaults to the real TAB_PRIMARY_TYPE (fixture injection for tests). */
    tabTypes?: Readonly<Record<string, Readonly<Record<string, EntityType>>>>;
    /** Defaults to the real MODULE_PRIMARY_TYPE (fixture injection for tests). */
    moduleTypes?: Readonly<Partial<Record<string, EntityType>>>;
  } = { module: HOME_MODULE, tab: HOME_TAB },
): string {
  const params = new URLSearchParams(search);
  const homeModule = homes.module[ref.type];
  const homeTab = homes.tab[ref.type];
  if (homeModule !== fromModuleId) {
    params.delete('tab');
    params.delete('view');
    if (homeTab) params.set('tab', homeTab);
  } else if (homeTab) {
    const currentTab = params.get('tab');
    const tabTypes = homes.tabTypes ?? TAB_PRIMARY_TYPE;
    const moduleTypes = homes.moduleTypes ?? MODULE_PRIMARY_TYPE;
    const hosted =
      (currentTab != null && tabTypes[homeModule]?.[currentTab] === ref.type) ||
      moduleTypes[homeModule] === ref.type;
    if (!hosted) {
      params.delete('view');
      params.set('tab', homeTab);
    }
  }
  const qs = params.toString();
  return `/${homeModule}/${encodeURIComponent(ref.id)}${qs ? `?${qs}` : ''}`;
}

/** The shareable path for an intel deep link (PFI Phase B.3 item 5) — `/intel/:propertyId`.
 *  Separate from `entityPath` so a property reference inside the intel module links to the
 *  intel Property tab, not the portfolio drawer. */
export function intelPropertyPath(propertyId: string): string {
  return `/intel/${encodeURIComponent(propertyId)}`;
}
