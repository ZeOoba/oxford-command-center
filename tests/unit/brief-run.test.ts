import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { runBrief } from '../../server/brief/run';

const dir = () => mkdtempSync(join(tmpdir(), 'run-'));

// runBrief writes brief-health.json; without this every run of the suite overwrites the real
// data/brief-health.json with a fixture clock (2026-07-09), which the Data Feeds card reads as 86d stale.
beforeAll(() => { process.env.BRIEF_HEALTH_PATH = join(dir(), 'brief-health.json'); });

function baseSnap(): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-04', generatedAt: '2026-06-04T00:00:00Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-04' },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [], dataQuality: [],
    cash: { asOf: '2026-06-04', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  } as unknown as PortfolioSnapshot;
}

describe('runBrief', () => {
  it('sends the brief once when the gate is open and records lastBriefDate', async () => {
    const statePath = join(dir(), 'state.json');
    const sent: string[] = [];
    const res = await runBrief(baseSnap(), {
      statePath, now: new Date('2026-07-09T11:00:00Z'), // 07:00 ET
      send: async (email) => { sent.push(email.subject); return { ok: true, via: 'com' }; },
    });
    expect(res.briefSent).toBe(true);
    const brief = sent.find((s) => s.includes('Daily Brief'));
    // Subject carries the SEND date, not the workbook asOf (frozen-date incident 2026-07-09:
    // briefs went out titled "— 2026-06-01" because the subject used snapshot.meta.asOf).
    expect(brief).toContain('2026-07-09');
    expect(brief).not.toContain('2026-06-04');
    const res2 = await runBrief(baseSnap(), { statePath, now: new Date('2026-07-09T15:00:00Z'), send: async () => ({ ok: true, via: 'com' }) });
    expect(res2.briefSent).toBe(false);
  });

  it('a CORRUPT state file does not re-email every open critical: suppressed once, then quiet, new criticals still alert', async () => {
    const statePath = join(dir(), 'state.json');
    writeFileSync(statePath, '{ "alertedCriticalIds": ["ins-critical-1"'); // torn write
    const snap = baseSnap();
    (snap.insurance as unknown[]) = [{ id: 'ins1', property: 'P', coverage: 'GL', carrier: 'C', expires: null, premium: 0, daysToExpiry: null, status: 'Cancelled', notes: null, flags: [] }];
    const subjects: string[] = [];
    const send = async (email: { subject: string }) => { subjects.push(email.subject); return { ok: true as const, via: 'com' as const }; };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r1 = await runBrief(snap, { statePath, now: new Date('2026-06-04T15:00:00Z'), send });
    errSpy.mockRestore();
    expect(r1.alertsSent).toBe(0); // flood suppressed
    expect(subjects.some((s) => s.includes('CRITICAL'))).toBe(false);
    expect(readdirSync(join(statePath, '..')).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);

    // The open critical was recorded as alerted: a normal next run stays quiet...
    const r2 = await runBrief(snap, { statePath, now: new Date('2026-06-04T16:00:00Z'), send });
    expect(r2.alertsSent).toBe(0);
    // ...but a genuinely NEW critical still alerts.
    (snap.insurance as unknown[]) = [
      ...(snap.insurance as unknown[]),
      { id: 'ins2', property: 'Q', coverage: 'GL', carrier: 'C', expires: null, premium: 0, daysToExpiry: null, status: 'Cancelled', notes: null, flags: [] },
    ];
    const r3 = await runBrief(snap, { statePath, now: new Date('2026-06-04T17:00:00Z'), send });
    expect(r3.alertsSent).toBe(1);
  });

  it('the recovery is persisted BEFORE the run can fail: a crash after a corrupt-state reset cannot bring the flood back', async () => {
    const statePath = join(dir(), 'state.json');
    writeFileSync(statePath, '{ torn');
    const snap = baseSnap();
    (snap.insurance as unknown[]) = [{ id: 'ins1', property: 'P', coverage: 'GL', carrier: 'C', expires: null, premium: 0, daysToExpiry: null, status: 'Cancelled', notes: null, flags: [] }];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Brief gate open (07:00 ET) so the run goes on to render; make send throw to simulate a crash mid-run.
    await expect(
      runBrief(snap, { statePath, now: new Date('2026-06-04T11:00:00Z'), send: async () => { throw new Error('boom'); } }),
    ).rejects.toThrow('boom');
    errSpy.mockRestore();
    // The next run must see a VALID state that already lists the open critical: no re-email.
    const subjects: string[] = [];
    const r = await runBrief(snap, {
      statePath, now: new Date('2026-06-04T15:00:00Z'),
      send: async (email) => { subjects.push(email.subject); return { ok: true, via: 'com' }; },
    });
    expect(r.alertsSent).toBe(0);
    expect(subjects.some((sub) => sub.includes('CRITICAL'))).toBe(false);
  });

  it('routes alerts AND the brief to ggoldberg only (routing canon, ratified 2026-07-09)', async () => {
    const statePath = join(dir(), 'state.json');
    const snap = baseSnap();
    // Inject a cancelled-insurance item so a CRITICAL alert fires immediately.
    (snap.insurance as unknown[]) = [{ id: 'ins1', property: 'P', coverage: 'GL', carrier: 'C', expires: null, premium: 0, daysToExpiry: null, status: 'Cancelled', notes: null, flags: [] }];
    const calls: { subject: string; to: string[] }[] = [];
    await runBrief(snap, {
      statePath,
      now: new Date('2026-06-04T11:00:00Z'), // 07:00 ET — brief gate open
      send: async (email, to) => { calls.push({ subject: email.subject, to }); return { ok: true, via: 'com' }; },
    });
    const alertCalls = calls.filter((c) => c.subject.includes('CRITICAL'));
    const briefCalls = calls.filter((c) => c.subject.includes('Daily Brief'));
    expect(alertCalls.length).toBeGreaterThan(0);
    expect(briefCalls.length).toBe(1);
    // Alerts must NOT include egoldberg — ggoldberg only.
    expect(alertCalls.every((c) => !c.to.includes('egoldberg@oxfordra.net'))).toBe(true);
    expect(alertCalls.every((c) => c.to.includes('ggoldberg@oxfordra.net'))).toBe(true);
    // The ora-am-brief is the routing canon's sole cc-Eric exception — it does NOT extend
    // to this brief (Gabriel-ratified 2026-07-09, setup-audit remediation).
    expect(briefCalls[0]!.to).toEqual(['ggoldberg@oxfordra.net']);
  });

  it('the Daily Brief value KPI names the residence as other holdings beside the investment value (ratified 2026-09-23)', async () => {
    // Refute finding: the emailed brief printed the investment-only value with nothing reconciling it to
    // the workbook's Portfolio Total (which includes the residence). Only when a residence row exists.
    const statePath = join(dir(), 'state.json');
    const snap = baseSnap();
    const inv = {
      id: 'p1', index: 1, name: '29000 Information Lane, Easton MD', address: '29000 Information Lane', city: null, state: null, market: 'Mid-Atlantic', type: 'Flex',
      sf: 48000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 7310000, grossIncome: 0, expenses: 0, noi: 511000, noiScenarioAdj: 511000,
      debtService: 0, netCashFlow: 0, capRate: 0.07, dscr: 2.45, lender: 'Symetra', loanBalance: 2770000, ltv: 0.38, valuePerSf: null, rentPerSf: null, equityInvested: 1000000,
      cashOnCash: null, holdYrs: null, encumbered: true, flags: [],
    };
    (snap.properties as unknown[]) = [
      inv,
      { ...inv, id: 'res', name: '9510 Persimmon Tree Rd, Potomac MD', type: 'Residence', sf: 6700, oxfordValue: 2_000_000, noi: 0, noiScenarioAdj: 0, capRate: null, dscr: null, lender: null, loanBalance: 0, ltv: null, equityInvested: 900_000, encumbered: false },
    ];
    const bodies: string[] = [];
    const res = await runBrief(snap, {
      statePath, now: new Date('2026-07-09T11:00:00Z'), // 07:00 ET — brief gate open
      send: async (email) => { if (email.subject.includes('Daily Brief')) bodies.push(email.html); return { ok: true, via: 'com' }; },
    });
    expect(res.briefSent).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Value <strong>$7.31M · +$2.00M other holdings (residence)</strong>');

    // Without a residence row the KPI is the bare investment value.
    const snap2 = baseSnap();
    (snap2.properties as unknown[]) = [inv];
    const bodies2: string[] = [];
    await runBrief(snap2, {
      statePath: join(dir(), 'state.json'), now: new Date('2026-07-09T11:00:00Z'),
      send: async (email) => { if (email.subject.includes('Daily Brief')) bodies2.push(email.html); return { ok: true, via: 'com' }; },
    });
    expect(bodies2[0]).toContain('Value <strong>$7.31M</strong>');
    expect(bodies2[0]).not.toContain('other holdings');
  });

  it('emits a same-day alert only for a newly-appeared critical item', async () => {
    const statePath = join(dir(), 'state.json');
    const snap = baseSnap();
    (snap.insurance as unknown[]) = [{ id: 'i1', property: 'P', coverage: 'GL', carrier: 'C', expires: null, premium: 0, daysToExpiry: null, status: 'Cancelled', notes: null, flags: [] }];
    const subjects: string[] = [];
    const send = async (email: { subject: string }) => { subjects.push(email.subject); return { ok: true as const, via: 'com' as const }; };
    await runBrief(snap, { statePath, now: new Date('2026-06-04T01:00:00Z'), send });
    expect(subjects.some((s) => s.includes('CRITICAL'))).toBe(true);
    subjects.length = 0;
    await runBrief(snap, { statePath, now: new Date('2026-06-04T02:00:00Z'), send });
    expect(subjects.some((s) => s.includes('CRITICAL'))).toBe(false);
  });
});

