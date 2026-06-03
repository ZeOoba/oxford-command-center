import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { brain } from './brain';
import { respond } from './ai/respond';
import { answerWithClaude } from './ai/claude';
import { getMacro } from './macro/getMacro';
import { SERVER_PORT } from './config';

const app = new Hono();
// Confidential data — only same-machine localhost origins may call the API.
app.use(
  '/api/*',
  cors({ origin: (origin) => (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null) }),
);

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'oxford-brain-server', state: brain.getState() }),
);

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

/** Macro indicators — live FRED when FRED_API_KEY is set, real-seeded snapshot otherwise. */
app.get('/api/macro', async (c) => c.json(await getMacro()));

/** AI assistant — live Claude when ANTHROPIC_API_KEY is set, deterministic responder otherwise. */
app.post('/api/ai', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { question?: string };
  const question = String(body.question ?? '');
  const snapshot = brain.getSnapshot();
  if (!snapshot) return c.json({ answer: 'Data is still loading — try again in a moment.', sources: [], model: 'stub' });
  const live = await answerWithClaude(question, snapshot).catch(() => null);
  return c.json(live ?? respond(question, snapshot));
});

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
