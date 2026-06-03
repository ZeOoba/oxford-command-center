/**
 * Cloudflare Pages Function — the deployed mirror's AI endpoint.
 *
 * Streams the SAME tool-using agent the Brain Server runs (server/ai/agent.ts), so the mirror
 * and local app behave identically. The agent reads the BAKED snapshot via the ASSETS binding,
 * calls Anthropic server-side with a Cloudflare SECRET (`wrangler pages secret put
 * ANTHROPIC_API_KEY`), and emits SSE frames: `tool` / `text` / `done` / `error`.
 *
 * Inherits Cloudflare Access (same hostname). With no key, the agent falls back to the
 * deterministic responder and streams that — never a silent canned stub.
 */
import { PortfolioSnapshot } from '../../src/contracts/index';
import { runAgent, type AgentEvent } from '../../server/ai/agent';

interface Env {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_EFFORT?: string;
  ASSETS: { fetch: (input: Request | string) => Promise<Response> };
}
interface PagesContext {
  request: Request;
  env: Env;
}

const sseHeaders = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
};

function frame(e: AgentEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const body = (await request.json().catch(() => ({}))) as {
    question?: unknown;
    history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  };
  const question = String(body.question ?? '').trim();
  const history = Array.isArray(body.history) ? body.history : [];

  // Read + validate the baked snapshot (internal ASSETS binding — no Access round-trip).
  let snapshot: PortfolioSnapshot | null = null;
  try {
    const res = await env.ASSETS.fetch(new URL('/snapshot.json', request.url).toString());
    if (res.ok) snapshot = PortfolioSnapshot.parse(await res.json());
  } catch {
    /* fall through */
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(frame(e)));
      if (!snapshot) {
        emit({ type: 'error', message: 'The portfolio snapshot is unavailable on the mirror right now.' });
        controller.close();
        return;
      }
      await runAgent({
        question,
        history,
        snapshot,
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
        effort: env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high' | 'max' | undefined,
        emit,
      });
      controller.close();
    },
  });

  return new Response(stream, { headers: sseHeaders });
}
