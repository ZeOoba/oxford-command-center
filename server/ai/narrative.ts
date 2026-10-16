// server/ai/narrative.ts
//
// Phase 2 · Workstream 2 — AI Narrative Briefings (Step 8).
// Spec: docs/superpowers/specs/2026-06-21-phase-2-w2-ai-narrative-briefings.md
//
// Phase 3 · Workstream 3 — AI Narrative Leasing Briefing.
// Spec: docs/superpowers/specs/2026-06-20-phase-3-forecast-leasing-intelligence.md
//
// Composes structured AI narrative blocks for BriefingModel and LeaseNarrativeInput.
// NEVER throws — always returns { narrative, degraded } in all failure paths.
import { NarrativeBlock } from '../../src/contracts/briefing';
import type { BriefingModel } from '../../src/contracts/briefing';
import { assertNoEgressRosterMatch, rosterMatch } from '../briefing/roster-match';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM =
  `You are an institutional real estate investment analyst at Oxford Realty Advisors.\n` +
  `Your task is to write a concise, professional narrative briefing for the provided property or manager report data.\n` +
  `RULES:\n` +
  `- Restate ONLY figures that appear in the supplied JSON data. Invent NO numbers.\n` +
  `- Use an institutional register: structured, direct, no hedging, no filler.\n` +
  `- Output STRICT JSON only — no markdown, no code fences, no explanation.\n` +
  `- Required output format: {"headline":string,"summary":string,"bullets":string[]}\n` +
  `- "headline": a concise title (10 words or fewer).\n` +
  `- "summary": 1-2 sentence overview referencing the supplied data.\n` +
  `- "bullets": 2-5 key findings or action items drawn from the data.`;

/** Build a compact subset of the model for the AI prompt — display strings only, no numeric recompute. */
function buildSubset(model: BriefingModel): unknown {
  if (model.kind === 'property') {
    return {
      kind: 'property',
      subject: {
        name: model.subject.name,
        market: model.subject.market,
        manager: model.subject.manager,
        scoredPeriod: model.subject.scoredPeriod,
      },
      verdict: {
        health: model.verdict.health.display,
        healthBand: model.verdict.healthBand,
        attentionBand: model.verdict.attentionBand,
        capitalAction: model.verdict.capitalAction,
        rootCause: model.verdict.rootCause,
        recommendation: model.verdict.recommendation,
      },
      kpis: model.kpis.map((k) => ({
        label: k.label,
        display: k.figure.display,
      })),
      drivers: model.drivers.map((d) => ({
        category: d.category,
        delta: d.delta.display,
        contributionPct: d.contributionPct.display,
      })),
      anomalies: model.anomalies.map((a) => ({
        severity: a.severity,
        kind: a.kind,
        detail: a.detail,
      })),
      leaseRun: model.leaseRun.present
        ? {
            tenant: model.leaseRun.tenant,
            currentExpiry: model.leaseRun.currentExpiry,
            stabilizedNoi: model.leaseRun.stabilizedNoi.display,
            indicativeValue: model.leaseRun.indicativeValue.display,
            belowMarket: model.leaseRun.belowMarket,
          }
        : { present: false },
      benchmark: {
        noiPerSfQuartile: model.benchmark.noiPerSfQuartile,
        cohortSize: model.benchmark.cohortSize,
        noiPerSf: model.benchmark.noiPerSf.display,
        cohortMedianNoiPerSf: model.benchmark.cohortMedianNoiPerSf.display,
      },
    };
  }

  // manager
  return {
    kind: 'manager',
    subject: {
      name: model.subject.name,
      propertyCount: model.subject.propertyCount,
      smallSample: model.subject.smallSample,
    },
    scorecard: {
      avgNoiPerSf: model.scorecard.avgNoiPerSf.display,
      avgNoiGrowth: model.scorecard.avgNoiGrowth.display,
      avgExpenseGrowth: model.scorecard.avgExpenseGrowth.display,
    },
    managedProperties: model.managedProperties.map((p) => ({
      name: p.name,
      healthBand: p.healthBand,
      noi: p.noi.display,
      attentionBand: p.attentionBand,
    })),
    attentionItems: model.attentionItems,
    actionList: model.actionList,
  };
}

export async function composeNarrative(
  model: BriefingModel,
  opts: { apiKey?: string; model?: string; fetchImpl?: typeof fetch },
): Promise<{ narrative: NarrativeBlock | null; degraded: boolean }> {
  const DEGRADED = { narrative: null, degraded: true } as const;

  try {
    // Guard: no apiKey → degrade immediately, do NOT call fetch
    if (!opts.apiKey) {
      return DEGRADED;
    }

    const subset = buildSubset(model);

    // Pre-send confidentiality guard — must fire BEFORE any HTTP call. Scan the FULL model, not
    // just the subset: the model's text is a superset of the subset's, so this also catches a term
    // in a field the subset never forwards. Defense-in-depth — does not rely on the caller having
    // already run compose's assertNoRosterMatch (compose.ts) on the model.
    try {
      assertNoEgressRosterMatch(model); // refuses the placeholder too (U3); a throw degrades
    } catch {
      return DEGRADED;
    }

    const modelId = opts.model ?? DEFAULT_MODEL;
    const userPrompt =
      `Generate a briefing narrative for the following Oxford Realty Advisors report data:\n\n` +
      JSON.stringify(subset, null, 2);

    const f = opts.fetchImpl ?? fetch;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 15_000);

    let res: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1024,
          temperature: 0,
          system: SYSTEM,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
    } catch {
      // AbortError, network error, etc.
      return DEGRADED;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      return DEGRADED;
    }

    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = (json.content ?? []).find((b) => b.type === 'text');
    if (!textBlock?.text) {
      return DEGRADED;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return DEGRADED;
    }

    // Validate shape with NarrativeBlock schema
    const blockResult = NarrativeBlock.safeParse({
      ...(parsed as object),
      model: modelId,
    });
    if (!blockResult.success) {
      return DEGRADED;
    }

    const block = blockResult.data;

    // Post-receive confidentiality scan — discard if a term leaked into the AI output
    const combined = [block.headline, block.summary, ...block.bullets].join(' ');
    const hit = rosterMatch(combined);
    if (hit) {
      return DEGRADED;
    }

    return { narrative: block, degraded: false };
  } catch {
    // Outer catch — never throws
    return DEGRADED;
  }
}

