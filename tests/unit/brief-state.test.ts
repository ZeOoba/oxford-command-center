import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffCriticalAlerts, loadState, loadStateChecked, saveState, parseConfirmClearRuns, shouldSendBrief, etNow, type AlertState } from '../../server/brief/state';

const emptyState: AlertState = { alertedCriticalIds: [], clearStreaks: {}, lastBriefDate: null, dealStages: {} };

describe('diffCriticalAlerts', () => {
  it('alerts only newly-appeared critical ids', () => {
    const r = diffCriticalAlerts(['a', 'b'], { ...emptyState, alertedCriticalIds: ['a'] });
    expect(r.toAlert).toEqual(['b']);
  });
  it('no re-alert when nothing changed', () => {
    const r = diffCriticalAlerts(['a'], { ...emptyState, alertedCriticalIds: ['a'] });
    expect(r.toAlert).toEqual([]);
  });

  // ── Duplicate-id guard ────────────────────────────────────────────────────
  // run.ts sends one email per entry in toAlert. A duplicated id in the current critical
  // set would therefore send the SAME alert twice in a single run. No generator produces
  // duplicate ids today, so this is defense-in-depth against the failure mode the
  // 2026-06-21 incident was originally (mis)diagnosed as.
  it('a duplicated id in the current set alerts only ONCE', () => {
    const r = diffCriticalAlerts(['a', 'a', 'b'], emptyState);
    expect(r.toAlert).toEqual(['a', 'b']);
    expect(r.nextAlerted).toEqual(['a', 'b']);
  });
});

// ── Confirm-clear suppression (2026-08-11) ──────────────────────────────────
// Root cause of the cross-run re-alert storms (07-12, 07-24): nextAlerted was
// `[...currentCriticalIds]`, so the persisted set was OVERWRITTEN with the current set every
// run. Any condition that transiently vanished from the snapshot was forgotten and re-alerted
// on reappearance. Proof it was flapping rather than a wiped state file: on 2026-07-24 the
// 14:00 run re-sent ONLY Fixture Countertops while Example Tint/Example Hood/Tenant 035 LLC stayed quiet — Fixture Countertops
// dropped out of the 13:01 run and came back. The upstream snapshot is known-unstable
// (parseleases phantom-lease and Notion seed-fallback regressions).
// Ruling (Gabriel, 2026-08-11): sticky state + confirm-clear — a condition must be absent for
// K consecutive runs before it is forgotten.
describe('diffCriticalAlerts — confirm-clear before forgetting a condition', () => {
  // NOTE ON FIXTURES: every case below keeps a co-present 'anchor' condition in the current
  // set. That is not incidental — it models the incident accurately. At 13:01 on 07-24 the run
  // DID produce criticals (Tenant Kappa alerted); Fixture Countertops alone dropped out. A fixture passing
  // an EMPTY current set would instead exercise the total-outage guard further down, which
  // holds everything and would make these assertions meaningless.
  const withAnchor = (ids: string[]): AlertState => ({ ...emptyState, alertedCriticalIds: ['anchor', ...ids] });
  const step = (current: string[], prev: { nextAlerted: string[]; nextClearStreaks: Record<string, number> }) =>
    diffCriticalAlerts(current, { ...emptyState, alertedCriticalIds: prev.nextAlerted, clearStreaks: prev.nextClearStreaks });

  it('a single-run dropout does NOT forget the condition (the 07-24 Fixture Countertops case)', () => {
    const r = diffCriticalAlerts(['anchor'], withAnchor(['counters']));
    expect(r.nextAlerted).toContain('counters');
    expect(r.nextClearStreaks['counters']).toBe(1);
  });

  it('the condition reappearing after a one-run dropout does NOT re-alert', () => {
    const afterDropout = diffCriticalAlerts(['anchor'], withAnchor(['counters']));
    const onReturn = step(['anchor', 'counters'], afterDropout);
    expect(onReturn.toAlert).toEqual([]); // this is the whole defect
  });

  it('absent for K consecutive runs → genuinely forgotten', () => {
    const run1 = diffCriticalAlerts(['anchor'], withAnchor(['counters']));
    const run2 = step(['anchor'], run1);
    expect(run2.nextAlerted).not.toContain('counters');
    expect(run2.nextClearStreaks['counters']).toBeUndefined();
  });

  it('a genuinely-resolved condition re-alerts if it later recurs', () => {
    const run1 = diffCriticalAlerts(['anchor'], withAnchor(['counters']));
    const run2 = step(['anchor'], run1);
    const recurrence = step(['anchor', 'counters'], run2);
    expect(recurrence.toAlert).toEqual(['counters']);
  });

  it('a reappearance RESETS the clear streak (no slow leak to forgotten)', () => {
    const dropout = diffCriticalAlerts(['anchor'], withAnchor(['counters']));
    const back = step(['anchor', 'counters'], dropout);
    expect(back.nextClearStreaks['counters']).toBeUndefined();
    const dropAgain = step(['anchor'], back);
    expect(dropAgain.nextAlerted).toContain('counters'); // streak restarted at 1, not 2
  });

  it('tracks several conditions independently', () => {
    const r = diffCriticalAlerts(['b'], { ...emptyState, alertedCriticalIds: ['a', 'b'] });
    expect(r.toAlert).toEqual([]);
    expect(r.nextAlerted).toEqual(expect.arrayContaining(['a', 'b']));
    expect(r.nextClearStreaks['a']).toBe(1);
    expect(r.nextClearStreaks['b']).toBeUndefined();
  });

  it('confirmClearRuns = 1 restores immediate-forget behaviour', () => {
    const r = diffCriticalAlerts(['anchor'], withAnchor(['a']), 1);
    expect(r.nextAlerted).not.toContain('a');
  });

  it('tolerates legacy state written before clearStreaks existed', () => {
    const legacy = { alertedCriticalIds: ['anchor', 'a'], lastBriefDate: null, dealStages: {} } as AlertState;
    const r = diffCriticalAlerts(['anchor'], legacy);
    expect(r.nextAlerted).toContain('a');
    expect(r.nextClearStreaks['a']).toBe(1);
  });

  it('does not accumulate streaks for ids that are no longer tracked', () => {
    const r = diffCriticalAlerts(['a'], {
      ...emptyState, alertedCriticalIds: ['a'], clearStreaks: { ghost: 5 },
    });
    expect(r.nextClearStreaks['ghost']).toBeUndefined();
  });
});

