// server/warehouse/lease-market/config.ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LeaseMarketConfig } from '../../../src/contracts/lease-market';
import { CostarHeaderMap } from './costar-parse';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p;
}

export function defaultConfigPath(): string {
  return join(process.cwd(), 'config', 'lease-market.json');
}

export function defaultHeaderMapPath(): string {
  return join(process.cwd(), 'config', 'lease-market.costar-headers.json');
}

export function loadLeaseMarketConfig(path = defaultConfigPath()): LeaseMarketConfig {
  const parsed = LeaseMarketConfig.parse(JSON.parse(readFileSync(path, 'utf8')));
  return { ...parsed, ownerScreenModulePath: expandHome(parsed.ownerScreenModulePath) };
}

export function loadCostarHeaderMap(path = defaultHeaderMapPath()): CostarHeaderMap {
  return CostarHeaderMap.parse(JSON.parse(readFileSync(path, 'utf8')));
}
