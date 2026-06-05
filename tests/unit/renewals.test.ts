import { describe, it, expect } from 'vitest';
import { RenewalStage, RENEWAL_STAGES, nextRenewalStage, RenewalStageInput } from '../../src/contracts/renewal';

describe('RenewalStage contract', () => {
  it('enumerates the five stages in pipeline order', () => {
    expect(RENEWAL_STAGES).toEqual(['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed']);
  });

  it('parses a valid stage and rejects an unknown one', () => {
    expect(RenewalStage.parse('Outreach')).toBe('Outreach');
    expect(RenewalStage.safeParse('Nope').success).toBe(false);
  });

  it('advances along the flow and stops at Executed', () => {
    expect(nextRenewalStage('Expiring')).toBe('Outreach');
    expect(nextRenewalStage('LOI')).toBe('Executed');
    expect(nextRenewalStage('Executed')).toBeNull();
  });

  it('validates the action input', () => {
    expect(RenewalStageInput.safeParse({ leaseId: 'L1', stage: 'LOI' }).success).toBe(true);
    expect(RenewalStageInput.safeParse({ leaseId: '', stage: 'LOI' }).success).toBe(false);
    expect(RenewalStageInput.safeParse({ leaseId: 'L1', stage: 'X' }).success).toBe(false);
  });
});
