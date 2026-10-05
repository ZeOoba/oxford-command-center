// IA decongestion Phase 4a — the two-level registry: legacy-id resolution, alias redirects, the
// max-tabs house rule, and rail composition. (Component-level destination tests live in
// worklist-destination / data-destination / financials-tabs.)
import { describe, it, expect, vi } from 'vitest';

// The registry imports the Worklist alerts-badge hook, which reaches the data layer. It is never
// invoked in these registry-shape tests.
vi.mock('../../src/shell/tab-badges', () => ({
  useAlertsTabBadge: () => undefined,
  useCriticalDatesTabBadge: () => undefined,
  useTabBadges: (tabs: ReadonlyArray<unknown>) => tabs.map(() => undefined),
  useTabSpecs: (tabs: ReadonlyArray<{ id: string; label: string }>) => tabs.map((t) => ({ id: t.id, label: t.label })),
}));

import { MODULES } from '../../src/shell/modules';
import { TITLES } from '../../src/shell/titles';
import { railModules, orderedModules, MODULE_ORDER, PROFILE_HOME } from '../../src/shell/module-order';
import { MAX_TABS_PER_DESTINATION, tabCapViolation, warnIfTooManyTabs, type ModuleTabDef } from '../../src/shell/tab-types';
import {
  LEGACY_ALIASES,
  parseRoute,
  resolveLegacyRoute,
  DEFAULT_MODULE,
  MODULE_PRIMARY_TYPE,
  HOME_MODULE,
} from '../../src/brain/routing';

/** Every module id that existed on origin/main's MODULES before Phase 4a (26). */
const LEGACY_MODULE_IDS = [
  'overview', 'principal', 'pipeline', 'tasks', 'alerts', 'calendar', 'renewals', 'insights', 'command-brain',
  'portfolio', 'intel', 'calibration', 'leases', 'leasing', 'prospect-demand', 'tenants',
  'capital', 'debt', 'cash', 'close', 'insurance', 'taxes',
  'market', 'lease-market', 'documents', 'health',
] as const;

const IDS = MODULES.map((m) => m.id);
const byId = (id: string) => MODULES.find((m) => m.id === id);

describe('legacy module ids (26) all resolve to a live destination + tab', () => {
  it('there are exactly 26 legacy ids in the fixture', () => {
    expect(new Set(LEGACY_MODULE_IDS).size).toBe(26);
  });

  for (const id of LEGACY_MODULE_IDS) {
    it(`/${id} resolves`, () => {
      const direct = byId(id);
      if (direct) {
        // Surviving module: known, no redirect needed.
        expect(parseRoute(`/${id}`, IDS)).toMatchObject({ moduleId: id, known: true });
        expect(resolveLegacyRoute(`/${id}`, '')).toBeNull();
        return;
      }
      // Absorbed module: the alias table names a registered destination and one of ITS tabs.
      const alias = LEGACY_ALIASES[id];
      expect(alias, `${id} is neither registered nor aliased`).toBeDefined();
      const dest = byId(alias!.destination);
      expect(dest, `alias destination ${alias!.destination} is not registered`).toBeDefined();
      expect(dest!.tabs?.some((t) => t.id === alias!.tab), `${alias!.destination} has no tab ${alias!.tab}`).toBe(true);
      // First render (before the redirect lands) already shows the destination.
      expect(parseRoute(`/${id}`, IDS)).toMatchObject({ moduleId: alias!.destination, known: true });
      expect(resolveLegacyRoute(`/${id}`, '')).toBe(`/${alias!.destination}?tab=${alias!.tab}`);
    });
  }

  it('an alias never shadows a registered module id', () => {
    for (const id of Object.keys(LEGACY_ALIASES)) expect(IDS).not.toContain(id);
  });
});

