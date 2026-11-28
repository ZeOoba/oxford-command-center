// @vitest-environment node
// 2026-11-27 review: count of deals stuck OPEN on 'acq-outcome-band-mismatch' (reporting only).
import { describe, expect, it } from 'vitest';
import { countAcqRescoreBacklog } from '../../src/modules/data/acq-rescore-backlog';

const row = (kind: string, detail: string, status = 'open') => ({ kind, detail, status });
const skip = (cand: string, iv = 'iv1', outcome = 'passed') =>
  `candidate=${cand} inputs_version=${iv} outcome=${outcome} calibration_verdict.id=7: logged band KILLED disagrees with served verdict FLOOR-FLAGGED; outcome not recorded.`;

describe('countAcqRescoreBacklog', () => {
  it('is 0 with no issues or only other kinds', () => {
    expect(countAcqRescoreBacklog([])).toBe(0);
    expect(countAcqRescoreBacklog([row('acq-outcome-unbound', skip('c1')), row('sign-undecidable', 'x')])).toBe(0);
  });

  it('counts DISTINCT deals: several rows for one candidate are one deal', () => {
    expect(countAcqRescoreBacklog([
      row('acq-outcome-band-mismatch', skip('c1', 'iv1', 'passed')),
      row('acq-outcome-band-mismatch', skip('c1', 'iv1', 'acquired')),
      row('acq-outcome-band-mismatch', skip('c1', 'iv2', 'passed')),
      row('acq-outcome-band-mismatch', skip('c10')),
    ])).toBe(2);
  });

  it('ignores resolved rows (the deal was resolved; closeAcqOutcomeSkips closed them)', () => {
    expect(countAcqRescoreBacklog([
      row('acq-outcome-band-mismatch', skip('c1'), 'resolved'),
      row('acq-outcome-band-mismatch', skip('c2')),
    ])).toBe(1);
  });

  it('keeps ids with spaces or % / _ intact, and counts an unparseable detail rather than dropping it', () => {
    expect(countAcqRescoreBacklog([
      row('acq-outcome-band-mismatch', skip('deal 50%_a')),
      row('acq-outcome-band-mismatch', skip('deal 50%_a', 'iv9')),
      row('acq-outcome-band-mismatch', 'old free-text detail'),
    ])).toBe(2);
  });
});
