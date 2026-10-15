import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { redactConfidential, refuseBakeOnRosterScan, writeSnapshotPayload } from '../../scripts/bake-mirror';
import { readFileSync } from 'node:fs';

// Refute wf_d42a89c6-fe5 on PR #457: redactConfidential is flag- and name-only, so text that names an
// ACTIVE roster deal by an `always` term (an address, say) while the Notion deal NAME differs
// survives the sweep into public/snapshot.json. The publication boundary needs its own roster scan.
// Synthetic roster only -- never real deal terms.
const ROSTER = {
  live_deal: { label: 'Live Deal', active: true, always: ['zephyr', '9900 quarry'] },
  anchored: { label: 'Anchored', active: true, context: ['harbor lane'], context_requires_any: ['closing'] },
  retired_deal: { label: 'Retired Deal', active: false, always: ['obsidian'] },
};

let dir: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
const useRoster = (body: string | null) => {
  const p = join(dir, 'terms.json');
  if (body !== null) writeFileSync(p, body, 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
};

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-bake-roster-'));
  useRoster(JSON.stringify(ROSTER));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  if (originalPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = originalPlaceholder;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('refuseBakeOnRosterScan', () => {
  it('permits a payload no active roster term appears in', () => {
    expect(refuseBakeOnRosterScan({ tasks: [{ label: 'Renew Acme lease' }], deals: [] })).toBeNull();
  });

  it('refuses when ANY field carries an active `always` term, without echoing the term or label', () => {
    const out = refuseBakeOnRosterScan({ deep: { nested: [{ notes: 'wire for 9900 Quarry Rd' }] } });
    expect(out).not.toBeNull();
    expect(out).toMatch(/roster/i);
    expect(out!.toLowerCase()).not.toContain('quarry');
    expect(out).not.toContain('Live Deal');
  });

  it('honours context terms only with their anchor, like the egress hook', () => {
    expect(refuseBakeOnRosterScan({ t: 'harbor lane' })).toBeNull();
    expect(refuseBakeOnRosterScan({ t: 'closing at harbor lane' })).not.toBeNull();
  });

  it('ignores retired (active:false) roster groups', () => {
    expect(refuseBakeOnRosterScan({ t: 'obsidian' })).toBeNull();
  });

  it('fails CLOSED when the roster is unreadable (scan throws)', () => {
    useRoster(null); // path points at a file that does not exist
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'absent.json');
    const out = refuseBakeOnRosterScan({ t: 'clean' });
    expect(out).not.toBeNull();
    expect(out).toMatch(/unreadable|unavailable/i);
  });

  it('fails CLOSED on the placeholder roster even for a clean payload', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'absent.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    const out = refuseBakeOnRosterScan({ t: 'clean' });
    expect(out).not.toBeNull();
    expect(out).toMatch(/placeholder/i);
  });
});

describe('object keys (collectText never walks keys, JSON.stringify writes them)', () => {
  it('refuses a roster term that appears only as an object key', () => {
    expect(refuseBakeOnRosterScan({ tenantNotes: { '9900 Quarry Rd': 'fine' } })).not.toBeNull();
    expect(refuseBakeOnRosterScan({ dealComps: { 'zephyr-flex': {} } })).not.toBeNull();
  });
});

describe('object keys containing JSON-escaped characters', () => {
  it('refuses a key whose term contains a quote or backslash (stringify would hide it)', () => {
    useRoster(JSON.stringify({ k: { label: 'K', active: true, always: ['a"b', 'c\\d'] } }));
    expect(refuseBakeOnRosterScan({ m: { 'xx a"b yy': 1 } })).not.toBeNull();
    expect(refuseBakeOnRosterScan({ m: { 'xx c\\d yy': 1 } })).not.toBeNull();
  });
});

