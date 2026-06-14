// tests/unit/acquisition-workbench.test.tsx
//
// Render smoke for the Acquisition Workbench. `scoreFn` is injected so there is NO network and NO module
// mocking (vitest.config isolate:false makes vi.mock bleed — injection is the safe pattern). Proves the
// form mounts and the live score panel (verdict, sub-scores, gates, DD, cap banner) renders on a
// real-shaped AcquisitionScore, and that an engine-unavailable error degrades without crashing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { AcquisitionScore } from '@contracts/acquisition';
import { AcquisitionWorkbench } from '../../src/modules/acquisitions/AcquisitionWorkbench';
import { AcquisitionEngineUnavailable } from '../../src/modules/acquisitions/acquisition-score';

const mockScore: AcquisitionScore = {
  schemaVersion: '1.0.0', inputsVersion: 'abc1234567890def', rulesetVersion: '1.0.0', ratification: 'ratified',
  scoredAt: '2026-06-14T00:00:00Z', dealId: 'workbench', isVacant: false,
  gates: [
    { id: 'product', passed: true, detail: 'shallow-bay-multi OK' },
    { id: 'physical', passed: true, detail: 'physical OK' },
  ],
  gatesPassed: true,
  floors: [{ id: 'basis', passed: true, actual: 0.56, required: 0.25, detail: '56.0% vs 25% required' }],
  floorsPassed: true,
  ddCriticalUnresolved: ['roof'],
  subScores: [
    { id: 'basis', points: 45, maxPoints: 45, normalized: 100, confidence: 'confirmed' },
    { id: 'asset', points: 20, maxPoints: 26, normalized: 77, confidence: 'confirmed' },
    { id: 'market', points: 12, maxPoints: 12, normalized: 100, confidence: 'confirmed' },
    { id: 'risk', points: 14, maxPoints: 17, normalized: 82, confidence: 'estimated' },
  ],
  composite: 91, tier: 'T2', verdict: 'WATCH', cappedAtT2: true, incompleteRuleset: false, advisoryOnly: false,
  confidence: 'estimated', reasons: ['Composite 91/100 → T1.', 'Capped T1 → T2: DD-critical unresolved: roof.'],
  dataQuality: [],
};

afterEach(() => cleanup());

describe('AcquisitionWorkbench (render smoke)', () => {
  it('renders the form and the live score from an injected scorer', async () => {
    const scoreFn = vi.fn(async () => mockScore);
    render(<AcquisitionWorkbench scoreFn={scoreFn} />);

    // form mounts immediately
    expect(screen.getByText('Underwriting Inputs')).toBeTruthy();
    expect(screen.getByText('Oxford Acquisition Score')).toBeTruthy();

    // debounced score arrives and renders the verdict + cap + DD chip + a sub-score label
    await waitFor(() => expect(screen.getAllByText('WATCH').length).toBeGreaterThan(0));
    expect(scoreFn).toHaveBeenCalled();
    expect(screen.getAllByText(/roof/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('basis').length).toBeGreaterThan(0);
  });

  it('surfaces an engine-unavailable error without crashing', async () => {
    const scoreFn = vi.fn(async (): Promise<AcquisitionScore> => { throw new AcquisitionEngineUnavailable(); });
    render(<AcquisitionWorkbench scoreFn={scoreFn} />);
    await waitFor(() => expect(screen.getByText(/engine unavailable/i)).toBeTruthy());
  });
});