describe('resolveLegacyRoute', () => {
  it('maps the ratified examples', () => {
    expect(resolveLegacyRoute('/tasks', '')).toBe('/worklist?tab=today');
    expect(resolveLegacyRoute('/alerts', '')).toBe('/worklist?tab=alerts');
    expect(resolveLegacyRoute('/calibration', '')).toBe('/data?tab=calibration');
    expect(resolveLegacyRoute('/documents', '')).toBe('/data?tab=documents');
  });

  it('preserves ?scenario= and ?still= (and any other param)', () => {
    const to = resolveLegacyRoute('/alerts', '?scenario=Downside&still=1&x=y')!;
    const q = new URLSearchParams(to.split('?')[1]);
    expect(to.startsWith('/worklist?')).toBe(true);
    expect(q.get('tab')).toBe('alerts');
    expect(q.get('scenario')).toBe('Downside');
    expect(q.get('still')).toBe('1');
    expect(q.get('x')).toBe('y');
  });

  it('turns a legacy inner ?tab= into ?view= (calibration + documents)', () => {
    expect(resolveLegacyRoute('/calibration', '?tab=pending')).toBe('/data?tab=calibration&view=pending');
    expect(resolveLegacyRoute('/documents', '?tab=corpus&still=1')).toBe('/data?tab=documents&still=1&view=corpus');
  });

  it("redirects Intel's departed data-ops tabs to Data, leaving intelligence tabs alone", () => {
    expect(resolveLegacyRoute('/intel', '?tab=imports')).toBe('/data?tab=imports');
    expect(resolveLegacyRoute('/intel', '?tab=quality&scenario=Upside')).toBe('/data?tab=quality&scenario=Upside');
    expect(resolveLegacyRoute('/intel', '?tab=mappings')).toBe('/data?tab=mappings');
    expect(resolveLegacyRoute('/intel', '?tab=benchmarks')).toBeNull();
    expect(resolveLegacyRoute('/intel/9050-red-branch', '')).toBeNull();
  });

  it('canonical destination URLs and unknown paths do not redirect', () => {
    expect(resolveLegacyRoute('/worklist', '?tab=alerts')).toBeNull();
    expect(resolveLegacyRoute('/data', '')).toBeNull();
    expect(resolveLegacyRoute('/nope', '')).toBeNull();
    expect(resolveLegacyRoute('/', '')).toBeNull();
  });
});

describe('every existing entity deep link still works', () => {
  it('MODULE_PRIMARY_TYPE / HOME_MODULE only point at registered modules', () => {
    for (const id of Object.keys(MODULE_PRIMARY_TYPE)) expect(IDS).toContain(id);
    for (const id of Object.values(HOME_MODULE)) expect(IDS).toContain(id);
  });

  it('entity + intel deep links parse against the real registry', () => {
    expect(parseRoute('/portfolio/9050-red-branch', IDS).selected).toEqual({ type: 'property', id: '9050-red-branch' });
    expect(parseRoute('/debt/borrower-restoration', IDS).selected).toEqual({ type: 'loan', id: 'borrower-restoration' });
    expect(parseRoute('/leases/x', IDS).selected).toEqual({ type: 'lease', id: 'x' });
    expect(parseRoute('/intel/9050-red-branch', IDS)).toMatchObject({ moduleId: 'intel', intelPropertyId: '9050-red-branch', selected: null });
    // /health still resolves although it left the rail.
    expect(parseRoute('/health', IDS)).toMatchObject({ moduleId: 'health', known: true });
  });

  it('an unregistered destination does not resolve an alias (fails closed to the default)', () => {
    expect(parseRoute('/alerts', ['overview'])).toMatchObject({ moduleId: DEFAULT_MODULE, known: false });
  });
});

describe('house rule: max 5 tabs per destination', () => {
  it('no registered destination exceeds the cap', () => {
    for (const m of MODULES) {
      expect(tabCapViolation(m.id, m.tabs), m.id).toBeNull();
      expect((m.tabs ?? []).length).toBeLessThanOrEqual(MAX_TABS_PER_DESTINATION);
    }
  });

  it('flags a 6-tab destination', () => {
    const six: ModuleTabDef[] = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, label: `T${i}` }));
    expect(tabCapViolation('x', six)).toMatch(/6 tabs/);
    expect(tabCapViolation('x', six.slice(0, 5))).toBeNull();
    expect(tabCapViolation('x', undefined)).toBeNull();
  });

  it('dev-warns (console.warn) for an over-cap destination and stays silent within the cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const six: ModuleTabDef[] = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, label: `T${i}` }));
    warnIfTooManyTabs('big', six.slice(0, 5));
    expect(warn).not.toHaveBeenCalled();
    warnIfTooManyTabs('big', six);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/"big" declares 6 tabs/);
    warn.mockRestore();
  });

  it('tab ids are unique within a destination', () => {
    for (const m of MODULES) {
      const ids = (m.tabs ?? []).map((t) => t.id);
      expect(new Set(ids).size, m.id).toBe(ids.length);
    }
  });
});

