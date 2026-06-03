import { describe, it, expect } from 'vitest';
import { parseRoute, entityPath, HOME_MODULE, MODULE_PRIMARY_TYPE } from '../../src/brain/routing';
import type { EntityType } from '../../src/brain/ui-context';

const MODS = ['overview', 'pipeline', 'tasks', 'portfolio', 'leases', 'debt', 'cash', 'insurance', 'market', 'relationships'];

describe('parseRoute', () => {
  it('resolves a bare/unknown path to overview (known=false)', () => {
    expect(parseRoute('/', MODS)).toEqual({ moduleId: 'overview', known: false, selected: null });
    expect(parseRoute('/nope', MODS).known).toBe(false);
    expect(parseRoute('/nope', MODS).moduleId).toBe('overview');
  });

  it('resolves a module path with no entity', () => {
    expect(parseRoute('/debt', MODS)).toEqual({ moduleId: 'debt', known: true, selected: null });
  });

  it('resolves a deep-linked entity to a typed selection (drawer)', () => {
    expect(parseRoute('/portfolio/9050-red-branch', MODS)).toEqual({
      moduleId: 'portfolio',
      known: true,
      selected: { type: 'property', id: '9050-red-branch' },
    });
    expect(parseRoute('/debt/REDACTED-702', MODS).selected).toEqual({ type: 'loan', id: 'REDACTED-702' });
    expect(parseRoute('/relationships/REDACTED-466', MODS).selected).toEqual({ type: 'counterparty', id: 'REDACTED-466' });
  });

  it('ignores an entity segment for modules without a primary entity', () => {
    expect(parseRoute('/overview/whatever', MODS).selected).toBeNull();
    expect(parseRoute('/tasks/x', MODS).selected).toBeNull();
  });

  it('round-trips id encoding', () => {
    const r = parseRoute('/leases/3540%20e%205th', MODS);
    expect(r.selected).toEqual({ type: 'lease', id: '3540 e 5th' });
  });
});

describe('entityPath / HOME_MODULE', () => {
  it('builds the shareable path for each entity type', () => {
    expect(entityPath({ type: 'property', id: 'p1' })).toBe('/portfolio/p1');
    expect(entityPath({ type: 'loan', id: 'l1' })).toBe('/debt/l1');
    expect(entityPath({ type: 'counterparty', id: 'cp-1' })).toBe('/relationships/cp-1');
  });

  it('HOME_MODULE and MODULE_PRIMARY_TYPE are consistent inverses', () => {
    for (const [type, mod] of Object.entries(HOME_MODULE)) {
      expect(MODULE_PRIMARY_TYPE[mod]).toBe(type as EntityType);
    }
  });
});