// ── composeLeaseNarrative — Phase 3 W3 ──────────────────────────────────────
//
// Trimmed subset of leasing forecast data sent to the AI. Internal-only — not exported.
// Contains only derived/display values from Spine A + renewal signals; no deal terms.
type LeaseNarrativeInput = {
  asOf: string;
  propertyCount: number;
  signalSummary: {
    likelyCt: number;
    uncertainCt: number;
    atRiskCt: number;
    lapsingCt: number;
    nearTermExpiryRent: number; // sum of contract annual rent (monthlyRent x 12) for 0-6m bucket
  };
  topGaps: Array<{ propertyKey: string; gapPsf: number; underMarket: boolean }>;
  slowLeasingProperties: string[]; // propertyName where slowLeasing=true
};

const LEASE_SYSTEM =
  `You are an institutional real estate investment analyst at Oxford Realty Advisors.\n` +
  `Write a concise, professional leasing intelligence briefing from the provided portfolio data.\n` +
  `RULES:\n` +
  `- Restate ONLY figures that appear in the supplied JSON. Invent NO numbers.\n` +
  `- Use an institutional register: structured, direct, no hedging, no filler.\n` +
  `- Output STRICT JSON only — no markdown, no code fences, no explanation.\n` +
  `- Required format: {"headline":string,"summary":string,"bullets":string[]}\n` +
  `- "headline": ≤10 words. "summary": 1-2 sentences. "bullets": 2-5 key leasing findings or actions.\n` +
  `- Focus on renewal risk, near-term expiry concentration, and below-market rents.`;

/**
 * Composes a structured AI narrative block for the leasing intelligence dashboard.
 * NEVER throws — always returns { narrative, degraded } in all failure paths.
 *
 * @param data - Trimmed leasing data subset (Spine A signals + market gaps)
 * @param opts - apiKey, model override, fetchImpl for testing
 */
export async function composeLeaseNarrative(
  data: LeaseNarrativeInput,
  opts: { apiKey?: string; model?: string; fetchImpl?: typeof fetch },
): Promise<{ narrative: NarrativeBlock | null; degraded: boolean }> {
  const DEGRADED = { narrative: null, degraded: true } as const;

  try {
    // Guard: no apiKey → degrade immediately, do NOT call fetch
    if (!opts.apiKey) {
      return DEGRADED;
    }

    // Pre-send confidentiality guard — scan the full input object before any HTTP call.
    try {
      assertNoEgressRosterMatch(data); // refuses the placeholder too (U3); a throw degrades
    } catch {
      return DEGRADED;
    }

    const modelId = opts.model ?? DEFAULT_MODEL;
    const userPrompt =
      `Generate a leasing intelligence briefing for the following Oxford Realty Advisors portfolio data:\n\n` +
      JSON.stringify(data, null, 2);

    const f = opts.fetchImpl ?? fetch;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 15_000);

    let res: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1024,
          temperature: 0,
          system: LEASE_SYSTEM,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
    } catch {
      // AbortError, network error, etc.
      clearTimeout(timeout);
      return DEGRADED;
    }
    // NOTE: do NOT clear the timeout here — keep it active through the body read so that a
    // fast-headers / slow-body server cannot hang res.json() indefinitely (Defect D5).

    if (!res.ok) {
      clearTimeout(timeout);
      return DEGRADED;
    }

    let json: { content?: Array<{ type: string; text?: string }> };
    try {
      json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    } catch {
      return DEGRADED;
    } finally {
      // Clear here — covers both successful body read and body-read failure.
      clearTimeout(timeout);
    }
    const textBlock = (json.content ?? []).find((b) => b.type === 'text');
    if (!textBlock?.text) {
      return DEGRADED;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return DEGRADED;
    }

    // Validate shape with NarrativeBlock schema
    const blockResult = NarrativeBlock.safeParse({
      ...(parsed as object),
      model: modelId,
    });
    if (!blockResult.success) {
      return DEGRADED;
    }

    const block = blockResult.data;

    // Post-receive confidentiality scan — discard if a term leaked into the AI output
    const combined = [block.headline, block.summary, ...block.bullets].join(' ');
    const hit = rosterMatch(combined);
    if (hit) {
      return DEGRADED;
    }

    return { narrative: block, degraded: false };
  } catch {
    // Outer catch — never throws
    return DEGRADED;
  }
}
