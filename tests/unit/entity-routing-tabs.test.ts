import { describe, it, expect } from 'vitest';
import { parseRoute, entityHref } from '../../src/brain/routing';
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
