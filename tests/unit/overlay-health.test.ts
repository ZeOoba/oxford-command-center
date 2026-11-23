// @vitest-environment node
// Tier 1 data honesty (2026-11-23 review): loadOverlay() fails open to an empty overlay by design,
// so System Health must be able to see a corrupt or loader-dropped overlay on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOverlay, overlayHealthAt } from '../../server/overlay';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'overlay-health-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('overlayHealthAt', () => {
  it('absent file is null (graded missing)', () => {
    expect(overlayHealthAt(join(dir, 'overlay.json'))).toBeNull();
  });

  it('a well-formed overlay returns its modified time', () => {
    const p = join(dir, 'overlay.json');
    writeFileSync(p, JSON.stringify({ tenantNotes: { t1: 'note' } }));
    expect(Number.isFinite(Date.parse(overlayHealthAt(p)!))).toBe(true);
  });

  it('a well-formed overlay with no enrichment at all throws (it merges like a missing one)', () => {
    const p = join(dir, 'overlay.json');
    writeFileSync(p, '{}');
    expect(() => overlayHealthAt(p)).toThrow(/no enrichment/);
  });

  it('unparseable JSON throws', () => {
    const p = join(dir, 'overlay.json');
    writeFileSync(p, '{"dealStages":');
    expect(() => overlayHealthAt(p)).toThrow(/corrupt\/unparseable/);
  });

  it('a domain the loader drops throws, though the JSON parses', () => {
    const p = join(dir, 'overlay.json');
    writeFileSync(p, JSON.stringify({ tenantArrears: { x: 'oops' } }));
    expect(() => overlayHealthAt(p)).toThrow(/tenantArrears/);
  });
});

describe('loadOverlay on a corrupt file', () => {
  it('still fails open to empty, but warns instead of staying silent', () => {
    const p = join(dir, 'overlay.json');
    writeFileSync(p, '{broken');
    vi.stubEnv('OVERLAY_PATH', p);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o = loadOverlay();
    expect(o.tasks).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlay'));
  });
});
