import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { renameSyncWithRetry } from '../lib/rename-retry';
import { AlertInboxState, EMPTY_INBOX_STATE, type AlertActionInput } from '../../src/contracts/alerts';
import { applyAlertAction } from '../../src/brain/alerts-view';

const DEFAULT_PATH = process.env.ALERT_INBOX_PATH ?? 'data/alert-inbox.json';

/**
 * Load the alert inbox (dismissals + snoozes). A missing file is a normal first run. An existing file
 * that fails JSON or schema validation is moved aside, never overwritten: the next `runAlertAction`
 * saves over `path`, so silently returning an empty state used to erase every dismissal and snooze
 * (cc-audit-army 2026-09-28, alert-inbox-silent-wipe). The corrupt copy is kept as `<path>.corrupt-<ts>`.
 */
export function loadInboxState(path = DEFAULT_PATH): AlertInboxState {
  if (!existsSync(path)) return { ...EMPTY_INBOX_STATE };
  try {
    return AlertInboxState.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    // Quarantine only genuine corruption (bad JSON or a schema mismatch). A filesystem error says
    // nothing about the file's contents: returning empty for it would let the next action overwrite a
    // perfectly good inbox. Rethrow so the caller fails loudly and can retry.
    if (!(err instanceof SyntaxError) && (err as Error | undefined)?.name !== 'ZodError') throw err;
    const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSyncWithRetry(path, aside);
    } catch { /* could not move it aside: still return empty so the app keeps working */ }
    console.error(`alerts: inbox state at ${path} is unreadable (${err instanceof Error ? err.message : String(err)}); moved to ${aside}, starting empty`);
    return { ...EMPTY_INBOX_STATE };
  }
}

export function saveInboxState(state: AlertInboxState, path = DEFAULT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSyncWithRetry(tmp, path);
}

/** Load → apply → save. Returns the new state. */
export function runAlertAction(input: AlertActionInput, path = DEFAULT_PATH): AlertInboxState {
  const next = applyAlertAction(loadInboxState(path), input, Date.now());
  saveInboxState(next, path);
  return next;
}
