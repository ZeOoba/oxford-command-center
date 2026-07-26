import type { MacroSnapshot, PortfolioSnapshot } from '../../src/contracts/index';
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
  /** Server-only document search (RAG). Absent on the mirror → search_documents stays a stub. */
  docSearch?: (query: string, limit?: number) => Promise<Array<{ doc: string; snippet: string }>>;
  /** Live macro provider (FRED w/ key, seeded fallback otherwise). Absent on the mirror → get_macro
   *  stays a stub. Mirrors the docSearch precedent — async; returns null only on a hard failure. */
  macroProvider?: () => Promise<MacroSnapshot | null>;
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
  get_macro: 'reading the rate environment',
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
  let apiError: string | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const handle = async (data: {
    type?: string;
    index?: number;
    delta?: Record<string, unknown>;
    content_block?: Record<string, unknown>;
    error?: { type?: string; message?: string };
  }) => {
    switch (data.type) {
      case 'error':
        apiError = data.error?.message ?? data.error?.type ?? 'Anthropic stream error';
        break;
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
  if (apiError) throw new Error(apiError);
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
  const model = opts.model || 'claude-opus-5';
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
        stream: true, // SSE — callAnthropicStream parses `data:` frames; without this the API
                      // returns a single JSON body and the stream parser emits nothing.
        // Generous ceiling: with adaptive thinking, thinking tokens count toward max_tokens —
        // too low and the model spends the whole budget thinking, ending with no visible answer.
        max_tokens: 16000,
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
          let result;
          if (b.name === 'search_documents' && opts.docSearch) {
            // RAG: real document search on the server (injected); the spine tools don't have it.
            const q = String((b.input as { query?: unknown } | undefined)?.query ?? '');
            const passages = await opts.docSearch(q, 5);
            result = { data: { count: passages.length, passages }, refs: [] as EntityRefLite[] };
          } else if (b.name === 'get_macro' && opts.macroProvider) {
            // Live macro: real FRED snapshot (or seeded fallback) on the server (injected); the
            // spine tools don't have it. Summarized to a SMALL, numbers-first payload (mirror tool
            // convention) — the model gets indicators + a 10Y trend snapshot, not the raw history
            // array. A hard failure (provider returns null) falls back to the stub message.
            const macro = await opts.macroProvider().catch(() => null);
            result = macro
              ? { data: summarizeMacro(macro), refs: [] as EntityRefLite[] }
              : runTool(b.name ?? '', snapshot, {});
          } else {
            result = runTool(b.name ?? '', snapshot, (b.input as Record<string, unknown>) ?? {});
          }
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

/** Compact macro payload for the agent. Exported for direct unit testing. Three correctness rules
 *  earned from the get_macro adversarial pass:
 *  (1) No orphan trend.current — the canonical current 10Y is `indicators.DGS10.value` at `asOf`.
 *      Emitting a parallel undated 10Y from the history's tail let the model pick either, with no
 *      tie-break, and Phase-2 refi-spread math went path-dependent.
 *  (2) The 10Y trend window is DATE-driven: sort by date, take the last 12. Live FRED returns 13
 *      monthly points at month boundaries; an array-position window mislabels low12mo/high12mo.
 *  (3) When source='mock' (seeded fallback because FRED_API_KEY is unset) attach an explicit
 *      `dataFreshness` instruction so the model surfaces the seeded caveat to the user — without
 *      it the institutional 'numbers-first / no-hedging' register quotes seeded rates as current. */
const TREND_WINDOW_MONTHS = 12;
export function summarizeMacro(m: MacroSnapshot): Record<string, unknown> {
  const ind: Record<string, unknown> = {};
  for (const i of m.indicators) {
    ind[i.id] = { label: i.label, value: i.value, unit: i.unit, change: i.change };
  }
  // Window by date — never by array position. Sort ascending, take the last N, then reduce.
  const sortedByDate = [...m.tenYearHistory].sort((a, b) => a.date.localeCompare(b.date));
  const window = sortedByDate.slice(-TREND_WINDOW_MONTHS);
  const values = window.map((h) => h.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const tenYearTrend: { windowMonths: number; n: number; endDate: string | null; low: number | null; high: number | null } = {
    windowMonths: TREND_WINDOW_MONTHS,
    n: window.length,
    endDate: window.length ? window[window.length - 1]!.date : null,
    low: values.length ? Math.min(...values) : null,
    high: values.length ? Math.max(...values) : null,
  };
  const payload: Record<string, unknown> = { asOf: m.asOf, source: m.source, indicators: ind, tenYearTrend };
  if (m.source === 'mock') {
    payload.dataFreshness =
      `SEEDED — FRED_API_KEY not configured; values are a static snapshot as of ${m.asOf}. ` +
      'Tell the user the live rate feed is offline before quoting any number.';
  }
  // Canonical-10Y guard. Trigger surface (broadened post-root-fix):
  //   - dgs10 missing entirely;
  //   - dgs10.value === null — the post-cure path: fred.ts emits null on a missing observation
  //     and MacroIndicator.value is z.number().finite().nullable() (no more `?? 0` lie);
  //   - !Number.isFinite(dgs10.value) — defense-in-depth against any direct (non-parsed) snapshot
  //     construction that bypasses the schema's `.finite()` boundary (e.g. unit tests, future
  //     non-FRED providers). The contract enforces this at parse time; the guard enforces it at
  //     consumption time. Same invariant, two layers.
  //   - dgs10.value <= 0 — kept as a belt-and-braces against any stale producer still emitting the
  //     legacy 0 sentinel, and because a real 10Y Treasury rate cannot be ≤ 0.
  // The new get_macro tool description tells the model to quote indicators.DGS10.value as the
  // canonical current 10Y — this guard ensures the model never sees a misleading number on a
  // partial FRED outage. dataQuality + a dated currentTenYFallback give it a usable alternative
  // with explicit instruction text to caveat.
  const dgs10 = m.indicators.find((i) => i.id === 'DGS10');
  const dgs10Suspicious =
    !dgs10 || dgs10.value === null || !Number.isFinite(dgs10.value) || dgs10.value <= 0;
  if (dgs10Suspicious) {
    const lastFinite = [...window].reverse().find((h) => typeof h.value === 'number' && Number.isFinite(h.value) && h.value > 0);
    payload.dataQuality =
      'DGS10 indicator missing/non-positive (likely a FRED partial outage on the 10Y series) — ' +
      'fell back to the trend window endpoint. Tell the user the 10Y reading is degraded before quoting.';
    if (lastFinite) {
      payload.currentTenYFallback = { value: lastFinite.value, date: lastFinite.date };
    }
  }
  return payload;
}
