// tests/unit/lease-market-config.test.ts
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome, loadCostarHeaderMap, loadLeaseMarketConfig } from '../../server/warehouse/lease-market/config';

describe('expandHome', () => {
  it('expands a leading ~ to the home directory', () => {
    expect(expandHome('~/x')).toBe(join(homedir(), 'x'));
  });

  it('leaves a path with no leading ~ untouched', () => {
    expect(expandHome('/already/absolute')).toBe('/already/absolute');
    expect(expandHome('relative/path')).toBe('relative/path');
  });
});

describe('loadLeaseMarketConfig', () => {
  it('parses the shipped config and expands ~ in ownerScreenModulePath', () => {
    const config = loadLeaseMarketConfig();
    expect(config.version).toBe(1);
    expect(config.ownerScreenModulePath.startsWith('~')).toBe(false);
    expect(config.ownerScreenModulePath).toBe(expandHome('~/.claude/skills/county-parcel-screen/scripts/institutional_owners.py'));
    expect(config.markets.length).toBeGreaterThan(0);
  });
});

describe('loadCostarHeaderMap', () => {
  it('parses the shipped (pending-sample) header map', () => {
    const map = loadCostarHeaderMap();
    expect(map.status).toBe('pending-sample');
    expect(map.headerRow).toBe(1);
    expect(Object.keys(map.fields).length).toBeGreaterThan(0);
  });
});
