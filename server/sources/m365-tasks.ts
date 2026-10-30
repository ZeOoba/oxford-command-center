import { createHash } from 'node:crypto';
import type { DataQualityFlag, Task, TaskStatus } from '../../src/contracts/index';
import { getGraphToken } from './graph-auth';
import { htmlToText } from './html-to-text';
import { redactNotesText } from '../../src/lib/redact-pii';

/**
 * Microsoft 365 To-Do → Tasks (Phase 6). Pulls open To-Do tasks via Microsoft Graph and prepends
 * them to the workbook checklist so they surface in the Tasks module.
 *
 * Behind the contract + graceful: with Graph unconfigured (or any error) it returns [] and the
 * workbook tasks are untouched. Server-only.
 *
 * AUTH: see graph-auth.ts. A manual GRAPH_TOKEN uses /me; the unattended client-credentials path is
 * app-only (no /me), so set GRAPH_USER to the target mailbox (UPN/email) and it queries
 * /users/{GRAPH_USER}. Until Graph is configured, this stays inert (workbook tasks only).
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Mailbox path root: app-only credentials must name a user; a delegated token defaults to /me. */
function userBase(): string {
  const user = process.env.GRAPH_USER;
  return user ? `/users/${encodeURIComponent(user)}` : '/me';
}

interface GraphTask {
  id?: string;
  title?: string;
  status?: string;
  dueDateTime?: { dateTime?: string };
  body?: { content?: string };
}

/**
 * Stable Task.id from the WHOLE source id. Graph To-Do ids share a long common mailbox/list prefix
 * and differ only past character 60, so the previous slug-and-truncate collapsed all 56 live rows
 * onto one id (found 2026-09-30). Hash the full string and truncate the HASH, never the source.
 */
const hashId = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** Outlook's "Flagged Emails" To-Do list mirrors flagged mail (incl. marketing) — not real tasks. */
export function isTaskList(list: { wellknownListName?: string }): boolean {
  return list.wellknownListName !== 'flaggedEmails';
}

const NOTE_MAX_CHARS = 200;

/** Redact, THEN bound to NOTE_MAX_CHARS (adversarial review 2026-10-30, C1): slicing first left a
 *  partial local part or 7 of 10 phone digits at the cut, which no rule recognises. A cut that lands
 *  mid-token drops that partial token (and a half-written placeholder), and the result is redacted
 *  once more so the stored note is a fixed point (the snapshot guard re-runs the same function). */
