import { describe, it, expect } from 'vitest';
import { parseRoute, entityHref, entityPath, TAB_PRIMARY_TYPE, HOME_TAB, HOME_MODULE, MODULE_PRIMARY_TYPE } from '../../src/brain/routing';
import type { EntityType } from '../../src/brain/ui-context';

const IDS = ['capital', 'pipeline', 'portfolio', 'worklist', 'overview'];
const TAB_TYPES = { capital: { debt: 'loan', cash: 'cashEntity' } } as const;
const HOMES = {
  module: { property: 'portfolio', lease: 'leasing', loan: 'capital', cashEntity: 'capital', insurance: 'obligations', counterparty: 'overview', deal: 'pipeline' } as Record<EntityType, string>,
  tab: { loan: 'debt', cashEntity: 'cash' } as Partial<Record<EntityType, string>>,
};

describe('parseRoute — tab-aware entity type', () => {
  it('a destination hosting two drawers picks the type from ?tab=', () => {
    expect(parseRoute('/capital/l1', IDS, 'debt', TAB_TYPES).selected).toEqual({ type: 'loan', id: 'l1' });
    expect(parseRoute('/capital/a1', IDS, 'cash', TAB_TYPES).selected).toEqual({ type: 'cashEntity', id: 'a1' });
  });
  it('no drawer on a tab that hosts none', () => {
    expect(parseRoute('/capital/x', IDS, 'allocation', TAB_TYPES).selected).toBeNull();
    expect(parseRoute('/capital/x', IDS, null, TAB_TYPES).selected).toBeNull();
  });
  it('single-type modules ignore ?tab= (Acquisitions keeps its deal drawer on every tab)', () => {
    expect(parseRoute('/pipeline/d1', IDS, 'grader', TAB_TYPES).selected).toEqual({ type: 'deal', id: 'd1' });
  });
  // The "alias supplies its own tab on first render" case needs the real `debt` alias row, which lands
  // in Task 3 — it is asserted there (`parseRoute('/debt/l1', IDS).selected`), not here.
});

describe('entityHref', () => {
  it('cross-module jump: clears stale tab/view, keeps other params, sets the home tab', () => {
    expect(entityHref({ type: 'loan', id: 'l1' }, '?scenario=Downside&tab=calendar&view=x', 'worklist', HOMES))
      .toBe('/capital/l1?scenario=Downside&tab=debt');
  });
  it('cross-module jump to a module with no home tab drops the stale tab', () => {
    expect(entityHref({ type: 'property', id: 'p1' }, '?tab=alerts', 'worklist', HOMES)).toBe('/portfolio/p1');
  });
  it('same-module jump never changes the tab (Tenants → lease drawer must not flip to Rent roll)', () => {
    expect(entityHref({ type: 'deal', id: 'd1' }, '?tab=grader', 'pipeline', HOMES)).toBe('/pipeline/d1?tab=grader');
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=debt&view=scorecard', 'capital', HOMES)).toBe('/capital/l1?tab=debt&view=scorecard');
  });
  it('ids are URL-encoded', () => {
    expect(entityHref({ type: 'property', id: 'a/b' }, '', 'overview', HOMES)).toBe('/portfolio/a%2Fb');
  });
});

describe('real routing constants (Capital PR-B)', () => {
  it('TAB_PRIMARY_TYPE / HOME_TAB / HOME_MODULE route loans and cash entities into Capital', () => {
    expect(TAB_PRIMARY_TYPE.capital).toEqual({ debt: 'loan', cash: 'cashEntity' });
    expect(HOME_TAB).toEqual({ loan: 'debt', cashEntity: 'cash', insurance: 'insurance' });
    expect(HOME_MODULE.loan).toBe('capital');
    expect(HOME_MODULE.cashEntity).toBe('capital');
    expect(entityPath({ type: 'loan', id: 'l1' })).toBe('/capital/l1');
  });
  it('entityHref with the real constants lands cross-module jumps on the right Capital tab', () => {
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=alerts&view=x&scenario=Downside', 'worklist')).toBe('/capital/l1?scenario=Downside&tab=debt');
    expect(entityHref({ type: 'cashEntity', id: 'a1' }, '', 'overview')).toBe('/capital/a1?tab=cash');
  });
});