describe('shouldSendBrief (06:45 ET, once per ET day)', () => {
  it('fires at/after 06:45 when not yet sent today', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-03' }, { date: '2026-06-04', minutes: 405 })).toBe(true);
  });
  it('does not fire before 06:45', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-03' }, { date: '2026-06-04', minutes: 404 })).toBe(false);
  });
  it('does not fire twice the same ET day', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-04' }, { date: '2026-06-04', minutes: 600 })).toBe(false);
  });
});

describe('etNow', () => {
  it('returns an ET YYYY-MM-DD date and minutes-since-midnight', () => {
    const r = etNow(new Date('2026-06-04T12:00:00Z')); // noon UTC = 08:00 ET (EDT)
    expect(r.date).toBe('2026-06-04');
    expect(r.minutes).toBe(8 * 60);
  });
});

// ── Total-outage guard + env hardening (2026-08-11 review findings) ──────────
describe('diffCriticalAlerts — total-outage guard', () => {
  // The 07-24 22:00 storm (8 emails) followed an ~8h gap with a "portfolio.json stale" ALARM
  // at 19:42 — i.e. an absence spanning MANY runs, not the single-run dropout confirm-clear
  // handles. run.ts fail-opens on a warehouse error (silently dropping every insurance
  // critical) and a stale snapshot does the same for leases, so "zero criticals portfolio-wide"
  // is far more likely a data failure than genuine simultaneous resolution of everything.
  // Without this, K=2 forgets the world after two bad runs and re-alerts it all on recovery.
  it('an empty critical set does NOT age or forget a non-empty alerted set', () => {
    const r = diffCriticalAlerts([], { ...emptyState, alertedCriticalIds: ['a', 'b'] });
    expect(r.nextAlerted).toEqual(expect.arrayContaining(['a', 'b']));
    expect(r.nextClearStreaks).toEqual({}); // held, not aged
  });

  it('holds across MANY consecutive empty runs (the 07-24 22:00 shape)', () => {
    let s: AlertState = { ...emptyState, alertedCriticalIds: ['a', 'b'] };
    for (let i = 0; i < 8; i++) {
      const r = diffCriticalAlerts([], s);
      s = { ...emptyState, alertedCriticalIds: r.nextAlerted, clearStreaks: r.nextClearStreaks };
    }
    expect(s.alertedCriticalIds).toEqual(expect.arrayContaining(['a', 'b']));
    // ...and recovery re-alerts NOTHING, because nothing was ever forgotten.
    expect(diffCriticalAlerts(['a', 'b'], s).toAlert).toEqual([]);
  });

  it('a genuine partial resolution still ages normally', () => {
    // Only the all-empty case is treated as suspect; 'a' resolving while 'b' persists is real.
    const r1 = diffCriticalAlerts(['b'], { ...emptyState, alertedCriticalIds: ['a', 'b'] });
    expect(r1.nextClearStreaks['a']).toBe(1);
    const r2 = diffCriticalAlerts(['b'], { ...emptyState, alertedCriticalIds: r1.nextAlerted, clearStreaks: r1.nextClearStreaks });
    expect(r2.nextAlerted).not.toContain('a');
  });

  it('an empty set with an empty alerted set is a no-op, not a hold', () => {
    const r = diffCriticalAlerts([], emptyState);
    expect(r.nextAlerted).toEqual([]);
    expect(r.toAlert).toEqual([]);
  });
});

