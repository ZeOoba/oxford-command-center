import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AlertState {
  alertedCriticalIds: string[];
  lastBriefDate: string | null; // ET YYYY-MM-DD
  dealStages: Record<string, string>; // dealId -> stage, snapshotted at last brief
}

const STATE_PATH = process.env.ALERT_STATE_PATH ?? 'data/alert-state.json';
const BRIEF_MINUTE = 6 * 60 + 45; // 06:45 ET

export function loadState(path = STATE_PATH): AlertState {
  try {
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<AlertState>;
      return { alertedCriticalIds: j.alertedCriticalIds ?? [], lastBriefDate: j.lastBriefDate ?? null, dealStages: j.dealStages ?? {} };
    }
  } catch { /* corrupt → fresh state */ }
  return { alertedCriticalIds: [], lastBriefDate: null, dealStages: {} };
}

export function saveState(state: AlertState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Which critical ids are newly appeared, and the set to persist (resolved ones dropped). */
export function diffCriticalAlerts(currentCriticalIds: string[], state: AlertState): { toAlert: string[]; nextAlerted: string[] } {
  const already = new Set(state.alertedCriticalIds);
  return {
    toAlert: currentCriticalIds.filter((id) => !already.has(id)),
    nextAlerted: [...currentCriticalIds],
  };
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
