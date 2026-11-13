// @vitest-environment node
//
// tests/unit/pf-crosscheck-insights.test.ts — the brief-facing wrapper: loads PF, runs the tax-timing and
// insurance-ledger checks, and is FAIL-OPEN and FAIL-LOUD. A stale / unreadable / invalid dataset must
// never turn into confident findings, and must never vanish silently either.
// Runs over the committed synthetic snapshot + PF dataset (fixtures/synthetic); findings are forced by
// editing a cloned copy, so no assertion depends on the synthetic values themselves.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parsePropertyFinancialsDataset, type PfDataset } from '@contracts/property-financials';
import type { PfLoadResult } from '../../server/property-financials/loader';
import { pfCrosscheckInsights } from '../../server/property-financials/crosscheck-insights';
import { policyEntityResolver } from '../../server/property-financials/insurance-ledger';
import { ENTITY_TO_CANONICAL } from '../../server/property-financials/mapping';

const TAX = 'Real estate & property tax';
const baseDs = parsePropertyFinancialsDataset(JSON.parse(readFileSync('fixtures/synthetic/data/property-financials/dataset.json', 'utf8')));
const snapshot = JSON.parse(readFileSync('fixtures/synthetic/data/snapshots/portfolio.json', 'utf8'));
const NOW = new Date('2026-10-07T12:00:00Z');
const YEAR = baseDs.meta.as_of.slice(0, 4);
const PRIOR = String(Number(YEAR) - 1);
const FULL = Number(baseDs.meta.as_of.slice(5, 7));

type Own = { id: string; name: string; oxfordOwnPct?: number | null };
const props = snapshot.properties as Own[];
const ownOf = (id: string) => props.find((p) => p.id === id)?.oxfordOwnPct ?? 1;

/** Monthly entities with a full prior YTD and a tax base big enough to clear the dollar floor, mapped to a snapshot property. */
function taxCandidates(ds: PfDataset): { entity: string; id: string; own: number }[] {
  const out: { entity: string; id: string; own: number }[] = [];
  for (const [entity, h] of Object.entries(ds.history)) {
    const id = ENTITY_TO_CANONICAL[entity]?.id;
    if (!h?.monthly || !id || !props.some((p) => p.id === id)) continue;
    const cur = h.ytd[YEAR];
    const pri = h.ytd[PRIOR];
    if (!cur || !pri || cur.n !== FULL || pri.n !== FULL || !((pri.cats[TAX] ?? 0) > 20_000)) continue;
    out.push({ entity, id, own: ownOf(id) });
  }
  return out;
}

/** Clone the dataset and force a tax DROP on `entity` (current YTD = 30% of prior). */
function withTaxDrop(entity: string): PfDataset {
  const ds = structuredClone(baseDs);
  const h = ds.history[entity as keyof typeof ds.history]!;
  h.ytd[YEAR]!.cats[TAX] = (h.ytd[PRIOR]!.cats[TAX] ?? 0) * 0.3;
  return ds;
}

const meta = (staleness: 'fresh' | 'stale') => ({
  version: 'v03', generated: '2026-10-05', as_of: baseDs.meta.as_of, basis: 'cash', sha256: 'x', csvSha256: null, csvError: null,
  ageDays: staleness === 'fresh' ? 7 : 90, staleness, stalenessReason: staleness === 'fresh' ? null : 'as-of date is 90 days old (> 45)',
});
const loaded = (over: Partial<PfLoadResult>, ds: PfDataset = baseDs): PfLoadResult =>
  ({ availability: 'ok', readError: null, lastGoodLoadedAt: null, issues: [], dataset: ds, meta: meta('fresh'), ...over }) as PfLoadResult;
const run = (res: PfLoadResult | Error, snap = snapshot) =>
  pfCrosscheckInsights(snap, NOW, '/pf', () => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));

const full = taxCandidates(baseDs).find((c) => c.own === 1);
const half = taxCandidates(baseDs).find((c) => c.own !== 1);

