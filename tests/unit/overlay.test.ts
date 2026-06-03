import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { applyOverlay, nextStage } from '../../server/overlay';

const base = {
  deals: [{ id: 'd1', name: 'FVC', stage: 'Candidate' }],
  tasks: [{ id: 't-wb', label: 'Workbook task', section: 'Ops' }],
} as unknown as PortfolioSnapshot;

describe('nextStage — pipeline advance path', () => {
  it('advances along the flow and stops at Closed', () => {
    expect(nextStage('Sourcing')).toBe('Candidate');
    expect(nextStage('Candidate')).toBe('LOI/PSA');
    expect(nextStage('Closing')).toBe('Closed');
    expect(nextStage('Closed')).toBeNull();
    expect(nextStage('Dead')).toBeNull(); // off-path stages don't advance
  });
});

describe('applyOverlay — write-back merge (workbook stays canonical)', () => {
  it('overrides a deal stage from the overlay', () => {
    const out = applyOverlay(base, { dealStages: { d1: 'LOI/PSA' }, tasks: [] });
    expect(out.deals[0]!.stage).toBe('LOI/PSA');
  });

  it('prepends overlay tasks ahead of workbook tasks', () => {
    const out = applyOverlay(base, { dealStages: {}, tasks: [{ id: 'u1', label: 'User task', section: 'Added', role: null, type: null, dueDay: null, notes: null, status: 'pending', monthlyPmt: null }] });
    expect(out.tasks.map((t) => t.id)).toEqual(['u1', 't-wb']);
  });

  it('never mutates the base snapshot (workbook is read-only)', () => {
    applyOverlay(base, { dealStages: { d1: 'Closed' }, tasks: [] });
    expect(base.deals[0]!.stage).toBe('Candidate'); // unchanged
  });
});
