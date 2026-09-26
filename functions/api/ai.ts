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
 *
 * Hardening (audit 2026-09-25):
 *  - the request body goes through the SAME sanitizeAgentInput as the Brain Server: forged or
 *    malformed history turns are dropped and every spend-bearing length is capped;
 *  - a per-identity sliding-window rate limit bounds Anthropic spend per Access user (best-effort:
 *    the window lives in this isolate's memory, so it resets on a cold start and is not shared
 *    across colos — a durable limit needs KV/Durable Objects; this closes the trivial-abuse case);
 *  - an edge confidentiality scan (OI-225 counterpart) derived from the baked snapshot's own
 *    `confidential:true` deals runs over every tool result, mirroring the roster-based guard the
 *    Brain Server injects. The mirror has no roster on disk, so the deal names the snapshot itself
 *    carries are the only terms available here — the tool-layer flag filter remains the first line.
 */
import { PortfolioSnapshot } from '../../src/contracts/index';
import { runAgent, sanitizeAgentInput, type AgentEvent } from '../../server/ai/agent';

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

/** Sliding-window limit per identity: RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS. */
export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const windows = new Map<string, number[]>();

function identity(request: Request): string {
  return (
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('cf-connecting-ip') ||
    'anonymous'
  );
}

/** Returns true when the request is within budget (and records it), false when it must be refused. */
export function admit(id: string, now = Date.now()): boolean {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const hits = (windows.get(id) ?? []).filter((t) => t > cutoff);
  if (hits.length >= RATE_LIMIT_MAX) {
    windows.set(id, hits);
    return false;
  }
  hits.push(now);
  windows.set(id, hits);
  // Keep the map bounded: drop identities whose window has fully expired.
  if (windows.size > 1_000) {
    for (const [k, v] of windows) if (!v.some((t) => t > cutoff)) windows.delete(k);
  }
  return true;
}

/** Test seam — clears the in-memory windows. */
export function resetRateLimit(): void {
  windows.clear();
}

function flatten(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(flatten).join(' ');
  return '';
}

/** Roster-free confidential scan built from the snapshot's own flagged deals (see header). */
export function edgeConfidentialScan(snapshot: PortfolioSnapshot): ((value: unknown) => { dealLabel: string } | null) | undefined {
  // Same identity set as scripts/bake-mirror.ts's residue sweep: the deal's name AND its shortName.
  const terms = snapshot.deals
    .filter((d) => d.confidential)
    .flatMap((d) => [d.name, d.shortName].map((t) => ({ label: d.name, needle: (t ?? '').trim().toLowerCase() })))
    .filter((t) => t.needle.length >= 3);
  if (terms.length === 0) return undefined;
  return (value: unknown) => {
    const low = flatten(value).toLowerCase();
    if (!low) return null;
    for (const t of terms) if (low.includes(t.needle)) return { dealLabel: t.label };
    return null;
  };
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const body: unknown = await request.json().catch(() => ({}));
  const input = sanitizeAgentInput(body);
  if (!input.ok) {
    return new Response(JSON.stringify({ error: input.error }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (!admit(identity(request))) {
    return new Response(JSON.stringify({ error: 'Too many requests — try again in a few minutes.' }), {
      status: 429,
      headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) },
    });
  }
  const { question, history } = input;

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
        confidentialScan: edgeConfidentialScan(snapshot),
        emit,
      });
      controller.close();
    },
  });

  return new Response(stream, { headers: sseHeaders });
}
