import type { Deal } from '../../src/contracts/index';
import { CompSet, RECORD_COMPS_TOOL } from '../../src/contracts/index';
import { egressRosterScanner } from '../briefing/roster-match';

export type FetchCompsResult = { ok: true; comps: CompSet } | { ok: false; error: string };

export interface FetchCompsOptions {
  apiKey?: string;
  model?: string;
  now: string; // ISO — injected for deterministic sourcedAt
  /** Roster scan over the outbound prompt; injectable for tests. Defaults to the egressRosterScanner bound for the deal check
   *  (throws on an unreadable OR placeholder roster). */
  confidentialScan?: (value: unknown) => { dealLabel: string } | null;
  fetchImpl?: typeof fetch;
}

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}

/**
 * Research market comps for a deal via Anthropic's native web_search server tool, then read the
 * model's structured record_comps call. Single non-streaming request: Anthropic runs the searches
 * inside the request and the model ends by calling record_comps (a client tool we don't execute —
 * we just read its input). Degrades to { ok:false, error } on missing key / HTTP error / no comps.
 */
export async function fetchDealComps(deal: Deal, opts: FetchCompsOptions): Promise<FetchCompsResult> {
  // Confidentiality egress guard (audit rank-8): a confidential deal's name/location/price must
  // never reach an external web search. Block before any network call, regardless of API-key state.
  if (deal.confidential) {
    return { ok: false, error: 'Market comps are disabled for confidential deals — running them would send the deal identity to external web search.' };
  }
  if (!opts.apiKey) return { ok: false, error: 'Market comps need AI access — ANTHROPIC_API_KEY is not configured.' };
  const f = opts.fetchImpl ?? fetch;
  const where = [deal.location, deal.market].filter(Boolean).join(', ') || deal.name;

  const prompt =
    `Research current market comparables for this small-bay / flex INDUSTRIAL acquisition, then call ` +
    `record_comps exactly once with your findings.\n\n` +
    `Property: ${deal.name}\nLocation: ${where}\n` +
    `${deal.sf ? `Size: ~${deal.sf.toLocaleString()} SF\n` : ''}` +
    `${deal.estPrice ? `Asking / est. price: $${deal.estPrice.toLocaleString()}\n` : ''}` +
    `\nFind, using web search across CoStar, LoopNet, CREXI, broker market reports, and local sources:\n` +
    `1. SALE comps — comparable industrial sales nearby (address, price, $/SF, cap rate, date).\n` +
    `2. RENT comps — asking/closed NNN $/SF for comparable space (address, $/SF, SF, date).\n` +
    `3. SUBMARKET stats — vacancy, asking-rent trend, net absorption, new supply.\n` +
    `Prefer the last 18 months and the same submarket. Include a source URL/publication for every item. ` +
    `If solid data is thin, record what you can and note the gaps in summary. End by calling record_comps.`;

  // Roster guard on the EXACT outbound text (Hard Invariant 3). The deal.confidential flag above is
  // only a flag; the roster is the source of record, so scan the prompt itself and fail closed.
  // egressRosterScanner (the publication-decision scanner) throws on an unreadable roster AND on the CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER
  // stand-in: sending a deal identity to external web search is an egress decision, not a local
  // render, so the reduced-coverage opt-out must not clear it.
  try {
    // Whole-record, placeholder-aware check FIRST (a prompt-only scan misses roster terms held in
    // owner/lender/nextAction anchors, raw numeric terms, and fails OPEN on the placeholder roster),
    // then the exact outbound text.
    // One roster read for the record AND the prompt (#478): egressRosterScanner throws on an
    // unreadable, empty or placeholder roster, which the catch below refuses.
    const scan = egressRosterScanner();
    const hit = scan(deal) ? { dealLabel: 'roster' } : (opts.confidentialScan ?? scan)(prompt);
    if (hit) {
      return { ok: false, error: 'Market comps blocked — the request matches an active confidential deal on the roster.' };
    }
  } catch (e) {
    console.error('[comps] confidential roster unavailable — refusing external web search:', e);
    return { ok: false, error: 'Market comps blocked — the confidential roster could not be verified.' };
  }

  const body = {
    model: opts.model || 'claude-opus-5',
    max_tokens: 4096,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }, RECORD_COMPS_TOOL],
    messages: [{ role: 'user', content: prompt }],
  };

  let res: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  try {
    res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('[comps] network error reaching Anthropic:', e);
    return { ok: false, error: 'Network error reaching the AI service.' };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[comps] Anthropic ${res.status}:`, detail.slice(0, 200));
    return { ok: false, error: `AI service error (${res.status}).` };
  }

  const json = (await res.json()) as { content?: AnthropicContentBlock[] };
  const block = (json.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'record_comps');
  if (!block || block.input === undefined) return { ok: false, error: 'The model returned no comps for this deal.' };

  const parsed = CompSet.safeParse({ ...(block.input as Record<string, unknown>), sourcedAt: opts.now });
  if (!parsed.success) return { ok: false, error: 'Comp data failed validation.' };
  return { ok: true, comps: parsed.data };
}
