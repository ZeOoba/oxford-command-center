import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RCT_V03 } from '../../src/brain/replacement-cost';

/**
 * Pins the client-side deal-drawer table (src/brain/replacement-cost.ts) to the server
 * engine's ratified config (config/replacement-cost.v3.json). Both cite the
 * acquisition-underwriting skill's RCT v03 table as the true source of record — this test
 * only proves the two CODE copies agree with each other, not that either is correct against
 * the skill. Added 2026-09-28 (OI-354): the client previously covered only 4 of 9 markets,
 * silently showing "basis cannot be scored" for markets the server could already score.
 */
describe('RCT client/server parity (OI-354)', () => {
  const serverConfig = JSON.parse(
    readFileSync(resolve(process.cwd(), 'fixtures/synthetic/config/replacement-cost.v3.json'), 'utf8'),
  ) as { markets: Record<string, { low: number; point: number; high: number; cwHardPsf: number; proxy: boolean }> };

  it('client RCT_V03 has no market absent from the server config', () => {
    const clientKeys = Object.keys(RCT_V03);
    const serverKeys = Object.keys(serverConfig.markets);
    for (const k of clientKeys) {
      expect(serverKeys, `client has "${k}" which the server config does not`).toContain(k);
    }
  });

  it('client RCT_V03 carries every market the server config has', () => {
    const clientKeys = Object.keys(RCT_V03);
    const serverKeys = Object.keys(serverConfig.markets);
    for (const k of serverKeys) {
      expect(clientKeys, `server config has "${k}" which the client is missing`).toContain(k);
    }
  });

  it('every shared market has identical LOW/POINT/HIGH/cwHardPsf/proxy values', () => {
    for (const [market, serverEntry] of Object.entries(serverConfig.markets)) {
      const clientEntry = RCT_V03[market as keyof typeof RCT_V03];
      expect(clientEntry, `client is missing "${market}"`).toBeDefined();
      if (!clientEntry) continue;
      expect(clientEntry.low, `${market} LOW`).toBeCloseTo(serverEntry.low, 2);
      expect(clientEntry.point, `${market} POINT`).toBeCloseTo(serverEntry.point, 2);
      expect(clientEntry.high, `${market} HIGH`).toBeCloseTo(serverEntry.high, 2);
      expect(clientEntry.cwHardPsf, `${market} cwHardPsf`).toBeCloseTo(serverEntry.cwHardPsf, 2);
      expect(clientEntry.proxy, `${market} proxy flag`).toBe(serverEntry.proxy);
    }
  });
});