describe('redaction + roster scan together (the PR #457 refute scenario)', () => {
  const snap = (): PortfolioSnapshot => ({
    properties: [], leases: [], loans: [], insurance: [], counterparties: [],
    // Notion deal NAME differs from the roster term, so the name sweep cannot catch the task.
    deals: [{ id: 'harbor', name: 'Harbor Flex', shortName: null, confidential: true }],
    tasks: [{ id: 't1', label: 'Send PSA redline for 9900 Quarry', notes: null }],
    dataQuality: [], dealComps: {}, acquisitionInputs: {}, tenantNotes: {},
  } as unknown as PortfolioSnapshot);

  it('name sweep alone lets the task through; the boundary scan refuses it', () => {
    const { snapshot } = redactConfidential(snap());
    expect(snapshot.tasks).toHaveLength(1); // documents the residual the scan closes
    expect(refuseBakeOnRosterScan(snapshot)).not.toBeNull();
  });
});

describe('context term split between a key and a value (review round 3, C1b)', () => {
  it('refuses when the anchor is a value and a quote-bearing context term is only a key', () => {
    useRoster(JSON.stringify({ k: { label: 'K', active: true, context: ['x"y'], context_requires_any: ['anchorq'] } }));
    expect(refuseBakeOnRosterScan({ v: 'anchorq', m: { 'x"y': 1 } })).not.toBeNull();
    expect(refuseBakeOnRosterScan({ anchorq: 'x"y' })).not.toBeNull();
    expect(refuseBakeOnRosterScan({ v: 'unrelated', m: { 'x"y': 1 } })).toBeNull(); // no anchor, no hit
  });
});

describe('writeSnapshotPayload — the snapshot.json publication boundary (round 3, C4)', () => {
  const leaky = { tasks: [{ label: 'Send PSA redline for 9900 Quarry' }] };
  const out = () => join(dir, 'snapshot.json');

  it('writes a clean payload', () => {
    writeSnapshotPayload({ tasks: [] }, false, dir);
    expect(existsSync(out())).toBe(true);
  });
  it('throws and writes NOTHING for a redacted payload carrying a roster term', () => {
    expect(() => writeSnapshotPayload(leaky, false, dir)).toThrow(/roster/i);
    expect(existsSync(out())).toBe(false);
  });
  it('leaves the previous snapshot.json in place on refusal', () => {
    writeSnapshotPayload({ tasks: [] }, false, dir);
    expect(() => writeSnapshotPayload(leaky, false, dir)).toThrow();
    expect(existsSync(out())).toBe(true);
  });
  it('FULL (Access-gated) mode is unchanged', () => {
    writeSnapshotPayload(leaky, true, dir);
    expect(existsSync(out())).toBe(true);
  });
});

describe('what is scanned is what is written (review round 4, C1b/C1c)', () => {
  it('a getter that changes between reads cannot smuggle a term into the written file', () => {
    let reads = 0;
    const payload = { get sneaky() { reads += 1; return reads <= 3 ? 'clean' : '9900 quarry'; } };
    let threw = false;
    try { writeSnapshotPayload(payload, false, dir); } catch { threw = true; }
    const written = existsSync(join(dir, 'snapshot.json')) ? readFileSync(join(dir, 'snapshot.json'), 'utf8') : '';
    // Either refused, or what was written is exactly what was scanned -- never a term on disk.
    expect(threw || !written.toLowerCase().includes('quarry')).toBe(true);
    expect(written.toLowerCase()).not.toContain('quarry');
  });

  it('a toJSON that hides a quote-bearing term from the raw object is still caught', () => {
    useRoster(JSON.stringify({ k: { label: 'K', active: true, always: ['a"b'] } }));
    expect(refuseBakeOnRosterScan({ x: { toJSON: () => 'xx a"b yy' } })).not.toBeNull();
  });

  it('bake-mirror main() publishes snapshot.json only through writeSnapshotPayload (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'bake-mirror.ts'), 'utf8');
    expect(src).toContain('writeSnapshotPayload({ ...snapshot, governors }, includeConfidential, pub)');
    expect(src.match(/'snapshot\.json'/g)).toHaveLength(2); // both inside writeSnapshotPayload
  });
});