function boundedRedactedNote(note: string): string {
  const red = redactNotesText(note);
  if (red.length <= NOTE_MAX_CHARS) return red;
  let cut = red.slice(0, NOTE_MAX_CHARS);
  if (/\S/.test(red.charAt(NOTE_MAX_CHARS))) cut = cut.replace(/\S+$/, '');
  cut = cut.replace(/\s*\[(?:email|phone|contact|signature)(?: redacted)?$/, '').trimEnd();
  return redactNotesText(cut);
}

/** Map a Graph To-Do task to our Task contract. Pure (exported for tests). */
export function mapGraphTask(t: GraphTask, listName: string): Task | null {
  const label = (t.title ?? '').trim();
  if (!label) return null;
  const due = t.dueDateTime?.dateTime ?? null;
  const overdue = !!due && new Date(due).getTime() < Date.now();
  const status: TaskStatus = t.status === 'completed' ? 'done' : overdue ? 'overdue' : 'pending';
  const note = htmlToText(t.body?.content ?? '') || null;
  return {
    id: `m365-${hashId(t.id ?? label)}`,
    label,
    section: `Microsoft 365 · ${listName}`,
    role: null,
    type: 'M365 To-Do',
    dueDay: due ? due.slice(0, 10) : null,
    // Redacted HERE so every consumer (Brain.persist, the snapshot writers, bake-mirror) gets the
    // scrubbed text: To-Do bodies are pasted email threads carrying third-party contact data.
    notes: note ? boundedRedactedNote(note) : null,
    status,
    monthlyPmt: null,
  };
}

// Bounded so a hung Graph call degrades the To-Do source instead of blocking the workbook parse.
const GRAPH_FETCH_TIMEOUT_MS = 15_000;

async function graphGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Graph ${res.status}`);
  return (await res.json()) as T;
}

/**
 * How a load of the M365 To-Do source ended. Mirrors notion-deals' DealsDegradation on purpose:
 * `not-configured` is a supported mode, the rest lose live rows that were previously present.
 *
 * WHY THIS EXISTS (2026-09-05). `loadM365Tasks` used to return a bare `Task[]`, collapsing four
 * distinct states into one indistinguishable `[]`: Graph unconfigured, the token request failing,
 * the Graph call failing, and a genuinely empty list. On 2026-09-05 an `ora-lease-snapshot-refresh`
 * run hit the third of those -- `[m365-tasks] live fetch failed, skipping: fetch failed` -- and the
 * snapshot's `tasks` section silently went 115 -> 59, losing 56 M365 rows, AT EXIT 0. Nothing caught
 * it: `tasks` is not one of the section-shrink guard's five hardcoded list keys, and that guard's
 * generic half only fires on populated -> fully-empty, so a partial shrink to a still-non-empty 59
 * is invisible to it. Both snapshot tasks auto-commit and auto-push on a material diff, and Exit 0
 * suppresses their Notion and email routing, so that run would have published the loss to
 * origin/main unattended and unannounced had a separate guard not refused for an unrelated reason.
 * Reporting the reason lets parse.ts raise an error-severity flag that evaluateReconciliationGate
 * already refuses on, converting a silent Exit-0 loss into a loud Exit-1 alarm -- exactly the fix
 * shape ratified for the 2026-08-09 notion-deals seed-placeholder wipe.
 */
export type M365TasksDegradation = {
  reason: 'not-configured' | 'token-failed' | 'fetch-failed' | 'empty-result';
  detail: string;
};

export type M365TasksLoad = {
  tasks: Task[];
  /** Null on a healthy load, INCLUDING a healthy load that legitimately returned no open tasks. */
  degraded: M365TasksDegradation | null;
};

/**
 * Maps a degradation to the dataQuality flag the reconciliation gate acts on, or null when there is
 * nothing to raise. `not-configured` returns null deliberately -- a developer running without Graph
 * credentials is a supported mode, and flagging it would make the dev server permanently "dirty".
 * Same policy, and same rationale, as notion-deals' dealsDegradationFlag.
 */
export function m365TasksDegradationFlag(degraded: M365TasksDegradation | null): DataQualityFlag | null {
  if (!degraded || degraded.reason === 'not-configured') return null;
  return {
    entity: 'tasks',
    field: 'm365',
    issue:
      `Microsoft 365 To-Do source unavailable (${degraded.reason}) — the tasks section would be ` +
      `written from the workbook checklist alone, dropping every live M365 row that was previously ` +
      `present (56 rows on 2026-09-05). Refusing rather than publishing a silently truncated tasks ` +
      `section. Cause: ${degraded.detail}`,
    severity: 'error',
  };
}

/**
 * True when a snapshot's flags carry the data-losing M365 degradation above. Used by the live
 * server's mirror write (Brain.persist), a THIRD writer of portfolio.json whose own reconciliation
 * gate filters on `entity === 'reconciliation'` and so would not see this flag -- the same reason
 * notion-deals needs its own hasDealsPipelineFailure.
 */
export function hasM365TasksFailure(flags: readonly DataQualityFlag[]): boolean {
  return flags.some((f) => f.severity === 'error' && f.entity === 'tasks' && f.field === 'm365');
}

/** Open M365 To-Do tasks across the user's lists, with the reason when live rows could not be read. */
export async function loadM365Tasks(): Promise<M365TasksLoad> {
  // getGraphToken() THROWS on a failed token request (graph-auth.ts) rather than returning null, and
  // this call used to sit OUTSIDE the try below -- so a token-endpoint hiccup propagated uncaught
  // through parseWorkbook and crashed both CLI writers to Exit 3 instead of degrading cleanly to the
  // Exit 1 refusal this module now reports. Found 2026-09-05 alongside the tasks 115->59 incident.
  let token: string | null;
  try {
    token = await getGraphToken();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[m365-tasks] token request failed, skipping: ${detail}`);
    return { tasks: [], degraded: { reason: 'token-failed', detail } };
  }
  if (!token) {
    // Logged, unlike the pre-2026-09-06 silent return. This branch raises no dataQuality flag by
    // design (a credential-less dev session must not be permanently "dirty"), which made it the ONE
    // degradation that produced no output at all -- so the snapshot task specs' stdout degradation
    // scan had no string to match, on the very path a secret rotation lands on. The WRITER-side
    // refusal is requireLiveM365Source; this line is what makes it visible in a run log.
    console.warn('[m365-tasks] Graph not configured, skipping — live M365 rows will be absent');
    return {
      tasks: [],
      degraded: { reason: 'not-configured', detail: 'Graph is not configured (no GRAPH_TOKEN, no client-credentials trio)' },
    };
  }
  try {
    const base = userBase();
    const lists = await graphGet<{ value?: Array<{ id?: string; displayName?: string; wellknownListName?: string }> }>(`${base}/todo/lists?$top=10`, token);
    const listValues = (lists.value ?? []).slice(0, 10);
    if (!listValues.length) {
      // A configured token seeing ZERO To-Do lists is anomalous, not an empty inbox: every mailbox
      // carries a default list, so this is a permissions/targeting failure presenting as success
      // (a wrong GRAPH_USER, or Tasks.Read.All consent pulled in a way that returns 200 + []).
      console.warn('[m365-tasks] live fetch returned 0 To-Do lists, skipping');
      return { tasks: [], degraded: { reason: 'empty-result', detail: 'Graph returned 0 To-Do lists for a configured token' } };
    }
    const out: Task[] = [];
    for (const list of listValues) {
      if (!list.id) continue;
      if (!isTaskList(list)) continue;
      const tasks = await graphGet<{ value?: GraphTask[] }>(
        `${base}/todo/lists/${list.id}/tasks?$top=50&$filter=${encodeURIComponent("status ne 'completed'")}`,
        token,
      );
      for (const t of tasks.value ?? []) {
        const mapped = mapGraphTask(t, list.displayName ?? 'To Do');
        if (mapped) out.push(mapped);
        if (out.length >= 100) return { tasks: out, degraded: null };
      }
    }
    // NOT degraded when the lists exist but hold no open tasks: a user genuinely completing every
    // To-Do is a normal state. Deliberate divergence from notion-deals, which treats ANY empty
    // result as anomalous because a zero-row deal pipeline never is.
    return { tasks: out, degraded: null };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[m365-tasks] live fetch failed, skipping: ${detail}`);
    return { tasks: [], degraded: { reason: 'fetch-failed', detail } };
  }
}
