import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rosterUnavailable } from '../../server/sources/deal-declassification';
import { confidentialRosterFlag, hasConfidentialRosterFailure } from '../../server/sources/notion-deals';
import { evaluateReconciliationGate } from '../../scripts/lease-snapshot-drift-check';

// PR #457 refute: mergeDeals force-confidentials every seed deal when the roster is unreadable or the
// placeholder, but only logged -- no DataQualityFlag, so CLI writers and Brain.persist wrote anyway.
// Synthetic roster only.
let dir: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-roster-flag-'));
  const p = join(dir, 'terms.json');
  writeFileSync(p, JSON.stringify({ d: { label: 'D', active: true, always: ['zephyr'] } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
});
afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  if (originalPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = originalPlaceholder;
  rmSync(dir, { recursive: true, force: true });
});

describe('rosterUnavailable', () => {
  it('is false for a readable real roster', () => expect(rosterUnavailable()).toBe(false));
  it('is true when the roster file is absent (scan throws)', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'absent.json');
    expect(rosterUnavailable()).toBe(true);
  });
  it('is true for the placeholder stand-in', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'absent.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    expect(rosterUnavailable()).toBe(true);
  });
});

describe('confidentialRosterFlag', () => {
  it('is null when the roster is available', () => expect(confidentialRosterFlag(false)).toBeNull());
  it('is an aggregate error flag on entity deals / field confidential-roster, with no rawValue', () => {
    const f = confidentialRosterFlag(true)!;
    expect(f.severity).toBe('error');
    expect(f.entity).toBe('deals');
    expect(f.field).toBe('confidential-roster');
    expect(f.rawValue ?? null).toBeNull();
    expect(hasConfidentialRosterFailure([f])).toBe(true);
  });
  it('is not matched by hasConfidentialRosterFailure when severity is not error or field differs', () => {
    expect(hasConfidentialRosterFailure([])).toBe(false);
    expect(hasConfidentialRosterFailure([{ entity: 'deals', field: 'pipeline', issue: 'x', severity: 'error' }])).toBe(false);
  });
  it('is NOT overridable by --force, even alongside an unrelated forceable error', () => {
    const f = confidentialRosterFlag(true)!;
    const other = { entity: 'reconciliation', field: 'x', issue: 'known gap', severity: 'error' as const };
    const base = { leases: [], properties: [], loans: [], deals: [], cash: { totalCash: 0, entities: [] }, insurance: [], counterparties: [] };
    expect(evaluateReconciliationGate({ ...base, dataQuality: [f, other] } as never, 'x.json', true).refuse).toBe(true);
    expect(evaluateReconciliationGate({ ...base, dataQuality: [f] } as never, 'x.json', true).refuse).toBe(true);
    // control: the unrelated error alone IS forceable
    expect(evaluateReconciliationGate({ ...base, dataQuality: [other] } as never, 'x.json', true).refuse).toBe(false);
  });
  it('makes the CLI writers\' reconciliation gate refuse', () => {
    const f = confidentialRosterFlag(true)!;
    const snap = { dataQuality: [f], leases: [], properties: [], loans: [], deals: [], cash: { totalCash: 0, entities: [] }, insurance: [], counterparties: [] };
    const out = evaluateReconciliationGate(snap as never, 'x.json', false);
    expect(out.refuse).toBe(true);
  });
});
