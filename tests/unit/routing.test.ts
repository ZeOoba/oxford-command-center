import { describe, it, expect } from 'vitest';
import { parseRoute, entityPath, intelPropertyPath, HOME_MODULE, MODULE_PRIMARY_TYPE } from '../../src/brain/routing';
import type { EntityType } from '../../src/brain/ui-context';

const MODS = ['overview', 'pipeline', 'tasks', 'portfolio', 'leases', 'debt', 'cash', 'insurance', 'market'];
const MODS_INTEL = [...MODS, 'intel'];

describe('parseRoute', () => {
  it('resolves a bare/unknown path to overview (known=false)', () => {
    expect(parseRoute('/', MODS)).toEqual({ moduleId: 'overview', known: false, selected: null, intelPropertyId: null });
    expect(parseRoute('/nope', MODS).known).toBe(false);
    expect(parseRoute('/nope', MODS).moduleId).toBe('overview');
  });

  it('resolves a module path with no entity', () => {
    expect(parseRoute('/debt', MODS)).toEqual({ moduleId: 'debt', known: true, selected: null, intelPropertyId: null });
  });

  it('resolves a deep-linked entity to a typed selection (drawer)', () => {
    expect(parseRoute('/portfolio/9050-red-branch', MODS)).toEqual({
      moduleId: 'portfolio',
      known: true,
      selected: { type: 'property', id: '9050-red-branch' },
      intelPropertyId: null,
    });
    expect(parseRoute('/debt/REDACTED-702', MODS).selected).toEqual({ type: 'loan', id: 'REDACTED-702' });
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

describe('parseRoute — intel deep-linking (additive, distinct from the global drawer)', () => {
  it('reads /intel/:propertyId into intelPropertyId WITHOUT opening the drawer', () => {
    const r = parseRoute('/intel/9050-red-branch', MODS_INTEL);
    expect(r.moduleId).toBe('intel');
    expect(r.known).toBe(true);
    expect(r.selected).toBeNull(); // intel has no MODULE_PRIMARY_TYPE → the global EntityDrawer stays closed
    expect(r.intelPropertyId).toBe('9050-red-branch');
  });

  it('has a null intelPropertyId for bare /intel and for non-intel modules', () => {
    expect(parseRoute('/intel', MODS_INTEL).intelPropertyId).toBeNull();
    // /portfolio/:id still opens the drawer and never sets intelPropertyId
    const p = parseRoute('/portfolio/9050-red-branch', MODS_INTEL);
    expect(p.intelPropertyId).toBeNull();
    expect(p.selected).toEqual({ type: 'property', id: '9050-red-branch' });
  });

  it('round-trips id encoding for the intel deep link', () => {
    expect(parseRoute('/intel/3540%20e%205th', MODS_INTEL).intelPropertyId).toBe('3540 e 5th');
  });
});

describe('intelPropertyPath', () => {
  it('builds an encoded, shareable intel path (distinct from entityPath/portfolio)', () => {
    expect(intelPropertyPath('9050-red-branch')).toBe('/intel/9050-red-branch');
    expect(intelPropertyPath('3540 e 5th')).toBe('/intel/3540%20e%205th');
  });
});

describe('entityPath / HOME_MODULE', () => {
  it('builds the shareable path for each entity type', () => {
    expect(entityPath({ type: 'property', id: 'p1' })).toBe('/portfolio/p1');
    expect(entityPath({ type: 'loan', id: 'l1' })).toBe('/debt/l1');
    expect(entityPath({ type: 'counterparty', id: 'cp-1' })).toBe('/overview/cp-1');
  });

  it('HOME_MODULE and MODULE_PRIMARY_TYPE are consistent inverses for routable entity types', () => {
    // counterparty is excluded: its home module ('overview') has no primary entity type by design
    // (RelationshipsModule was retired; counterparty keeps a fallback home so entityPath never throws)
    const skip = new Set<EntityType>(['counterparty']);
    for (const [type, mod] of Object.entries(HOME_MODULE)) {
      if (skip.has(type as EntityType)) continue;
      expect(MODULE_PRIMARY_TYPE[mod]).toBe(type as EntityType);
    }
  });
});
