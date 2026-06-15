import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { runBrief } from '../../server/brief/run';

const dir = () => mkdtempSync(join(tmpdir(), 'run-'));
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
      statePath, now: new Date('2026-06-04T11:00:00Z'), // 07:00 ET
      send: async (email) => { sent.push(email.subject); return { ok: true, via: 'com' }; },
    });
    expect(res.briefSent).toBe(true);
    expect(sent.some((s) => s.includes('Daily Brief'))).toBe(true);
    const res2 = await runBrief(baseSnap(), { statePath, now: new Date('2026-06-04T15:00:00Z'), send: async () => ({ ok: true, via: 'com' }) });
    expect(res2.briefSent).toBe(false);
  });

  it('routes alerts to ggoldberg only; brief cc-s egoldberg (routing canon)', async () => {
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
    // Brief cc's egoldberg (sole exception per routing canon).
    expect(briefCalls[0]!.to).toContain('egoldberg@oxfordra.net');
    expect(briefCalls[0]!.to).toContain('ggoldberg@oxfordra.net');
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
