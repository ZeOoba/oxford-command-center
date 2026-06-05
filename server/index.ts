import { loadEnvFile } from './load-env';

// Load .env with override-on-empty BEFORE anything reads process.env (node's --env-file won't
// override an already-present empty var — see load-env.ts).
loadEnvFile();

import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { brain } from './brain';
import { DealStage, RenewalStageInput } from '../src/contracts/index';
import { DealCompsActionInput } from '../src/contracts/index';
import { fetchDealComps } from './ai/comps';
import { runAgent } from './ai/agent';
import { searchDocuments, docStatus } from './sources/documents';
import { getMacro } from './macro/getMacro';
import { SERVER_PORT } from './config';
import { loadInboxState, runAlertAction } from './alerts/store';
import { AlertActionInput } from '../src/contracts/alerts';

const app = new Hono();
// Confidential data — only same-machine localhost origins may call the API.
app.use(
  '/api/*',
  cors({ origin: (origin) => (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null) }),
);

app.get('/api/health', (c) => {
  const briefHealth = existsSync('data/brief-health.json')
    ? (JSON.parse(readFileSync('data/brief-health.json', 'utf8')) as {
        ranAt: string;
        briefSent: boolean;
        alertsSent: number;
        failures: string[];
      })
    : null;
  return c.json({
    ok: true,
    service: 'oxford-brain-server',
    state: brain.getState(),
    // Surface AI availability WITHOUT exposing the key (no silent fallbacks — System Health shows it).
    ai: { configured: !!process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8' },
    brief: briefHealth,
  });
});

/** The single typed payload: snapshot + live meta. */
app.get('/api/snapshot', (c) => {
  const snapshot = brain.getSnapshot();
  if (!snapshot) return c.json({ error: 'no snapshot available', state: brain.getState() }, 503);
  return c.json({ snapshot, state: brain.getState() });
});

app.post('/api/refresh', async (c) => {
  const state = await brain.refresh('api');
  return c.json({ state });
});

/**
 * Write-back actions (Phase 5) — persist to the local overlay; the workbook stays read-only.
 * Confirm-before-write happens in the UI. Available only on the live server (the mirror is read-only).
 */
app.post('/api/actions/deal-stage', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { dealId?: string; stage?: string };
  const stage = DealStage.safeParse(body.stage);
  if (!body.dealId || !stage.success) return c.json({ ok: false, error: 'Invalid dealId or stage' }, 400);
  const ok = brain.setDealStage(body.dealId, stage.data);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/task', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: string; section?: string; type?: string; dueDay?: string; notes?: string;
  };
  const label = String(body.label ?? '').trim();
  if (!label) return c.json({ ok: false, error: 'label required' }, 400);
  brain.addTask({
    id: `usr-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    label,
    section: String(body.section ?? 'Added in Command Center'),
    role: null,
    type: body.type ?? 'Manual',
    dueDay: body.dueDay ?? null,
    notes: body.notes ?? null,
    status: 'pending',
    monthlyPmt: null,
  });
  return c.json({ ok: true, state: brain.getState() });
});

app.get('/api/alerts/state', (c) => c.json(loadInboxState()));

app.post('/api/actions/alert', async (c) => {
  const parsed = AlertActionInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid alert action' }, 400);
  const state = runAlertAction(parsed.data);
  return c.json({ ok: true, state });
});

app.post('/api/actions/renewal-stage', async (c) => {
  const parsed = RenewalStageInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid leaseId or stage' }, 400);
  const ok = brain.setRenewalStage(parsed.data.leaseId, parsed.data.stage);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/tenant-note', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tenantId?: string; note?: string };
  const tenantId = String(body.tenantId ?? '').trim();
  if (!tenantId) return c.json({ ok: false, error: 'tenantId required' }, 400);
  const ok = brain.setTenantNote(tenantId, String(body.note ?? ''));
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/deal-comps', async (c) => {
  const parsed = DealCompsActionInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid dealId' }, 400);
  const snapshot = brain.getSnapshot();
  const deal = snapshot?.deals.find((d) => d.id === parsed.data.dealId);
  if (!deal) return c.json({ ok: false, error: 'Unknown deal' }, 404);
  const result = await fetchDealComps(deal, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL,
    now: new Date().toISOString(),
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
  brain.setDealComps(deal.id, result.comps);
  return c.json({ ok: true, comps: result.comps });
});

/** Macro indicators — live FRED when FRED_API_KEY is set, real-seeded snapshot otherwise. */
app.get('/api/macro', async (c) => c.json(await getMacro()));

/** Document RAG status — indexed lease/PSA/OM docs (server-only; empty until DOCUMENTS_DIR is set). */
app.get('/api/documents', async (c) => c.json(await docStatus()));

/**
 * AI assistant — a streaming, tool-using agent over the spine (server/ai/agent.ts).
 * Streams SSE frames: event `tool` (step), `text` (token delta), `done`, `error`.
 * Uses live Claude when ANTHROPIC_API_KEY is set; deterministic responder otherwise.
 */
app.post('/api/ai', (c) =>
  streamSSE(c, async (stream) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      question?: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
    };
    const question = String(body.question ?? '');
    const history = Array.isArray(body.history) ? body.history : [];
    const snapshot = brain.getSnapshot();
    if (!snapshot) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: 'Data is still loading — try again in a moment.' }) });
      return;
    }
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    await runAgent({
      question,
      history,
      snapshot,
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
      effort: process.env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high' | 'max' | undefined,
      signal: ac.signal,
      docSearch: searchDocuments,
      emit: async (e) => {
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      },
    });
  }),
);

/** Live push: clients subscribe and refetch the snapshot when the workbook changes. */
app.get('/sse', (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    stream.onAbort(() => {
      open = false;
    });

    await stream.writeSSE({ event: 'state', data: JSON.stringify(brain.getState()) });

    const onState = (state: unknown) => {
      void stream.writeSSE({ event: 'state', data: JSON.stringify(state) });
    };
    const onSnapshot = (info: unknown) => {
      void stream.writeSSE({ event: 'snapshot', data: JSON.stringify(info) });
    };
    brain.on('state', onState);
    brain.on('snapshot', onSnapshot);

    try {
      while (open) {
        await stream.writeSSE({ event: 'heartbeat', data: String(Date.now()) });
        await stream.sleep(15_000);
      }
    } finally {
      brain.off('state', onState);
      brain.off('snapshot', onSnapshot);
    }
  }),
);

async function main() {
  await brain.refresh('startup');
  brain.startWatching();
  serve({ fetch: app.fetch, port: SERVER_PORT, hostname: '127.0.0.1' }, (info) => {
    console.log(`◆ Oxford Brain Server — http://127.0.0.1:${info.port} (localhost only)`);
    console.log(`  Watching: ${brain.getState().workbookPath}`);
  });
}

void main();
