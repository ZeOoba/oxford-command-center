import type { PortfolioSnapshot, ScenarioName } from '../../src/contracts/index';
import {
  buildAnalytics,
  portfolioKpis,
  marketAllocation,
  revenueAtRisk,
  debtSummary,
  generateInsights,
} from '../../src/analytics/engine';
import { fmtUsdCompact, fmtPct } from '../../src/analytics/format';

/**
 * The agent's tools over the company spine. Each runs against the in-memory
 * PortfolioSnapshot (live on the server, baked on the mirror) and returns a SMALL,
 * structured result — never a whole-JSON dump. Results carry `refs` so the model can
 * cite specific entities as `[[type:id|label]]`, which the UI renders as clickable
 * chips that deep-link to the entity drawer.
 */

export interface EntityRefLite {
  type: 'property' | 'lease' | 'loan' | 'deal' | 'insurance' | 'cashEntity' | 'counterparty';
  id: string;
  label: string;
}
export interface ToolResult {
  data: unknown;
  refs: EntityRefLite[];
}
type Exec = (snapshot: PortfolioSnapshot, input: Record<string, unknown>) => ToolResult;

const asStr = (v: unknown): string => (v == null ? '' : String(v));
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const norm = (s: string): string => s.toLowerCase().trim();

// ── tool JSON-schema definitions (sent to Anthropic) ───────────────────────────
export const TOOL_DEFS = [
  {
    name: 'get_portfolio_summary',
    description:
      'Portfolio-level KPIs: total value, NOI, SF, occupancy, weighted cap rate, LTV, WALT, debt, cash, and value/NOI by market. Start here for "summary" / "overview" / "how is the portfolio" questions.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_property',
    description: 'Find one or more properties by name or market and return their full metrics (NOI, cap, DSCR, LTV, value, lender, occupancy).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Property name, address fragment, or market (e.g. "Easton", "Columbus OH").' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_leases',
    description: 'Query the rent roll. Filter by status, by leases expiring within N months, or by tenant/company. Returns the matching leases (capped).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['Active', 'Expiring Soon', 'Expired', 'Vacant', 'Unknown'] },
        expiring_within_months: { type: 'number', description: 'Only leases expiring within this many months (from the as-of date).' },
        company: { type: 'string', description: 'Tenant/company name fragment.' },
        limit: { type: 'number', description: 'Max rows (default 25).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_loans',
    description: 'Debt positions. Filter by direction (borrower = we pay, lender = we receive, internal) or balloon_only. Includes weighted avg rate and annual debt service.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['borrower', 'lender', 'internal'] },
        balloon_only: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_cash_position',
    description: 'Consolidated cash: total across entities, largest entity, concentration, and per-entity balances.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_deals',
    description: 'Acquisitions pipeline: each deal with stage, market, estimated price, cap rate, IRR, and next action.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_relationships',
    description: 'Counterparties (lenders, carriers, counsel, title, principals, brokers). Filter by kind or name.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['lender', 'carrier', 'counsel', 'title', 'broker', 'principal', 'partner'] },
        query: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_alerts',
    description: 'Active portfolio alerts/insights: balloons due, expiring/expired leases, lapsed insurance, cash concentration, low occupancy. Use for "what is at risk / needs attention".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_entities',
    description: 'Fuzzy search across properties, leases, loans, deals, insurance, and counterparties by name. Use when you are not sure which tool fits.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'run_scenario',
    description: 'Recompute portfolio KPIs (value, NOI, cap rate, LTV) under a scenario: Base, Upside, or Downside.',
    input_schema: { type: 'object', properties: { scenario: { type: 'string', enum: ['Base', 'Upside', 'Downside'] } }, required: ['scenario'], additionalProperties: false },
  },
  {
    name: 'search_documents',
    description: 'Search indexed lease/PSA/OM documents and return cited passages (e.g. "renewal option in the REDACTED-659 lease"). Available on the local server when documents are indexed; returns none on the read-only mirror.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]['name'];

// ── executors ──────────────────────────────────────────────────────────────────
const EXECUTORS: Record<ToolName, Exec> = {
  get_portfolio_summary: (s) => {
    const k = portfolioKpis(s, s.meta.scenario);
    return {
      data: {
        asOf: s.meta.asOf,
        scenario: s.meta.scenario,
        properties: k.propertyCount.value,
        tenants: k.tenantCount.value,
        totalSf: k.totalSf.value,
        value: fmtUsdCompact(k.value.value),
        noi: fmtUsdCompact(k.noi.value),
        weightedCapRate: fmtPct(k.weightedCapRate.value),
        occupancy: fmtPct(k.occupancy.value),
        ltv: fmtPct(k.ltv.value),
        totalDebt: fmtUsdCompact(k.totalDebt.value),
        totalCash: fmtUsdCompact(k.totalCash.value),
        waltYears: k.walt.value,
        valueByMarket: marketAllocation(s.properties, 'value').map((m) => ({ market: m.market, value: fmtUsdCompact(m.value), pct: fmtPct(m.pct) })),
        noiByMarket: marketAllocation(s.properties, 'noi').map((m) => ({ market: m.market, noi: fmtUsdCompact(m.value), pct: fmtPct(m.pct) })),
        note: 'Counts are investment assets (the "Sepich Portfolio" bundles 8 buildings as one row); SF is Oxford-share.',
      },
      refs: [],
    };
  },

  get_property: (s, input) => {
    const q = norm(asStr(input.query));
    const matches = s.properties.filter((p) => norm(p.name).includes(q) || norm(p.market).includes(q) || norm(p.type).includes(q)).slice(0, 8);
    return {
      data: matches.map((p) => ({
        name: p.name, market: p.market, type: p.type, sf: p.sf, occupancy: fmtPct(p.occPct),
        noi: fmtUsdCompact(p.noi), capRate: fmtPct(p.capRate), dscr: p.dscr, ltv: fmtPct(p.ltv),
        value: fmtUsdCompact(p.oxfordValue), lender: p.lender, tenants: p.tenantCount,
      })),
      refs: matches.map((p) => ({ type: 'property', id: p.id, label: p.name })),
    };
  },

  get_leases: (s, input) => {
    const status = input.status ? asStr(input.status) : null;
    const within = asNum(input.expiring_within_months);
    const company = input.company ? norm(asStr(input.company)) : null;
    const limit = asNum(input.limit) ?? 25;
    let rows = s.leases;
    if (status) rows = rows.filter((l) => l.status === status);
    if (within !== null) rows = rows.filter((l) => l.monthsToExpiry !== null && l.monthsToExpiry >= 0 && l.monthsToExpiry <= within);
    if (company) rows = rows.filter((l) => norm(l.company ?? l.tenantName).includes(company));
    rows = rows.slice(0, limit);
    return {
      data: {
        count: rows.length,
        leases: rows.map((l) => ({
          tenant: l.company ?? l.tenantName, property: l.propertyKey, unit: l.unit, sf: l.sf,
          annualRent: fmtUsdCompact(l.annualRent), status: l.status, leaseEnd: l.leaseEnd, monthsToExpiry: l.monthsToExpiry,
        })),
      },
      refs: rows.map((l) => ({ type: 'lease', id: l.id, label: l.company ?? l.tenantName })),
    };
  },

  get_loans: (s, input) => {
    const direction = input.direction ? asStr(input.direction) : null;
    const balloonOnly = input.balloon_only === true;
    let rows = s.loans;
    if (direction) rows = rows.filter((l) => l.direction === direction);
    if (balloonOnly) rows = rows.filter((l) => l.balloon);
    const d = debtSummary(s.loans);
    return {
      data: {
        externalDebt: fmtUsdCompact(d.externalDebt),
        weightedAvgRate: fmtPct(d.weightedAvgRate, 2),
        annualDebtService: fmtUsdCompact(d.annualDebtService),
        loans: rows.map((l) => ({
          name: l.name, direction: l.direction, counterparty: l.counterparty,
          balance: fmtUsdCompact(l.absBalance), rate: fmtPct(l.rate, 2), maturity: l.isDemand ? 'Demand' : l.maturity,
          monthsToMaturity: l.monthsToMaturity, balloon: l.balloon, status: l.status,
        })),
      },
      refs: rows.map((l) => ({ type: 'loan', id: l.id, label: l.name })),
    };
  },

  get_cash_position: (s) => ({
    data: {
      total: fmtUsdCompact(s.cash.totalCash),
      largestEntity: s.cash.largestEntity,
      concentrationTopPct: fmtPct(s.cash.concentrationTopPct),
      entities: s.cash.entities.map((e) => ({ entity: e.entity, balance: fmtUsdCompact(e.currentBalance), pctOfPortfolio: fmtPct(e.pctOfPortfolio), trend: e.trend })),
    },
    refs: s.cash.entities.map((e) => ({ type: 'cashEntity', id: e.id, label: e.entity })),
  }),

  get_deals: (s) => ({
    data: s.deals.map((d) => ({
      name: d.name, stage: d.stage, market: d.market, sf: d.sf, estPrice: fmtUsdCompact(d.estPrice),
      capRate: fmtPct(d.capRate, 2), irr: fmtPct(d.irr), nextAction: d.nextAction,
    })),
    refs: s.deals.map((d) => ({ type: 'deal', id: d.id, label: d.shortName ?? d.name })),
  }),

  get_relationships: (s, input) => {
    const kind = input.kind ? asStr(input.kind) : null;
    const q = input.query ? norm(asStr(input.query)) : null;
    let rows = s.counterparties;
    if (kind) rows = rows.filter((c) => c.kind === kind);
    if (q) rows = rows.filter((c) => norm(c.name).includes(q) || norm(c.firm ?? '').includes(q));
    rows = rows.slice(0, 20);
    return {
      data: rows.map((c) => ({ name: c.name, kind: c.kind, firm: c.firm, role: c.role, email: c.email, market: c.market })),
      refs: rows.map((c) => ({ type: 'counterparty', id: c.id, label: c.name })),
    };
  },

  get_alerts: (s) => {
    const insights = generateInsights(s);
    const r = revenueAtRisk(s.leases);
    const refs: EntityRefLite[] = insights
      .filter((i) => i.entityType && i.entityId && i.entityType !== 'cashEntity')
      .map((i) => ({ type: i.entityType as EntityRefLite['type'], id: i.entityId!, label: i.title }));
    return {
      data: {
        count: insights.length,
        critical: insights.filter((i) => i.severity === 'critical').length,
        warnings: insights.filter((i) => i.severity === 'warning').length,
        revenueExposedNext90d: fmtUsdCompact(r.within90dRent),
        alerts: insights.slice(0, 15).map((i) => ({ severity: i.severity, category: i.category, title: i.title, detail: i.detail })),
      },
      refs,
    };
  },

  search_entities: (s, input) => {
    const q = norm(asStr(input.query));
    if (!q) return { data: [], refs: [] };
    const refs: EntityRefLite[] = [];
    for (const p of s.properties) if (norm(p.name).includes(q)) refs.push({ type: 'property', id: p.id, label: p.name });
    for (const l of s.leases) if (norm(l.company ?? l.tenantName).includes(q)) refs.push({ type: 'lease', id: l.id, label: l.company ?? l.tenantName });
    for (const l of s.loans) if (norm(l.name).includes(q)) refs.push({ type: 'loan', id: l.id, label: l.name });
    for (const d of s.deals) if (norm(d.name).includes(q)) refs.push({ type: 'deal', id: d.id, label: d.name });
    for (const c of s.counterparties) if (norm(c.name).includes(q)) refs.push({ type: 'counterparty', id: c.id, label: c.name });
    const top = refs.slice(0, 20);
    return { data: top.map((r) => ({ type: r.type, name: r.label })), refs: top };
  },

  run_scenario: (s, input) => {
    const scenario = (asStr(input.scenario) || 'Base') as ScenarioName;
    const a = buildAnalytics(s, scenario);
    const k = a.kpis;
    return {
      data: {
        scenario,
        value: fmtUsdCompact(k.value.value),
        noi: fmtUsdCompact(k.noi.value),
        weightedCapRate: fmtPct(k.weightedCapRate.value),
        ltv: fmtPct(k.ltv.value),
        note: scenario === 'Base' ? 'Workbook figures.' : 'Modeled — derived from scenario factors.',
      },
      refs: [],
    };
  },

  search_documents: (_s, input) => ({
    // Fallback (no document index on this surface, e.g. the mirror). The live server injects a real
    // searcher via the agent; see server/sources/documents.ts.
    data: { query: asStr(input.query), result: 'No documents are indexed on this surface.' },
    refs: [],
  }),
};

export function runTool(name: string, snapshot: PortfolioSnapshot, input: Record<string, unknown>): ToolResult {
  const exec = (EXECUTORS as Record<string, Exec | undefined>)[name];
  if (!exec) return { data: { error: `Unknown tool: ${name}` }, refs: [] };
  try {
    return exec(snapshot, input);
  } catch (e) {
    return { data: { error: `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}` }, refs: [] };
  }
}
