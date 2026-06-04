import { describe, it, expect } from 'vitest';
import type { ModuleDef } from '../../src/shell/modules';
import { MODULE_ORDER, PROFILE_HOME, orderedModules } from '../../src/shell/module-order';

const mod = (id: string, group: ModuleDef['group'] = 'Command'): ModuleDef =>
  ({ id, label: id, icon: (() => null) as unknown as ModuleDef['icon'], group, Component: () => null });

describe('module-order', () => {
  it('home is pipeline for acquisitions, principal for principal', () => {
    expect(PROFILE_HOME.acquisitions).toBe('pipeline');
    expect(PROFILE_HOME.principal).toBe('principal');
    // MODULE_ORDER must define both profiles
    expect(Object.keys(MODULE_ORDER)).toEqual(expect.arrayContaining(['acquisitions', 'principal']));
  });

  it('orders modules by the profile list and appends unlisted ids at the end', () => {
    const registry = [mod('overview'), mod('pipeline'), mod('principal'), mod('extra')];
    const ids = orderedModules('acquisitions', registry).map((m) => m.id);
    expect(ids[0]).toBe('overview');
    expect(ids.indexOf('pipeline')).toBeLessThan(ids.indexOf('principal'));
    expect(ids.at(-1)).toBe('extra');
  });

  it('principal profile ranks the principal home first and capital ahead of assets', () => {
    const registry = [mod('portfolio', 'Assets'), mod('cash', 'Capital'), mod('principal', 'Command'), mod('overview', 'Command')];
    const ids = orderedModules('principal', registry).map((m) => m.id);
    expect(ids[0]).toBe('principal');
    expect(ids.indexOf('cash')).toBeLessThan(ids.indexOf('portfolio'));
  });
});