describe('rail composition', () => {
  it('Phase 4a destinations are registered; absorbed ids are not', () => {
    for (const id of ['worklist', 'data', 'intel', 'health']) expect(IDS).toContain(id);
    for (const id of ['tasks', 'alerts', 'calendar', 'renewals', 'calibration', 'documents']) expect(IDS).not.toContain(id);
    expect(byId('intel')!.label).toBe('Financials');
    expect(byId('worklist')!.tabs!.map((t) => t.id)).toEqual(['today', 'alerts', 'calendar', 'renewals']);
    expect(byId('data')!.tabs!.map((t) => t.id)).toEqual(['imports', 'quality', 'mappings', 'calibration', 'documents']);
    expect(byId('intel')!.tabs!.map((t) => t.id)).toEqual(['ownership', 'property', 'lease-run', 'benchmarks', 'managers']);
  });

  it('PR-B: Capital is a 5-tab destination; debt/cash/close are absorbed', () => {
    expect(byId('capital')!.tabs!.map((t) => t.id)).toEqual(['allocation', 'pipeline', 'debt', 'cash', 'close']);
    for (const id of ['debt', 'cash', 'close']) expect(IDS).not.toContain(id);
    expect(resolveLegacyRoute('/debt', '?tab=scorecard')).toBe('/capital?tab=debt&view=scorecard');
    expect(resolveLegacyRoute('/debt/borrower-restoration', '')).toBe('/capital/borrower-restoration?tab=debt');
    expect(resolveLegacyRoute('/cash/acct-1', '?scenario=Downside')).toBe('/capital/acct-1?scenario=Downside&tab=cash');
    expect(resolveLegacyRoute('/close', '')).toBe('/capital?tab=close');
  });

  it('the loan and cash drawers resolve inside Capital', () => {
    expect(parseRoute('/capital/l1', IDS, 'debt').selected).toEqual({ type: 'loan', id: 'l1' });
    expect(parseRoute('/capital/a1', IDS, 'cash').selected).toEqual({ type: 'cashEntity', id: 'a1' });
    expect(parseRoute('/debt/l1', IDS).selected).toEqual({ type: 'loan', id: 'l1' }); // first-render alias
    expect(parseRoute('/cash/a1', IDS).selected).toEqual({ type: 'cashEntity', id: 'a1' }); // first-render alias
  });

  it('PR-C: Obligations = Insurance · Taxes; insurance/taxes are absorbed', () => {
    expect(byId('obligations')!.tabs!.map((t) => t.id)).toEqual(['insurance', 'taxes']);
    expect(byId('obligations')!.group).toBe('Capital');
    for (const id of ['insurance', 'taxes']) expect(IDS).not.toContain(id);
    expect(resolveLegacyRoute('/insurance', '?tab=selfinsure')).toBe('/obligations?tab=insurance&view=selfinsure');
    expect(resolveLegacyRoute('/insurance', '')).toBe('/obligations?tab=insurance');
    expect(resolveLegacyRoute('/insurance/pol-1', '')).toBe('/obligations/pol-1?tab=insurance');
    expect(resolveLegacyRoute('/taxes', '?tab=returns')).toBe('/obligations?tab=taxes&view=returns');
    expect(resolveLegacyRoute('/taxes', '?scenario=Downside')).toBe('/obligations?scenario=Downside&tab=taxes');
    expect(parseRoute('/obligations/pol-1', IDS, 'insurance').selected).toEqual({ type: 'insurance', id: 'pol-1' });
    expect(parseRoute('/obligations/pol-1', IDS, 'taxes').selected).toEqual({ type: 'insurance', id: 'pol-1' }); // single-type: every tab hosts it
    expect(parseRoute('/insurance/pol-1', IDS).selected).toEqual({ type: 'insurance', id: 'pol-1' }); // first-render alias
  });

  it('PR-C: Market = Macro · Scorecards · Comps · Demand; prospect-demand is absorbed', () => {
    expect(byId('market')!.tabs!.map((t) => t.id)).toEqual(['macro', 'scorecards', 'comps', 'demand']);
    expect(IDS).not.toContain('prospect-demand');
    expect(resolveLegacyRoute('/prospect-demand', '')).toBe('/market?tab=demand');
  });

  it('PR-D: Leasing = Rollover · Rent roll · Forecast · Market rents · Tenants; leases/tenants are absorbed', () => {
    expect(byId('leasing')!.tabs!.map((t) => t.id)).toEqual(['rollover', 'rent-roll', 'forecast', 'market-rents', 'tenants']);
    expect(byId('leasing')!.label).toBe('Leasing');
    for (const id of ['leases', 'tenants']) expect(IDS).not.toContain(id);
    expect(resolveLegacyRoute('/leases', '')).toBe('/leasing?tab=rent-roll');
    expect(resolveLegacyRoute('/leases', '?tab=rollover')).toBe('/leasing?tab=rent-roll&view=rollover');
    expect(resolveLegacyRoute('/leases', '?tab=rent-roll')).toBe('/leasing?tab=rent-roll&view=rent-roll');
    expect(resolveLegacyRoute('/leases/lease-9', '')).toBe('/leasing/lease-9?tab=rent-roll');
    expect(resolveLegacyRoute('/leases', '?scenario=Downside')).toBe('/leasing?scenario=Downside&tab=rent-roll');
    expect(resolveLegacyRoute('/tenants', '')).toBe('/leasing?tab=tenants');
    expect(parseRoute('/leasing/lease-9', IDS, 'tenants').selected).toEqual({ type: 'lease', id: 'lease-9' });
    expect(parseRoute('/leases/lease-9', IDS).selected).toEqual({ type: 'lease', id: 'lease-9' }); // first-render alias
    // the surviving /leasing URL (bare or tabbed) does not redirect
    expect(resolveLegacyRoute('/leasing', '?tab=forecast')).toBeNull();
  });

  it('PR-D: the rail lists Leasing exactly where Leases stood, and no profile still names the old ids', () => {
    for (const profile of ['acquisitions', 'principal'] as const) {
      expect(MODULE_ORDER[profile]).toContain('leasing');
      expect(MODULE_ORDER[profile]).not.toContain('leases');
      expect(MODULE_ORDER[profile]).not.toContain('tenants');
    }
    expect(MODULE_ORDER.acquisitions.indexOf('leasing')).toBe(MODULE_ORDER.acquisitions.indexOf('intel') + 1);
    expect(MODULE_ORDER.principal.indexOf('leasing')).toBe(MODULE_ORDER.principal.indexOf('intel') + 1);
  });

  it('PR-E: Brain = Digest · Insights · Track record · Feedback · Memory; Versions became a Memory view', () => {
    expect(byId('command-brain')!.tabs!.map((t) => t.id)).toEqual(['digest', 'insights', 'track-record', 'feedback', 'memory']);
    expect(byId('command-brain')!.label).toBe('Brain');
    for (const id of ['principal', 'insights']) expect(IDS).not.toContain(id);
    expect(resolveLegacyRoute('/principal', '')).toBe('/command-brain?tab=digest');
    expect(resolveLegacyRoute('/insights', '')).toBe('/command-brain?tab=insights');
    expect(resolveLegacyRoute('/command-brain', '?tab=versions')).toBe('/command-brain?tab=memory&view=versions');
    // every other param survives the moved-tab redirect; a canonical Memory URL does not redirect
    const moved = resolveLegacyRoute('/command-brain', '?tab=versions&scenario=Upside');
    const [movedPath, movedQuery] = (moved ?? '').split('?');
    expect(movedPath).toBe('/command-brain');
    expect([...new URLSearchParams(movedQuery).entries()].sort()).toEqual([['scenario', 'Upside'], ['tab', 'memory'], ['view', 'versions']]);
    expect(resolveLegacyRoute('/command-brain', '?tab=memory')).toBeNull();
    expect(resolveLegacyRoute('/command-brain', '?tab=memory&view=versions')).toBeNull();
    expect(parseRoute('/principal', IDS)).toMatchObject({ moduleId: 'command-brain', known: true }); // first-render alias
    expect(PROFILE_HOME.principal).toBe('command-brain');
    for (const profile of ['acquisitions', 'principal'] as const) {
      expect(MODULE_ORDER[profile]).toContain('command-brain');
      expect(MODULE_ORDER[profile]).not.toContain('principal');
    }
  });

  for (const profile of ['acquisitions', 'principal'] as const) {
    it(`${profile}: System Health is off the rail but every other module still shows`, () => {
      const rail = railModules(profile).map((m) => m.id);
      expect(rail).not.toContain('health');
      expect(rail).toEqual(expect.arrayContaining(IDS.filter((id) => id !== 'health')));
      expect(orderedModules(profile).map((m) => m.id)).toContain('health'); // still registered/routable
    });

    it(`${profile}: the order list names only registered ids and lands on a resolvable route`, () => {
      for (const id of MODULE_ORDER[profile]) expect(IDS, id).toContain(id);
      expect(IDS).toContain(PROFILE_HOME[profile]);
      expect(MODULE_ORDER[profile]).toContain('worklist');
      expect(MODULE_ORDER[profile]).toContain('data');
    });
  }

  it('every rail group has at least one item (no empty group labels)', () => {
    const rail = railModules('acquisitions');
    const groups = new Set(rail.map((m) => m.group));
    expect([...groups].sort()).toEqual(['Assets', 'Capital', 'Command', 'Market', 'System']);
  });
});

