import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, precheckRedactedOnly, scanDistForRoster } from '../../scripts/scan-mirror-dist';

// Audit wf_9bf74429-aaf finding 30: bundled data (data/building-specs, data/calibration JSON compiled
// into /assets, seed modules, anything vite copies out of public/) reached the REDACTED artifact
// without a roster check. scan-mirror-dist.ts scans every text file of the BUILT dist/. Synthetic
// roster and names only.
let dir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['CONFIDENTIAL_TERMS_PATH', 'CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER', 'MIRROR_INCLUDE_CONFIDENTIAL', 'MIRROR_ACCESS_PREPROBE'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'scan-dist-'));
  const roster = join(dir, 'terms.json');
  writeFileSync(roster, JSON.stringify({ syn: { label: 'Synthetic', active: true, always: ['Kestrel Ridge'] } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = roster;
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<html><body>Public Flex Center</body></html>');
  writeFileSync(join(dir, 'dist', 'assets', 'index-abc.js'), 'const specs={"name":"Public Flex Center"};');
  writeFileSync(join(dir, 'dist', 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const dist = () => join(dir, 'dist');

describe('scanDistForRoster', () => {
  it('a clean artifact passes', () => {
    expect(scanDistForRoster(dist())).toEqual([]);
  });

  it('a roster term in a bundled asset chunk (the data/*.json path) is caught, by file', () => {
    writeFileSync(join(dist(), 'assets', 'specs-def.js'), 'export default [{"site":"kestrel-ridge business park"}];');
    expect(scanDistForRoster(dist())).toEqual(['assets/specs-def.js']);
  });

  it('a stale warehouse.json copied out of public/ is caught', () => {
    writeFileSync(join(dist(), 'warehouse.json'), JSON.stringify({ deals: [{ name: 'Kestrel Ridge Flex' }] }));
    expect(scanDistForRoster(dist())).toEqual(['warehouse.json']);
  });

  it('an unreadable roster throws (the caller refuses)', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(() => scanDistForRoster(dist())).toThrow();
  });
});

describe('scan-mirror-dist main()', () => {
  it('REDACTED: exit 0 when clean, exit 1 on a hit, and the term never reaches the log', () => {
    expect(main([`--dist=${dist()}`], process.env)).toBe(0);
    writeFileSync(join(dist(), 'assets', 'x.js'), '"Kestrel Ridge"');
    expect(main([`--dist=${dist()}`], process.env)).toBe(1);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(' ');
    expect(logged).toContain('assets/x.js');
    expect(logged.toLowerCase()).not.toContain('kestrel');
    expect(logged).not.toContain('Synthetic');
  });

  it('REDACTED: an unreadable roster refuses (exit 1)', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(main([`--dist=${dist()}`], process.env)).toBe(1);
  });

  it('FULL (attested): the scan is skipped; FULL without attestation is refused', () => {
    writeFileSync(join(dist(), 'assets', 'x.js'), '"Kestrel Ridge"');
    expect(main([`--dist=${dist()}`], { ...process.env, MIRROR_INCLUDE_CONFIDENTIAL: '1', MIRROR_ACCESS_PREPROBE: 'passed' })).toBe(0);
    expect(main([`--dist=${dist()}`], { ...process.env, MIRROR_INCLUDE_CONFIDENTIAL: '1' })).toBe(1);
  });
});

describe('--precheck-redacted-only (npm run deploy:mirror)', () => {
  it('refuses when either FULL-mode variable is set, passes otherwise', () => {
    expect(precheckRedactedOnly({})).toBeNull();
    expect(precheckRedactedOnly({ MIRROR_INCLUDE_CONFIDENTIAL: '' })).toBeNull();
    expect(precheckRedactedOnly({ MIRROR_INCLUDE_CONFIDENTIAL: '0' })).toBeNull();
    expect(precheckRedactedOnly({ MIRROR_INCLUDE_CONFIDENTIAL: '1' })).toMatch(/REDACTED bake only/);
    expect(precheckRedactedOnly({ MIRROR_ACCESS_PREPROBE: 'passed' })).toMatch(/REDACTED bake only/);
    expect(main(['--precheck-redacted-only'], { MIRROR_INCLUDE_CONFIDENTIAL: '1', MIRROR_ACCESS_PREPROBE: 'passed' })).toBe(1);
    expect(main(['--precheck-redacted-only'], {})).toBe(0);
  });
});
