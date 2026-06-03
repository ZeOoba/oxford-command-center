/**
 * Cloudflare Pages Function — the deployed mirror's AI endpoint.
 *
 * The static mirror has no Brain Server, so `/api/ai` had no handler (Defect 1: the Ask
 * panel 302'd/404'd). This function answers server-side:
 *   • calls Anthropic with a Cloudflare SECRET (`wrangler pages secret put ANTHROPIC_API_KEY`)
 *     — the key never reaches the browser bundle;
 *   • grounds the answer in the BAKED snapshot, read via the ASSETS binding (no Access round-trip);
 *   • matches the existing askBrain() contract exactly: POST { question } -> { answer, sources, model }.
 *
 * It inherits Cloudflare Access (same hostname). With no key configured it says so plainly —
 * never a silent canned stub. The full tool-using agent replaces this in Phase 3.
 */

interface Env {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  ASSETS: { fetch: (input: Request | string) => Promise<Response> };
}

interface PagesContext {
  request: Request;
  env: Env;
}

interface AiResponse {
  answer: string;
  sources: string[];
  model: 'stub' | 'claude';
}

const json = (data: AiResponse, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// ── compact, bounded grounding context from the baked snapshot ────────────────
interface SnapLike {
  meta?: { asOf?: string; scenario?: string };
  properties?: Array<Record<string, unknown>>;
  loans?: Array<Record<string, unknown>>;
  leases?: Array<Record<string, unknown>>;
  cash?: { totalCash?: number; largestEntity?: string | null; concentrationTopPct?: number | null };
  insurance?: Array<Record<string, unknown>>;
  deals?: Array<Record<string, unknown>>;
  counterparties?: Array<Record<string, unknown>>;
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}

/** Trim the snapshot to the fields an analyst needs, keeping the prompt bounded. */
function summarize(s: SnapLike): string {
  const digest = {
    asOf: s.meta?.asOf ?? null,
    scenario: s.meta?.scenario ?? 'Base',
    properties: (s.properties ?? []).map((p) =>
      pick(p, ['name', 'market', 'type', 'sf', 'occPct', 'noi', 'oxfordValue', 'capRate', 'dscr', 'ltv', 'lender']),
    ),
    loans: (s.loans ?? []).map((l) =>
      pick(l, ['name', 'counterparty', 'direction', 'absBalance', 'rate', 'maturity', 'monthsToMaturity', 'balloon', 'status', 'ltv']),
    ),
    leasesSummary: {
      count: (s.leases ?? []).length,
      totalAnnualRent: (s.leases ?? []).reduce((a, l) => a + (typeof l.annualRent === 'number' ? l.annualRent : 0), 0),
    },
    cash: s.cash ? pick(s.cash as Record<string, unknown>, ['totalCash', 'largestEntity', 'concentrationTopPct']) : null,
    insurance: (s.insurance ?? []).map((i) => pick(i, ['property', 'carrier', 'coverage', 'status', 'expires', 'premium'])),
    deals: (s.deals ?? []).map((d) => pick(d, ['name', 'stage', 'market', 'estPrice', 'capRate', 'irr'])),
    counterparties: (s.counterparties ?? []).map((c) => pick(c, ['name', 'kind', 'firm', 'email', 'market'])),
  };
  return JSON.stringify(digest);
}

const SYSTEM = [
  'You are the analyst inside the Oxford Command Center, an internal real-estate decision tool.',
  'Answer ONLY from the JSON portfolio snapshot provided. It is the single source of truth.',
  'Be concise and numbers-first. Use $ and %. When you state a figure, name the part of the data it came from',
  '(e.g. "Loan Index", "Property NOI", "Cash Balances", a property or counterparty name).',
  'If the snapshot does not contain the answer, say "I don\'t know — that is not in the current snapshot."',
  'Never invent firm data. Wrong numbers are worse than missing numbers.',
].join(' ');

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env } = context;

  const body = (await request.json().catch(() => ({}))) as { question?: unknown };
  const question = String(body.question ?? '').trim();
  if (!question) {
    return json({ answer: 'Ask me about the portfolio — risk, leases, debt, cash, tenants, or a summary.', sources: [], model: 'stub' });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({
      answer: 'AI offline — no API key is configured on the mirror. Set it with `wrangler pages secret put ANTHROPIC_API_KEY`.',
      sources: [],
      model: 'stub',
    });
  }

  // Read the baked snapshot from deployed static assets (internal binding, no Access hop).
  let snapshot: SnapLike | null = null;
  try {
    const res = await env.ASSETS.fetch(new URL('/snapshot.json', request.url).toString());
    if (res.ok) snapshot = (await res.json()) as SnapLike;
  } catch {
    /* fall through to the no-data message */
  }
  if (!snapshot) {
    return json({ answer: 'The portfolio snapshot is unavailable on the mirror right now.', sources: [], model: 'stub' });
  }

  const model = env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        // Prompt caching on the system + snapshot blocks: repeat questions are cheap.
        system: [
          { type: 'text', text: SYSTEM },
          { type: 'text', text: `PORTFOLIO SNAPSHOT (JSON):\n${summarize(snapshot)}`, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: question }],
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return json({ answer: `AI request failed (${r.status}). ${detail.slice(0, 200)}`, sources: [], model: 'stub' });
    }

    const data = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
    const answer = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();

    return json({
      answer: answer || 'No answer was produced.',
      sources: ['Master Workbook — baked snapshot'],
      model: 'claude',
    });
  } catch {
    return json({ answer: 'Could not reach the AI service from the mirror.', sources: [], model: 'stub' });
  }
}