describe('real routing constants (Obligations PR-C)', () => {
  it('the insurance drawer lives in Obligations (single type => resolves on every Obligations tab)', () => {
    expect(MODULE_PRIMARY_TYPE.obligations).toBe('insurance');
    expect(MODULE_PRIMARY_TYPE.insurance).toBeUndefined();
    expect(HOME_MODULE.insurance).toBe('obligations');
    expect(HOME_TAB.insurance).toBe('insurance');
    expect(entityPath({ type: 'insurance', id: 'pol-1' })).toBe('/obligations/pol-1');
  });
  it('cross-module jump lands on the Insurance tab (Calendar -> policy drawer)', () => {
    expect(entityHref({ type: 'insurance', id: 'pol-1' }, '?tab=calendar', 'worklist')).toBe('/obligations/pol-1?tab=insurance');
  });
  it('same-module jump keeps the Taxes tab: Obligations hosts the insurance drawer on every tab', () => {
    expect(entityHref({ type: 'insurance', id: 'pol-1' }, '?tab=taxes', 'obligations')).toBe('/obligations/pol-1?tab=taxes');
    expect(entityHref({ type: 'insurance', id: 'pol-1' }, '?tab=insurance&view=register', 'obligations')).toBe('/obligations/pol-1?tab=insurance&view=register');
  });
  it('the drawer resolves on a Taxes-tab URL with the real constants', () => {
    expect(parseRoute('/obligations/pol-1', ['obligations'], 'taxes').selected).toEqual({ type: 'insurance', id: 'pol-1' });
  });
});

describe('entityHref — same-module jump onto a tab that does not host the entity type', () => {
  it('a loan opened from a Capital tab that hosts no loan drawer lands on Debt', () => {
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=allocation', 'capital')).toBe('/capital/l1?tab=debt');
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=pipeline', 'capital')).toBe('/capital/l1?tab=debt');
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=close', 'capital')).toBe('/capital/l1?tab=debt');
  });
  it('a loan opened from Cash flips to Debt and drops the stale view', () => {
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=cash&view=x', 'capital')).toBe('/capital/l1?tab=debt');
  });
  it('a cash entity opened from Debt flips to Cash and drops the stale view', () => {
    expect(entityHref({ type: 'cashEntity', id: 'a1' }, '?tab=debt&view=scorecard', 'capital')).toBe('/capital/a1?tab=cash');
  });
  it('a loan opened from Debt keeps tab and view', () => {
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=debt&view=scorecard', 'capital')).toBe('/capital/l1?tab=debt&view=scorecard');
  });
  it('other params (scenario) survive the flip', () => {
    expect(entityHref({ type: 'loan', id: 'l1' }, '?scenario=Downside&tab=cash&view=x', 'capital')).toBe('/capital/l1?scenario=Downside&tab=debt');
  });
  it('a single-type module hosts its entity on every tab, so it never flips (injected fixtures)', () => {
    const homes = {
      module: { ...HOMES.module, lease: 'leasing' } as Record<EntityType, string>,
      tab: { lease: 'rent-roll' } as Partial<Record<EntityType, string>>,
      moduleTypes: { leasing: 'lease' } as Partial<Record<string, EntityType>>,
      tabTypes: {} as Record<string, Record<string, EntityType>>,
    };
    expect(entityHref({ type: 'lease', id: 'x1' }, '?tab=tenants&view=v', 'leasing', homes)).toBe('/leasing/x1?tab=tenants&view=v');
  });
  it('a tab-typed fixture flips when the current tab hosts a different type', () => {
    const homes = {
      module: HOMES.module,
      tab: HOMES.tab,
      moduleTypes: {} as Partial<Record<string, EntityType>>,
      tabTypes: { capital: { debt: 'loan', cash: 'cashEntity' } } as Record<string, Record<string, EntityType>>,
    };
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=cash', 'capital', homes)).toBe('/capital/l1?tab=debt');
  });
});

