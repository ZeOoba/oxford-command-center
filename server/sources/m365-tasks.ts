import type { Task, TaskStatus } from '../../src/contracts/index';

/**
 * Microsoft 365 To-Do → Tasks (Phase 6). Pulls open To-Do tasks via Microsoft Graph and prepends
 * them to the workbook checklist so they surface in the Tasks module.
 *
 * Behind the contract + graceful: with no GRAPH_TOKEN (or any error) it returns [] and the workbook
 * tasks are untouched. Server-only.
 *
 * AUTH NOTE: GRAPH_TOKEN is a Microsoft Graph bearer token. Delegated tokens are short-lived (~1h),
 * so for unattended use wire an app-registration client-credentials flow with refresh and set
 * GRAPH_TOKEN from it. Until configured, this stays inert (workbook tasks only).
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';

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
  const token = process.env.GRAPH_TOKEN;
  if (!token) return [];
  try {
    const lists = await graphGet<{ value?: Array<{ id?: string; displayName?: string }> }>('/me/todo/lists?$top=10', token);
    const out: Task[] = [];
    for (const list of (lists.value ?? []).slice(0, 10)) {
      if (!list.id) continue;
      const tasks = await graphGet<{ value?: GraphTask[] }>(
        `/me/todo/lists/${list.id}/tasks?$top=50&$filter=${encodeURIComponent("status ne 'completed'")}`,
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