describe('final rail (IA decongestion Phase 4 complete)', () => {
  // 'property-financials' joined Assets on Gabriel's in-turn ruling (2026-10-05, standalone destination;
  // docs/superpowers/plans/2026-10-05-property-financials-module.md).
  const RAIL = ['overview', 'pipeline', 'worklist', 'command-brain', 'portfolio', 'property-financials', 'intel', 'leasing', 'capital', 'obligations', 'market', 'lease-market', 'data'];
  for (const profile of ['acquisitions', 'principal'] as const) {
    it(`${profile}: exactly the 13 ratified destinations, none empty, none over 5 tabs`, () => {
      const rail = railModules(profile);
      expect(rail.map((m) => m.id).sort()).toEqual([...RAIL].sort());
      for (const m of rail) expect((m.tabs ?? []).length, m.id).toBeLessThanOrEqual(MAX_TABS_PER_DESTINATION);
    });
    it(`${profile}: MODULE_ORDER lists every rail id (nothing relies on the append-unlisted fallback)`, () => {
      for (const id of RAIL) expect(MODULE_ORDER[profile], id).toContain(id);
    });
  }
  it('rail groups are Command(4) / Assets(4) / Capital(2) / Market(2) / System(1)', () => {
    const counts: Record<string, number> = {};
    for (const m of railModules('acquisitions')) counts[m.group] = (counts[m.group] ?? 0) + 1;
    expect(counts).toEqual({ Command: 4, Assets: 4, Capital: 2, Market: 2, System: 1 });
  });
  it('every legacy id (26) still resolves to a rail destination (or Health)', () => {
    for (const id of LEGACY_MODULE_IDS) {
      const target = byId(id)?.id ?? LEGACY_ALIASES[id]?.destination;
      expect([...RAIL, 'health'], id).toContain(target);
    }
  });
});