// ── Failed alert sends must be retried (2026-08-11 review finding) ───────────
// run.ts persisted `nextAlerted` regardless of whether each send SUCCEEDED, so an alert whose
// Outlook COM send failed was recorded as "already alerted" and never re-attempted. Under the
// old forget-immediately behaviour a flap-out-and-back gave it an accidental second chance;
// confirm-clear retains the id through exactly those flaps, closing the only recovery route.
// Given "under-alerting is far worse than over-alerting", a failed send must re-alert.
describe('runBrief — failed alert sends are not recorded as alerted', () => {
  // Asserts on WHICH alerts are retried, never on an absolute count: when a warehouse DB is
  // present (worktrees that copied one in, or a dev box) runBrief also emits real ins-expiry-*
  // criticals, so counts are environment-dependent while identity is not.
  function snapWithTwoCriticals(): PortfolioSnapshot {
    const snap = baseSnap();
    (snap.insurance as unknown[]) = [
      { id: 'aaa', property: 'PropAAA', coverage: 'GL', carrier: 'C', expires: null, premium: 0, daysToExpiry: null, status: 'Cancelled', notes: null, flags: [] },
      { id: 'bbb', property: 'PropBBB', coverage: 'Umbrella', carrier: 'C', expires: null, premium: 0, daysToExpiry: null, status: 'Cancelled', notes: null, flags: [] },
    ];
    return snap;
  }
  const ours = (subjects: string[]) =>
    subjects.filter((x) => x.includes('PropAAA') || x.includes('PropBBB')).sort();

  it('re-alerts on the next run when the send failed', async () => {
    const statePath = join(dir(), 'state.json');
    const now = new Date('2026-06-04T11:00:00Z');

    const firstAttempt: string[] = [];
    await runBrief(snapWithTwoCriticals(), {
      statePath, now,
      send: async (email) => {
        if (email.subject.includes('CRITICAL')) { firstAttempt.push(email.subject); return { ok: false, via: 'com', error: 'COM exit 2' }; }
        return { ok: true, via: 'com' };
      },
    });
    expect(ours(firstAttempt)).toHaveLength(2);

    // Same conditions, sends now succeed — both failures must be retried.
    const secondAttempt: string[] = [];
    await runBrief(snapWithTwoCriticals(), {
      statePath, now,
      send: async (email) => {
        if (email.subject.includes('CRITICAL')) secondAttempt.push(email.subject);
        return { ok: true, via: 'com' };
      },
    });
    expect(ours(secondAttempt)).toEqual(ours(firstAttempt));
  });

  it('a SUCCESSFUL send is still recorded, so it does not re-alert', async () => {
    const statePath = join(dir(), 'state.json');
    const now = new Date('2026-06-04T11:00:00Z');
    await runBrief(snapWithTwoCriticals(), { statePath, now, send: async () => ({ ok: true, via: 'com' }) });
    const second: string[] = [];
    await runBrief(snapWithTwoCriticals(), {
      statePath, now,
      send: async (email) => { if (email.subject.includes('CRITICAL')) second.push(email.subject); return { ok: true, via: 'com' }; },
    });
    expect(ours(second)).toEqual([]);
  });

  it('a partial failure retries ONLY the one that failed', async () => {
    const statePath = join(dir(), 'state.json');
    const now = new Date('2026-06-04T11:00:00Z');
    await runBrief(snapWithTwoCriticals(), {
      statePath, now,
      send: async (email) => (email.subject.includes('PropBBB') ? { ok: false, via: 'com', error: 'x' } : { ok: true, via: 'com' }),
    });
    const second: string[] = [];
    await runBrief(snapWithTwoCriticals(), {
      statePath, now,
      send: async (email) => { if (email.subject.includes('CRITICAL')) second.push(email.subject); return { ok: true, via: 'com' }; },
    });
    expect(ours(second)).toHaveLength(1);
    expect(ours(second)[0]).toContain('PropBBB');
  });
});

