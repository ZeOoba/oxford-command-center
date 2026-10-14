import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { redactConfidential, refuseBakeOnRosterScan } from '../../scripts/bake-mirror';

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