// Final whole-branch review (FIX 5): Acquisitions and Lease Market render in-module tab strips but
// never declared them as `ModuleDef.tabs`, so the palette had no "Destination > Tab" entries for
// them and the max-5 cap guard above never saw lease-market (which is AT the cap). This table is
// the exhaustive registry lock: every rail destination is either listed here with its exact tab ids
// or named in TABLESS.
describe('every rail destination declares its tab strip in the registry', () => {
  const DESTINATION_TABS: Record<string, readonly string[]> = {
    pipeline: ['pipeline', 'workbench', 'sourcing', 'grader', 'edge'],
    worklist: ['today', 'alerts', 'calendar', 'renewals'],
    'command-brain': ['digest', 'insights', 'track-record', 'feedback', 'memory'],
    intel: ['ownership', 'property', 'lease-run', 'benchmarks', 'managers'],
    leasing: ['rollover', 'rent-roll', 'forecast', 'market-rents', 'tenants'],
    capital: ['allocation', 'pipeline', 'debt', 'cash', 'close'],
    obligations: ['insurance', 'taxes'],
    portfolio: ['properties', 'trends', 'expenses'],
    market: ['macro', 'scorecards', 'comps', 'demand'],
    'lease-market': ['portfolio', 'market-rents', 'radar', 'changes', 'data-quality'],
    data: ['imports', 'quality', 'mappings', 'calibration', 'documents'],
  };
  /** The only rail destinations that legitimately render no strip. */
  const TABLESS = ['overview'];
  /** Rail destinations whose views are an in-module `?view=` strip ABOVE the 5-tab cap, so they
   *  declare no registry tabs (the palette indexes the destination itself). */
  const INTERNAL_VIEW_STRIP = ['property-financials'];

  it('the rail destinations split exactly into the tabbed ones, the tabless one and the internal-strip one', () => {
    expect(railModules('acquisitions').map((m) => m.id).sort()).toEqual(
      [...Object.keys(DESTINATION_TABS), ...TABLESS, ...INTERNAL_VIEW_STRIP].sort(),
    );
  });

  for (const [id, ids] of Object.entries(DESTINATION_TABS)) {
    it(`${id} declares [${ids.join(', ')}] — in order, unique, within the cap`, () => {
      const tabs = byId(id)?.tabs;
      expect(tabs?.map((t) => t.id), id).toEqual([...ids]);
      expect(new Set(ids).size, id).toBe(ids.length);
      expect(tabCapViolation(id, tabs), id).toBeNull();
      // Every declared tab carries a non-empty label (the palette indexes "Destination > Tab").
      for (const t of tabs ?? []) expect(t.label.length, `${id}.${t.id}`).toBeGreaterThan(0);
    });
  }

  for (const id of [...TABLESS, ...INTERNAL_VIEW_STRIP]) {
    it(`${id} declares no tabs`, () => expect(byId(id)?.tabs).toBeUndefined());
  }

  it('lease-market sits AT the cap — the guard now actually sees it', () => {
    expect(byId('lease-market')!.tabs).toHaveLength(MAX_TABS_PER_DESTINATION);
  });
});

