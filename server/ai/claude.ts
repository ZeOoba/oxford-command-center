import Anthropic from '@anthropic-ai/sdk';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { AiAskResponse } from '../../src/brain/ai/types';
import { buildAnalytics } from '../../src/analytics/engine';

/** Lights up only when a key is present; otherwise the caller falls back to respond(). */
export function claudeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const SYSTEM_ROLE =
  'You are the Oxford Real Assets command-center analyst — Gabriel Goldberg\'s second brain for a ' +
  'private family-office industrial real estate portfolio. Answer ONLY from the portfolio data provided. ' +
  'Be concise, institutional, and numerate: lead with the number, cite the figure, never invent data. ' +
  'Use $/SF NNN, cap rate, DSCR, LTV, WALT conventions. If the data does not contain the answer, say so. ' +
  'When you state a figure, name its source sheet (Property NOI, Master Tenant Rent Roll, Loan Index, ' +
  'Cash Balances, Insurance Renewals). Flag anything estimated or derived.';

/**
 * Live Claude answer over the snapshot. The snapshot is placed in a cached system
 * block (prompt caching) so repeated questions reuse it cheaply. Returns null when
 * no API key is configured.
 *
 * NOTE: on @anthropic-ai/sdk upgrade, add (the pinned SDK doesn't type these yet):
 *   - `thinking: { type: 'adaptive' }` + `output_config: { effort: 'high' }` for deeper reasoning
 *   - `cache_control: { type: 'ephemeral' }` on the PORTFOLIO DATA block for prompt caching
 */
export async function answerWithClaude(
  question: string,
  snapshot: PortfolioSnapshot,
): Promise<AiAskResponse | null> {
  if (!claudeAvailable()) return null;

  const client = new Anthropic();
  const analytics = buildAnalytics(snapshot);
  const context = JSON.stringify({
    meta: snapshot.meta,
    assumptions: snapshot.assumptions,
    properties: snapshot.properties,
    leases: snapshot.leases,
    loans: snapshot.loans,
    cash: { ...snapshot.cash, history: snapshot.cash.history },
    insurance: snapshot.insurance,
    deals: snapshot.deals,
    counterparties: snapshot.counterparties,
    derived: { kpis: analytics.kpis, debt: analytics.debt, insights: analytics.insights, tenantHHI: analytics.tenantHHI },
  });

  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1500,
    system: [
      { type: 'text', text: SYSTEM_ROLE },
      {
        type: 'text',
        text: `PORTFOLIO DATA (as of ${snapshot.meta.asOf}):\n${context}`,
      },
    ],
    messages: [{ role: 'user', content: question || 'Give me a portfolio overview.' }],
  });

  const text = res.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n')
    .trim();

  return { answer: text || '(no answer returned)', sources: ['Claude · live workbook'], model: 'claude' };
}
