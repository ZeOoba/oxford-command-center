import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { AlertInboxState, EMPTY_INBOX_STATE, type AlertActionInput } from '../../src/contracts/alerts';
import { applyAlertAction } from '../../src/brain/alerts-view';

const DEFAULT_PATH = process.env.ALERT_INBOX_PATH ?? 'data/alert-inbox.json';

export function loadInboxState(path = DEFAULT_PATH): AlertInboxState {
  if (!existsSync(path)) return { ...EMPTY_INBOX_STATE };
  try {
    return AlertInboxState.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { ...EMPTY_INBOX_STATE };
  }
}

export function saveInboxState(state: AlertInboxState, path = DEFAULT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Load → apply → save. Returns the new state. */
export function runAlertAction(input: AlertActionInput, path = DEFAULT_PATH): AlertInboxState {
  const next = applyAlertAction(loadInboxState(path), input, Date.now());
  saveInboxState(next, path);
  return next;
}
