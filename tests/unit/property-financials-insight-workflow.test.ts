// @vitest-environment node
//
// tests/unit/property-financials-insight-workflow.test.ts — T5 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The client-side form rules for an
// insight's owner / due date / status (dismissed requires a reason), and parity with the server's own
// PUT schema (server/property-financials/status-store.ts InsightStatusInput): whatever the form
// accepts, the server accepts, and the form refuses what the server would refuse.
import { describe, expect, it } from 'vitest';
import { InsightStatusInput, PF_INSIGHT_STATUSES as SERVER_STATUSES, type InsightStatusRecord } from '../../server/property-financials/status-store';
import type { PfDataHealthMeta as ServerMeta, PfLoadResult } from '../../server/property-financials/loader';
import {
  PF_INSIGHT_STATUSES,
  draftFromRecord,
  validateInsightStatusDraft,
  type InsightStatusDraft,
} from '../../src/modules/property-financials/insight-workflow';
import type { PfDataHealthMeta, PfDatasetResponse, PfInsightStatusRecord } from '../../src/modules/property-financials/types';

const draft = (o: Partial<InsightStatusDraft> = {}): InsightStatusDraft => ({ owner: '', dueDate: '', status: 'open', dismissReason: '', ...o });

describe('validateInsightStatusDraft', () => {
  it('an empty open draft is valid and sends nulls', () => {
    expect(validateInsightStatusDraft(draft())).toEqual({ ok: true, body: { owner: null, dueDate: null, status: 'open', dismissReason: null } });
  });

  it('trims the owner and keeps a real due date', () => {
    const r = validateInsightStatusDraft(draft({ owner: '  Gabriel ', dueDate: '2026-10-31', status: 'in_progress' }));
    expect(r).toEqual({ ok: true, body: { owner: 'Gabriel', dueDate: '2026-10-31', status: 'in_progress', dismissReason: null } });
  });

  it('dismissed REQUIRES a reason (blank or whitespace is refused)', () => {
    for (const reason of ['', '   ']) {
      const r = validateInsightStatusDraft(draft({ status: 'dismissed', dismissReason: reason }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.dismissReason).toBe('A reason is required to dismiss an item.');
    }
    const ok = validateInsightStatusDraft(draft({ status: 'dismissed', dismissReason: ' duplicate of EXP-04 ' }));
    expect(ok).toEqual({ ok: true, body: { owner: null, dueDate: null, status: 'dismissed', dismissReason: 'duplicate of EXP-04' } });
  });

  it('a leftover reason is dropped (not sent) when the status is not dismissed', () => {
    const r = validateInsightStatusDraft(draft({ status: 'resolved', dismissReason: 'stale text' }));
    expect(r.ok && r.body.dismissReason).toBeNull();
  });

  it('refuses an impossible date and over-long fields', () => {
    const bad = validateInsightStatusDraft(draft({ dueDate: '2026-02-30', owner: 'x'.repeat(81) }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.dueDate).toBeTruthy();
      expect(bad.errors.owner).toBeTruthy();
    }
    const longReason = validateInsightStatusDraft(draft({ status: 'dismissed', dismissReason: 'r'.repeat(501) }));
    expect(longReason.ok).toBe(false);
  });

  it('draftFromRecord round-trips a stored record and defaults to open', () => {
    expect(draftFromRecord(undefined)).toEqual(draft());
    const rec: PfInsightStatusRecord = { insightId: 'EXP-01', owner: 'Eric', dueDate: '2026-11-01', status: 'dismissed', dismissReason: 'n/a', updatedAt: '2026-10-05T12:00:00.000Z' };
    expect(draftFromRecord(rec)).toEqual({ owner: 'Eric', dueDate: '2026-11-01', status: 'dismissed', dismissReason: 'n/a' });
  });
});

describe('parity with the server PUT schema', () => {
  it('same status vocabulary', () => {
    expect([...PF_INSIGHT_STATUSES]).toEqual([...SERVER_STATUSES]);
  });

  const cases: InsightStatusDraft[] = [
    draft(),
    draft({ owner: 'Gabriel', dueDate: '2026-12-31' }),
    draft({ status: 'dismissed', dismissReason: '' }),
    draft({ status: 'dismissed', dismissReason: 'not ours' }),
    draft({ status: 'resolved', dismissReason: 'ignored' }),
    draft({ dueDate: '2026-02-30' }),
    draft({ dueDate: '10/31/2026' }),
    draft({ owner: 'x'.repeat(80) }),
    draft({ owner: 'x'.repeat(81) }),
    draft({ status: 'dismissed', dismissReason: 'r'.repeat(500) }),
    draft({ status: 'dismissed', dismissReason: 'r'.repeat(501) }),
  ];

  for (const [i, c] of cases.entries()) {
    it(`case ${i}: form accepts ⇔ server accepts the body it would send`, () => {
      const r = validateInsightStatusDraft(c);
      if (r.ok) {
        expect(InsightStatusInput.safeParse(r.body).success).toBe(true);
      } else {
        // The raw draft mapped the naive way must also be refused by the server.
        const naive = {
          owner: c.owner.trim() || null,
          dueDate: c.dueDate || null,
          status: c.status,
          dismissReason: c.status === 'dismissed' ? c.dismissReason.trim() || null : null,
        };
        expect(InsightStatusInput.safeParse(naive).success).toBe(false);
      }
    });
  }
});

describe('client response types stay assignable from the server types (compile-time, checked by tsc)', () => {
  it('records, data-health meta and the dataset envelope', () => {
    const rec: InsightStatusRecord = { insightId: 'EXP-01', owner: null, dueDate: null, status: 'open', dismissReason: null, updatedAt: '2026-10-05T00:00:00.000Z' };
    const asClient: PfInsightStatusRecord = rec;
    const back: InsightStatusRecord = asClient;
    const meta = null as ServerMeta | null;
    const clientMeta: PfDataHealthMeta | null = meta;
    const load = { availability: 'missing', readError: null, lastGoodLoadedAt: null, issues: [], dataset: null, meta: null } as PfLoadResult;
    const envelope: PfDatasetResponse = load;
    expect(back.insightId).toBe('EXP-01');
    expect(clientMeta).toBeNull();
    expect(envelope.availability).toBe('missing');
  });
});
