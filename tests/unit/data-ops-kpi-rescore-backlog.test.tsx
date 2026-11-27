// 2026-11-27 review: the Open DQ Issues KPI surfaces deals stuck OPEN on 'acq-outcome-band-mismatch'.
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { DataOpsKpiRow } from '../../src/modules/data/DataOpsKpiRow';

afterEach(cleanup);

const base = { committed: 3, pending: 0, openIssues: 5, propertiesCovered: 2, latestPeriod: '2025' };

describe('DataOpsKpiRow — re-score backlog', () => {
  it('names the stuck-deal count under Open DQ Issues', () => {
    render(<DataOpsKpiRow {...base} rescoreBacklog={2} />);
    expect(screen.getByText('2 deals stuck OPEN on re-score band mismatch')).toBeTruthy();
  });

  it('singular for one deal; nothing when the backlog is empty or not passed', () => {
    render(<DataOpsKpiRow {...base} rescoreBacklog={1} />);
    expect(screen.getByText('1 deal stuck OPEN on re-score band mismatch')).toBeTruthy();
    cleanup();
    render(<DataOpsKpiRow {...base} rescoreBacklog={0} />);
    expect(screen.queryByText(/re-score band mismatch/)).toBeNull();
    cleanup();
    render(<DataOpsKpiRow {...base} />);
    expect(screen.queryByText(/re-score band mismatch/)).toBeNull();
  });
});
