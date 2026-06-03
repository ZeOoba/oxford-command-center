import type { Task, TaskStatus } from '../../src/contracts/index';
import { getGraphToken } from './graph-auth';

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

const slugId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Map a Graph To-Do task to our Task contract. Pure (exported for tests). */
export function mapGraphTask(t: GraphTask, listName: string): Task | null {
  const label = (t.title ?? '').trim();
  if (!label) return null;
  const due = t.dueDateTime?.dateTime ?? null;
  const overdue = !!due && new Date(due).getTime() < Date.now();
  const status: TaskStatus = t.status === 'completed' ? 'done' : overdue ? 'overdue' : 'pending';
  const note = (t.body?.content ?? '').replace(/<[^>]+>/g, '').trim() || null;
  return {
    id: `m365-${slugId(t.id ?? label)}`,
    label,
    section: `Microsoft 365 · ${listName}`,
    role: null,
    type: 'M365 To-Do',
    dueDay: due ? due.slice(0, 10) : null,
    notes: note ? note.slice(0, 200) : null,
    status,
    monthlyPmt: null,
  };
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`Graph ${res.status}`);
  return (await res.json()) as T;
}

/** Open M365 To-Do tasks across the user's lists, mapped to Task[]. Empty without GRAPH_TOKEN. */
export async function loadM365Tasks(): Promise<Task[]> {
  const token = await getGraphToken();
  if (!token) return [];
  try {
    const base = userBase();
    const lists = await graphGet<{ value?: Array<{ id?: string; displayName?: string }> }>(`${base}/todo/lists?$top=10`, token);
    const out: Task[] = [];
    for (const list of (lists.value ?? []).slice(0, 10)) {
      if (!list.id) continue;
      const tasks = await graphGet<{ value?: GraphTask[] }>(
        `${base}/todo/lists/${list.id}/tasks?$top=50&$filter=${encodeURIComponent("status ne 'completed'")}`,
        token,
      );
      for (const t of tasks.value ?? []) {
        const mapped = mapGraphTask(t, list.displayName ?? 'To Do');
        if (mapped) out.push(mapped);
        if (out.length >= 100) return out;
      }
    }
    return out;
  } catch (e) {
    console.warn(`[m365-tasks] live fetch failed, skipping: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