describe('TopBar page titles (src/shell/titles.ts)', () => {
  it('every TITLES key is a registered module id (no stale absorbed-module titles)', () => {
    for (const key of Object.keys(TITLES)) expect(IDS, key).toContain(key);
  });
  it('the merged destinations carry their ratified page titles; Overview is unchanged', () => {
    expect(TITLES.overview).toBe('Command Overview');
    expect(TITLES.capital).toBe('Capital & Treasury');
    expect(TITLES.leasing).toBe('Leasing & Tenants');
    expect(TITLES.obligations).toBe('Insurance & Taxes');
    expect(TITLES['command-brain']).toBe('Brain');
  });
});

describe('Property Financials destination (plan 2026-10-05 T5)', () => {
  it('is registered in Assets as "Property Financials", routable, on the rail, with no registry tabs', () => {
    const m = byId('property-financials');
    expect(m).toBeDefined();
    expect(m!.label).toBe('Property Financials');
    expect(m!.group).toBe('Assets');
    expect(m!.rail).not.toBe(false);
    expect(m!.tabs).toBeUndefined();
    expect(parseRoute('/property-financials', IDS)).toMatchObject({ moduleId: 'property-financials', known: true });
    expect(resolveLegacyRoute('/property-financials', '?view=scorecard')).toBeNull();
  });

  it('sits right after Portfolio in both profiles and carries its page title', () => {
    for (const profile of ['acquisitions', 'principal'] as const) {
      const order = MODULE_ORDER[profile];
      expect(order.indexOf('property-financials'), profile).toBe(order.indexOf('portfolio') + 1);
      const rail = railModules(profile).map((m) => m.id);
      expect(rail.indexOf('property-financials'), profile).toBe(rail.indexOf('portfolio') + 1);
    }
    expect(TITLES['property-financials']).toBe('Property Financials');
  });
});
