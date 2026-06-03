import type { PortfolioSnapshot } from '../../src/contracts/index';
import { TOOL_DEFS, runTool, type EntityRefLite } from './tools';
import { respond } from './respond';

/**
 * Runtime-agnostic, streaming, tool-using agent over the company spine. One implementation
 * runs in Node 24 (Brain Server) and in the Cloudflare Pages Function — it uses only raw
 * `fetch` + the Web Streams API, no SDK and no Node-only APIs.
 *
 * - Tools (server/ai/tools.ts) query the spine; results are small + carry citation refs.
 * - The model cites entities inline as `[[type:id|label]]`; the UI renders clickable chips.
 * - Prompt caching on the system/tools prefix; adaptive thinking + configurable effort.
 * - Bounded tool loop. When no API key is configured, falls back to the deterministic responder.
 */

export type AgentEvent =
  | { type: 'tool'; name: string; label: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; model: string; refs: EntityRefLite[] }
  | { type: 'error'; message: string };

export interface AgentOptions {
  question: string;
  snapshot: PortfolioSnapshot;
  /** Prior turns for follow-ups: [{role:'user'|'assistant', text}]. */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  apiKey?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  emit: (e: AgentEvent) => void | Promise<void>;
  signal?: AbortSignal;
  maxTurns?: number;
}

const TOOL_LABELS: Record<string, string> = {
  get_portfolio_summary: 'reading portfolio summary',
  get_property: 'looking up properties',
  get_leases: 'querying the rent roll',
  get_loans: 'reading the loan index',
  get_cash_position: 'checking cash balances',
  get_deals: 'reviewing the pipeline',
  get_relationships: 'looking up relationships',
  get_alerts: 'scanning alerts',
  search_entities: 'searching entities',
  run_scenario: 'running scenario',
  search_documents: 'searching documents',
};

const SYSTEM = [
  'You are the analyst inside the Oxford Command Center, an internal real-estate decision tool for a family office.',
  'Answer using the TOOLS to query the company spine — never guess figures. Call tools as needed, then synthesize.',
  'Be concise and numbers-first; use $ and %. Match an institutional, direct tone — no preamble, no hedging.',
  'CITATIONS: when you reference a specific entity returned by a tool, cite it inline using the exact token',
  '[[type:id|label]] — e.g. [[loan:lender-restoration-church-trust|Restoration Church Trust]] — using the id from',
  "the tool result's refs. The UI turns these into clickable links, so cite the real entities behind your numbers.",
  "If the tools do not contain the answer, say: \"I don't know — that is not in the current snapshot.\" Never invent firm data.",
].join(' ');

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
  _json?: string; // partial tool input buffer
}

async function callAnthropicStream(
  body: unknown,
  apiKey: string,
  signal: AbortSignal | undefined,
  onText: (t: string) => void | Promise<void>,
  onToolFinal: (name: string) => void | Promise<void>,
): Promise<{ blocks: Block[]; stopReason: string | null }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
  }

  const blocks: Block[] = [];
  let stopReason: string | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const handle = async (data: { type?: string; index?: number; delta?: Record<string, unknown>; content_block?: Record<string, unknown> }) => {
    switch (data.type) {
      case 'content_block_start': {
        const cb = data.content_block ?? {};
        blocks[data.index!] = { type: String(cb.type), text: '', thinking: '', signature: '', id: cb.id as string, name: cb.name as string, _json: '', data: cb.data as string };
        break;
      }
      case 'content_block_delta': {
        const b = blocks[data.index!];
        if (!b) break;
        const d = data.delta ?? {};
        if (d.type === 'text_delta') { b.text = (b.text ?? '') + String(d.text); await onText(String(d.text)); }
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + String(d.thinking);
        else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + String(d.signature);
        else if (d.type === 'input_json_delta') b._json = (b._json ?? '') + String(d.partial_json);
        break;
      }
      case 'content_block_stop': {
        const b = blocks[data.index!];
        if (b && b.type === 'tool_use') {
          try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; }
          await onToolFinal(b.name ?? '');
        }
        break;
      }
      case 'message_delta':
        if (data.delta && typeof data.delta.stop_reason === 'string') stopReason = data.delta.stop_reason;
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { await handle(JSON.parse(payload)); } catch { /* ignore malformed frame */ }
    }
  }
  return { blocks, stopReason };
}

/** Strip our internal buffer fields before echoing assistant content back to the API. */
function cleanBlocks(blocks: Block[]): unknown[] {
  return blocks
    .filter((b) => b && b.type)
    .map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
      if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' };
      if (b.type === 'redacted_thinking') return { type: 'redacted_thinking', data: b.data ?? '' };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} };
      return { type: b.type };
    })
    .filter((b) => !(b.type === 'text' && !(b as { text?: string }).text)); // drop empty text blocks
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  const { question, snapshot, emit, signal } = opts;
  const model = opts.model || 'claude-opus-4-8';
  const effort = opts.effort || 'medium';
  const maxTurns = opts.maxTurns ?? 8;
  const allRefs: EntityRefLite[] = [];

  // No key → deterministic responder (still grounded), streamed as one chunk.
  if (!opts.apiKey) {
    const r = respond(question, snapshot);
    await emit({ type: 'text', delta: r.answer });
    await emit({ type: 'done', model: 'stub', refs: [] });
    return;
  }

  const history = opts.history ?? [];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user' as const, content: question },
  ];

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const body = {
        model,
        max_tokens: 4096,
        system: [
          { type: 'text', text: SYSTEM },
          { type: 'text', text: `Snapshot as-of ${snapshot.meta.asOf}, scenario ${snapshot.meta.scenario}.`, cache_control: { type: 'ephemeral' } },
        ],
        tools: TOOL_DEFS,
        thinking: { type: 'adaptive' },
        output_config: { effort },
        messages,
      };

      const { blocks, stopReason } = await callAnthropicStream(
        body,
        opts.apiKey,
        signal,
        (t) => emit({ type: 'text', delta: t }),
        (name) => emit({ type: 'tool', name, label: TOOL_LABELS[name] ?? name }),
      );

      messages.push({ role: 'assistant', content: cleanBlocks(blocks) });

      if (stopReason !== 'tool_use') break;

      // Execute every tool_use block; feed results back.
      const toolResults: unknown[] = [];
      for (const b of blocks) {
        if (b && b.type === 'tool_use') {
          const result = runTool(b.name ?? '', snapshot, (b.input as Record<string, unknown>) ?? {});
          allRefs.push(...result.refs);
          toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result.data) });
        }
      }
      if (toolResults.length === 0) break;
      messages.push({ role: 'user', content: toolResults });
    }

    await emit({ type: 'done', model, refs: allRefs });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return;
    await emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}
