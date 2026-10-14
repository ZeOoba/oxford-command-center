import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWarehouseEnvelope } from '../../scripts/bake-warehouse';

// Review round 2 (PR #457): public/warehouse.json is written after snapshot.json and was never
// roster-scanned; /brain/report titles carry acquisition addresses. Synthetic roster only.
let dir: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-bake-wh-'));
  const roster = join(dir, 'terms.json');
  writeFileSync(roster, JSON.stringify({ d: { label: 'D', active: true, always: ['9900 quarry'] } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = roster;
});
afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  if (originalPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = originalPlaceholder;
  rmSync(dir, { recursive: true, force: true });
});

const leaky = { endpoints: { '/brain/report': { questions: [{ title: 'Floor indeterminate — 9900 Quarry Rd' }] } } };
const clean = { endpoints: { '/brain/report': { questions: [{ title: 'Floor indeterminate — 1 Elm St' }] } } };
const pubDir = () => join(dir, 'public');
const out = () => join(pubDir(), 'warehouse.json');

describe('writeWarehouseEnvelope — roster boundary on public/warehouse.json', () => {
  it('writes a clean envelope', () => {
    writeWarehouseEnvelope(clean, false, pubDir());
    expect(JSON.parse(readFileSync(out(), 'utf8'))).toEqual(clean);
  });

  it('refuses a redacted envelope carrying a roster term and writes nothing', () => {
    expect(() => writeWarehouseEnvelope(leaky, false, pubDir())).toThrow(/roster/i);
    expect(existsSync(out())).toBe(false);
  });

  it('removes a STALE warehouse.json on refusal so it cannot ship next to the fresh snapshot', () => {
    writeWarehouseEnvelope(clean, true, pubDir());
    expect(existsSync(out())).toBe(true);
    expect(() => writeWarehouseEnvelope(leaky, false, pubDir())).toThrow();
    expect(existsSync(out())).toBe(false);
  });

  it('fails closed on the placeholder roster even for a clean envelope', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'absent.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    expect(() => writeWarehouseEnvelope(clean, false, pubDir())).toThrow(/placeholder/i);
    expect(existsSync(out())).toBe(false);
  });

  it('FULL (Access-gated) mode is unchanged: roster terms are written', () => {
    writeWarehouseEnvelope(leaky, true, pubDir());
    expect(existsSync(out())).toBe(true);
  });
});