describe('runBrief — a warehouse that cannot be read for insurance is not a silent skip (refute round 2026-09-21)', () => {
  it('surfaces a warning in the brief and leaves the file unmigrated when the schema is behind', async () => {
    const d = dir();
    const dbPath = join(d, 'stale.sqlite');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE unrelated (a INTEGER)'); // exists, but no insurance tables: "behind the schema"
    seed.close();
    const prev = process.env['WAREHOUSE_DB'];
    process.env['WAREHOUSE_DB'] = dbPath;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bodies: string[] = [];
    let warnCalls: string[] = [];
    try {
      const res = await runBrief(baseSnap(), {
        statePath: join(d, 'state.json'),
        now: new Date('2026-07-09T11:00:00Z'), // brief gate open
        send: async (email) => {
          bodies.push(email.html);
          return { ok: true, via: 'com' };
        },
      });
      expect(res.briefSent).toBe(true);
    } finally {
      warnCalls = warn.mock.calls.map((c) => String(c[0])); // mockRestore() clears them
      warn.mockRestore();
      if (prev === undefined) delete process.env['WAREHOUSE_DB'];
      else process.env['WAREHOUSE_DB'] = prev;
    }
    expect(warnCalls.some((m) => m.includes('insurance conditions unavailable'))).toBe(true);
    expect(bodies.join(' | ')).toContain('Insurance alerts unavailable');
    // The read-only open must not have migrated the stale file into a full schema.
    const probe = new Database(dbPath, { readonly: true });
    try {
      expect(probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()).toEqual({ n: 1 }); // still only the seeded table
    } finally {
      probe.close();
    }
  });
});