describe('pfCrosscheckInsights', () => {
  it('synthetic fixtures provide the candidates these tests need', () => {
    expect(full).toBeDefined();
    expect(half).toBeDefined();
  });

  it('fresh dataset: emits a forced tax drop with a stable id, none critical, sorted', async () => {
    const out = await run(loaded({}, withTaxDrop(full!.entity)));
    const ids = out.map((i) => i.id);
    expect(ids).toContain(`pf-tax-drop-${full!.id}-ytd${YEAR}`);
    expect(out.every((i) => i.severity !== 'critical')).toBe(true);
    expect(ids).toEqual([...ids].sort());
  });

  it('titles use the snapshot property name, not the PF label', async () => {
    const out = await run(loaded({}, withTaxDrop(full!.entity)));
    const t = out.find((i) => i.id === `pf-tax-drop-${full!.id}-ytd${YEAR}`)!;
    const name = props.find((p) => p.id === full!.id)!.name;
    expect(t.title).toContain(name);
  });

  it('uses the dataset as-of year for the YTD comparison (not a hard-coded year)', async () => {
    const out = await run(loaded({}, withTaxDrop(full!.entity)));
    expect(out.some((i) => i.id.endsWith(`-ytd${YEAR}`))).toBe(true);
  });

  it('stale dataset: one warning, no findings from old data', async () => {
    const out = await run(loaded({ meta: meta('stale') as PfLoadResult['meta'] }, withTaxDrop(full!.entity)));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('brief-pf-crosschecks-unavailable');
    expect(out[0]!.severity).toBe('warning');
    expect(out[0]!.detail).toMatch(/90 days/);
  });

  it.each(['unreadable', 'invalid'] as const)('%s dataset: one warning with the reason', async (availability) => {
    const out = await run(loaded({ availability, dataset: null, meta: null, readError: 'boom' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('brief-pf-crosschecks-unavailable');
    expect(out[0]!.detail).toMatch(/boom|unreadable|invalid/i);
  });

  it('missing dataset (mirror / fresh worktree): skipped quietly, like the missing-warehouse path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await run(loaded({ availability: 'missing', dataset: null, meta: null }));
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failure in the insurance check does not take the tax findings down with it', async () => {
    const broken = { ...snapshot, insurance: null };
    const out = await run(loaded({}, withTaxDrop(full!.entity)), broken);
    expect(out.some((i) => i.id.startsWith('pf-tax-drop-'))).toBe(true);
    const warn = out.find((i) => i.id === 'brief-pf-insurance-ledger-unavailable')!;
    expect(warn.severity).toBe('warning');
    expect(out.some((i) => i.id.startsWith('pf-ins-'))).toBe(false);
  });

  it('a blank Expires cell on a lapsed policy does not disable the cross-checks', async () => {
    const blank = {
      ...snapshot,
      insurance: snapshot.insurance.map((p: { status: string }, i: number) => (i === 0 ? { ...p, status: 'Expired', expires: null } : p)),
    };
    const out = await run(loaded({}), blank);
    expect(out.some((i) => i.id === 'brief-pf-crosschecks-unavailable')).toBe(false);
    expect(out.some((i) => i.id === 'brief-pf-insurance-ledger-unavailable')).toBe(false);
  });

  it('a dataset that loaded WITH a read error (last-good served after a failed refresh) is not trusted', async () => {
    const out = await run(loaded({ readError: 'EBUSY on refresh' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('brief-pf-crosschecks-unavailable');
    expect(out[0]!.detail).toMatch(/EBUSY/);
  });

  it('amounts are the ORA share: a partly owned asset says so', async () => {
    const out = await run(loaded({}, withTaxDrop(half!.entity)));
    const t = out.find((i) => i.id === `pf-tax-drop-${half!.id}-ytd${YEAR}`)!;
    expect(t.detail).toMatch(/ORA share/);
  });

  it('a forced double premium posting surfaces as a ledger-excess warning for that property', async () => {
    const resolve = policyEntityResolver();
    const ds = structuredClone(baseDs);
    const cube = ds.monthly as unknown as Record<string, Record<string, { opex_by: { Insurance: number } }>>;
    const policies = snapshot.insurance as { id: string; premium: number | null }[];
    const target = policies.map((p) => resolve(p.id)).find((e): e is string => !!e && !!cube[e] && Object.keys(cube[e]!).length >= 12);
    expect(target).toBeDefined();
    const id = ENTITY_TO_CANONICAL[target!]!.id;
    const premium = policies.filter((p) => resolve(p.id) === target).reduce((s, p) => s + (p.premium ?? 0), 0);
    const ms = Object.keys(cube[target!]!).sort();
    for (const m of ms) cube[target!]![m]!.opex_by.Insurance = 0;
    // two full-premium postings early in the trailing 12 (outside any advance-renewal window) plus a third
    cube[target!]![ms[ms.length - 10]!]!.opex_by.Insurance = premium;
    cube[target!]![ms[ms.length - 9]!]!.opex_by.Insurance = premium;
    cube[target!]![ms[ms.length - 8]!]!.opex_by.Insurance = premium;
    const out = await run(loaded({}, ds));
    const hit = out.find((i) => i.id === `pf-ins-ledger-excess-${id}`);
    expect(hit?.severity).toBe('warning');
  });

  it('no emitted insight puts a YTD gap into impactAnnualUsd', async () => {
    const out = await run(loaded({}, withTaxDrop(full!.entity)));
    expect(out.filter((i) => i.id.startsWith('pf-tax-')).every((i) => i.impactAnnualUsd === null)).toBe(true);
  });

  it('loader throwing is contained: one warning, never an exception', async () => {
    const out = await run(new Error('disk gone'));
    expect(out).toHaveLength(1);
    expect(out[0]!.detail).toMatch(/disk gone/);
  });
});

describe('brief wiring', () => {
  it('server/brief/run.ts merges PF cross-check insights BEFORE the critical-alert filter', () => {
    const src = readFileSync('server/brief/run.ts', 'utf8');
    const call = src.indexOf('pfCrosscheckInsights(');
    const filter = src.indexOf("insights.filter((i) => i.severity === 'critical')");
    expect(call).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(call);
  });
});
