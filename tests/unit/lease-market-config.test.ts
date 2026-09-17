// tests/unit/lease-market-config.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, defaultHeaderMapPath, expandHome, loadCostarHeaderMap, loadLeaseMarketConfig } from '../../server/warehouse/lease-market/config';

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
    // Compare against the RAW shipped value (read independently), not a hardcoded literal — this stays
    // correct even if the shipped path is edited later, while still proving the expansion happened.
    const raw = JSON.parse(readFileSync(defaultConfigPath(), 'utf8')) as { ownerScreenModulePath: string };
    const config = loadLeaseMarketConfig();
    expect(config.version).toBe(1);
    expect(config.ownerScreenModulePath.startsWith('~')).toBe(false);
    expect(config.ownerScreenModulePath).toBe(expandHome(raw.ownerScreenModulePath));
    expect(config.markets.length).toBeGreaterThan(0);
  });
});

describe('loadCostarHeaderMap', () => {
  it('parses the shipped header map into a valid CostarHeaderMap shape', () => {
    const map = loadCostarHeaderMap();
    // Assert the TYPE (one of the two valid statuses), not the current literal value — the shipped map
    // moves from 'pending-sample' to 'verified' once Task 99 fills it from a real export, and this test
    // must not need editing when that happens.
    expect(['pending-sample', 'verified']).toContain(map.status);
    expect(map.headerRow).toBeGreaterThan(0);
    expect(Object.keys(map.fields).length).toBeGreaterThan(0);
  });

  it('reads from defaultHeaderMapPath() by default', () => {
    const raw = JSON.parse(readFileSync(defaultHeaderMapPath(), 'utf8')) as { status: string };
    expect(loadCostarHeaderMap().status).toBe(raw.status);
  });
});
