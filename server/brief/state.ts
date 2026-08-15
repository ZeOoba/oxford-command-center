import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AlertState {
  alertedCriticalIds: string[];
  /**
   * id -> number of CONSECUTIVE runs this already-alerted condition has been absent from the
   * critical set. Only ids still present in `alertedCriticalIds` appear here; an id observed
   * again has its entry deleted, not zeroed. Optional so state files written before
   * 2026-08-11 still load.
   */
  clearStreaks?: Record<string, number>;
  lastBriefDate: string | null; // ET YYYY-MM-DD
  dealStages: Record<string, string>; // dealId -> stage, snapshotted at last brief
}

const STATE_PATH = process.env.ALERT_STATE_PATH ?? 'data/alert-state.json';
const BRIEF_MINUTE = 6 * 60 + 45; // 06:45 ET

const DEFAULT_CONFIRM_CLEAR_RUNS = 2;

/**
 * Parse the confirm-clear threshold: how many CONSECUTIVE runs a condition must be absent
 * before it is treated as resolved and dropped from the alerted set. 2 = one transient dropout
 * is tolerated; a condition genuinely gone stays gone after the second clean run.
 *
 * Exported so tests exercise the real parser rather than re-deriving it. Hardened after review
 * (2026-08-11): a bare `Number(x) || 2` mapped '0' to 2 rather than the documented floor of 1,
 * accepted fractional thresholds, and — worst — let `Infinity` through, which would mean no
 * condition is EVER forgotten and `alertedCriticalIds`/`clearStreaks` grow without bound.
 */
export function parseConfirmClearRuns(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONFIRM_CLEAR_RUNS;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_CONFIRM_CLEAR_RUNS; // NaN / ±Infinity
  return Math.max(1, n); // floor: 1 == the pre-2026-08-11 forget-immediately behaviour
}

const CONFIRM_CLEAR_RUNS = parseConfirmClearRuns(process.env.ALERT_CONFIRM_CLEAR_RUNS);

export function loadState(path = STATE_PATH): AlertState {
  try {
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<AlertState>;
      return {
        alertedCriticalIds: j.alertedCriticalIds ?? [],
        clearStreaks: j.clearStreaks ?? {},
        lastBriefDate: j.lastBriefDate ?? null,
        dealStages: j.dealStages ?? {},
      };
    }
  } catch { /* corrupt → fresh state */ }
  return { alertedCriticalIds: [], clearStreaks: {}, lastBriefDate: null, dealStages: {} };
}

export function saveState(state: AlertState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Which critical ids are newly appeared, and the state to persist.
 *
 * A condition is forgotten only after it has been ABSENT for `confirmClearRuns` consecutive
 * runs. Before 2026-08-11 `nextAlerted` was simply `[...currentCriticalIds]` — the persisted
 * set was overwritten with the current set on every run, so any condition that transiently
 * vanished from the snapshot was forgotten immediately and re-alerted the moment it came back.
 * That produced the 07-12 and 07-24 re-alert storms: on 07-24 the 14:00 run re-sent ONLY
 * Granite Tops (it had dropped out of the 13:01 run and returned) while every other open
 * condition stayed correctly quiet. The upstream snapshot is known to flap — see the
 * parseLeases phantom-lease and portfolio.json Notion seed-fallback regressions.
 *
 * `toAlert` is de-duplicated: run.ts sends one email per entry, so a repeated id would send
 * the same alert twice within a single run.
 */
export function diffCriticalAlerts(
  currentCriticalIds: string[],
  state: AlertState,
  confirmClearRuns: number = CONFIRM_CLEAR_RUNS,
): { toAlert: string[]; nextAlerted: string[]; nextClearStreaks: Record<string, number> } {
  // Sanitize here too — callers pass this explicitly in tests, and a non-finite threshold
  // would disable forgetting entirely.
  const threshold = parseConfirmClearRuns(String(confirmClearRuns));
  const already = new Set(state.alertedCriticalIds);
  const priorStreaks = state.clearStreaks ?? {};

  // De-duplicate while preserving first-seen order.
  const current = [...new Set(currentCriticalIds)];
  const currentSet = new Set(current);

  const toAlert = current.filter((id) => !already.has(id));

  // TOTAL-OUTAGE GUARD: zero criticals portfolio-wide, when we were tracking some, is far
  // more likely a data failure than every condition resolving at once. run.ts fail-opens on a
  // warehouse error (silently dropping EVERY insurance critical) and a stale snapshot does the
  // same for leases. Without this, two bad runs forget the world and recovery re-emails all of
  // it — which is the 2026-07-24 22:00 shape (8 alerts after an ~8h gap and a "portfolio.json
  // stale" alarm), an absence far longer than confirm-clear alone tolerates. Hold everything,
  // age nothing, alert nothing. Deliberately narrow: a PARTIAL set still ages normally, so a
  // genuine one-off resolution is not masked.
  if (current.length === 0 && state.alertedCriticalIds.length > 0) {
    return { toAlert: [], nextAlerted: [...already], nextClearStreaks: {} };
  }

  // Currently-firing conditions are always retained, with any clear streak reset by omission.
  const nextAlerted = [...current];
  const nextClearStreaks: Record<string, number> = {};

  // Previously-alerted conditions absent this run: age them, and retain until they have been
  // absent long enough to be believed resolved.
  for (const id of already) {
    if (currentSet.has(id)) continue;
    const streak = (priorStreaks[id] ?? 0) + 1;
    if (streak < threshold) {
      nextAlerted.push(id);
      nextClearStreaks[id] = streak;
    }
    // streak >= threshold → dropped from both, so a genuine recurrence re-alerts later.
  }

  return { toAlert, nextAlerted, nextClearStreaks };
}

export function shouldSendBrief(state: AlertState, now: { date: string; minutes: number }): boolean {
  return now.minutes >= BRIEF_MINUTE && state.lastBriefDate !== now.date;
}

/** ET date (YYYY-MM-DD) + minutes since ET midnight. Injectable clock for tests. */
export function etNow(now: Date = new Date()): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = get('hour') === '24' ? '00' : get('hour'); // Intl can emit 24 at midnight
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(hour) * 60 + Number(get('minute')) };
}