describe('parseConfirmClearRuns', () => {
  // Tested against the REAL exported parser, not a re-implementation of it in the test —
  // a test that recomputes the logic it is checking proves only that the test agrees with
  // itself. `Number(x) || 2` silently mapped '0' to 2 rather than the documented floor of 1,
  // accepted fractional thresholds, and let 'Infinity' mean "never forget anything".
  it.each([
    ['0', 1],          // below the floor
    ['-5', 1],
    ['1.9', 1],        // truncated, not rounded
    ['3', 3],
    ['abc', 2],        // unparseable -> default
    ['', 2],           // present-but-empty is "unset", not 0
    ['Infinity', 2],   // non-finite must never disable forgetting
    [undefined, 2],
  ])('%s -> %i', (raw, expected) => {
    const parsed = parseConfirmClearRuns(raw as string | undefined);
    expect(parsed).toBe(expected);
    expect(Number.isInteger(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(1);
  });

  it('a non-finite threshold cannot make the alerted set grow forever', () => {
    const r = diffCriticalAlerts(['anchor'], { ...emptyState, alertedCriticalIds: ['anchor', 'a'] }, Infinity);
    // Infinity must fall back to the default, so 'a' still ages and can be forgotten.
    expect(r.nextClearStreaks['a']).toBe(1);
    const r2 = diffCriticalAlerts(['anchor'], { ...emptyState, alertedCriticalIds: r.nextAlerted, clearStreaks: r.nextClearStreaks }, Infinity);
    expect(r2.nextAlerted).not.toContain('a');
  });
});

// -- Durable state file (cc-audit-army 2026-09-28, brief-state-nonatomic-reset-storm) -------------
// A truncated/corrupt state file used to reset silently to an empty alerted set, so the next run
// re-emailed EVERY open critical. saveState is now temp+rename, and a corrupt file is moved aside
// and reported so the caller can suppress the flood.
describe('alert state file durability', () => {
  const tmpState = () => join(mkdtempSync(join(tmpdir(), 'brief-state-')), 'state.json');

  it('a missing file is a normal first run: fresh state, not recovered', () => {
    const r = loadStateChecked(tmpState());
    expect(r.recovered).toBe(false);
    expect(r.state.alertedCriticalIds).toEqual([]);
  });

  it('round-trips a saved state and leaves no .tmp behind (atomic write)', () => {
    const p = tmpState();
    saveState({ ...emptyState, alertedCriticalIds: ['a', 'b'] }, p);
    expect(existsSync(`${p}.tmp`)).toBe(false);
    const r = loadStateChecked(p);
    expect(r.recovered).toBe(false);
    expect(r.state.alertedCriticalIds).toEqual(['a', 'b']);
  });

  it('a truncated file is moved aside (evidence kept), reported as recovered, and starts fresh', () => {
    const p = tmpState();
    saveState({ ...emptyState, alertedCriticalIds: ['a', 'b'] }, p);
    writeFileSync(p, readFileSync(p, 'utf8').slice(0, 20)); // simulate a torn write
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = loadStateChecked(p);
    err.mockRestore();
    expect(r.recovered).toBe(true);
    expect(r.state.alertedCriticalIds).toEqual([]);
    expect(existsSync(p)).toBe(false);
    const aside = readdirSync(join(p, '..')).filter((f) => f.startsWith('state.json.corrupt-'));
    expect(aside).toHaveLength(1);
  });

  it('valid JSON that is not an object (null) counts as corrupt and is quarantined', () => {
    const p = tmpState();
    writeFileSync(p, 'null');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(loadStateChecked(p).recovered).toBe(true);
    err.mockRestore();
    expect(readdirSync(join(p, '..')).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('a filesystem read error is NOT treated as corruption: the good file stays in place and the error propagates', () => {
    const p = tmpState();
    saveState({ ...emptyState, alertedCriticalIds: ['keep'] }, p);
    // A directory at the path makes readFileSync throw EISDIR (a stand-in for EBUSY/EPERM): not a parse error.
    const dirPath = join(mkdtempSync(join(tmpdir(), 'brief-state-dir-')), 'state.json');
    mkdirSync(dirPath);
    expect(() => loadStateChecked(dirPath)).toThrow();
    expect(existsSync(dirPath)).toBe(true); // not moved aside
    expect(readdirSync(join(dirPath, '..')).some((f) => f.includes('.corrupt-'))).toBe(false);
    expect(loadStateChecked(p).state.alertedCriticalIds).toEqual(['keep']); // control: normal file unaffected
  });

  it('loadState keeps its old contract: corrupt -> fresh state', () => {
    const p = tmpState();
    writeFileSync(p, '{ nope');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(loadState(p).alertedCriticalIds).toEqual([]);
    err.mockRestore();
  });
});
