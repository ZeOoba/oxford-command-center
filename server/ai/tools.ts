import type { PortfolioSnapshot, ScenarioName } from '../../src/contracts/index';
import {
  buildAnalytics,
  portfolioKpis,
  marketAllocation,
  revenueAtRisk,
  debtSummary,
} from '../../src/analytics/engine';
import { evaluateConditions } from '../../src/analytics/conditions';
import { isInvestmentProperty } from '../../src/analytics/property-basis';
import { isAffiliateNoteProperty, propertyLtvLabel } from '../../src/analytics/debt-basis';
import { TOTAL_DEBT_BASIS, EXTERNAL_DEBT_BASIS, debtBasisIssues } from './debt-basis-copy';
import { fmtUsdCompact, fmtPct } from '../../src/analytics/format';
import { contractAnnualRent } from '../../src/analytics/lease-rent';
import { referenceDate } from '../config';

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

/**
 * Hard Invariant 3 on the AI egress (OI-225). `get_deals` and `search_entities` already dropped
 * `confidential:true` rows; `get_alerts` and `get_relationships` did not, and every tool result is
 * appended verbatim into the outbound Anthropic `messages` array.
 *
 * Keyed on the `confidential` FLAG, not on the confidential-terms roster: this must work on the
 * Cloudflare mirror, which is deliberately baked WITH confidential data under
 * MIRROR_INCLUDE_CONFIDENTIAL=1 and has no filesystem to read a roster from. The terms-based scan is
 * a second, server-only layer injected into runAgent.
 *
 * The filter lives HERE and not in src/analytics/conditions.ts on purpose: the dashboard and the
 * briefing legitimately show Gabriel his own confidential alerts. It is only the egress that must
 * not carry them.
 *
 * `mentions` is the free-text residue sweep — dropping rows by id alone is not enough, because a
 * human can name a confidential deal from a PUBLIC row's free text (a next-action cross-reference,
 * say). scripts/bake-mirror.ts's redactConfidential hit the identical case; that was a high-severity
 * refute finding there, so it is built in here rather than waiting to be rediscovered.
 */
function confidentialScope(s: PortfolioSnapshot): {
  ids: Set<string>;
  any: boolean;
  mentions: (text: string | null | undefined) => boolean;
} {
  const confidential = s.deals.filter((d) => d.confidential);
  const ids = new Set(confidential.map((d) => d.id));
  const names = confidential
    .flatMap((d) => [d.name, d.shortName])
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());
  return {
    ids,
    any: confidential.length > 0,
    mentions: (text) => !!text && names.some((n) => text.toLowerCase().includes(n)),
  };
}

/** Stand-in for a detail line whose free text named a confidential deal. Never echoes the term. */
const REDACTED_DETAIL = 'Detail withheld — references a confidential deal.';

/** Shared confidentiality visibility rule for a counterparty (OI-225 refute finding: this was
 *  implemented only in get_relationships and silently absent from search_entities, so the exact
 *  counterparty get_relationships drops was still reachable by name search). One rule, two callers. */
function isConfidentialCounterparty(c: PortfolioSnapshot['counterparties'][number], conf: ReturnType<typeof confidentialScope>): boolean {
  if (!conf.any) return false;
  // Orphaned BY the redaction: a counterparty whose ONLY edges were confidential deals. An orphaned
  // counsel name + market identifies the deal it worked. A node with a surviving property/loan/
  // insurance link stands on its own and is kept (bake-mirror I8, same rule).
  const keptDeals = c.links.deals.filter((id) => !conf.ids.has(id));
  const droppedAny = keptDeals.length !== c.links.deals.length;
  const linkless =
    keptDeals.length === 0 &&
    c.links.properties.length === 0 &&
    c.links.loans.length === 0 &&
    c.links.insurance.length === 0;
  if (droppedAny && linkless) return true;
  // Residue: the node's own free text names a confidential deal.
  return conf.mentions(c.name) || conf.mentions(c.firm) || conf.mentions(c.role) || conf.mentions(c.notes);
}

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
    description: 'Search indexed lease/PSA/OM documents and return cited passages (e.g. "renewal option in the Eurosort lease"). Available on the local server when documents are indexed; returns none on the read-only mirror.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'get_macro',
    description: 'Live macro rate environment from FRED — key US rates (10Y/2Y Treasury, SOFR, Fed Funds, CPI YoY) with current value + period change, plus a 12-month 10Y Treasury trend (low/high, window-dated). Use for refi vs book-rate spread questions, cap-rate-vs-Treasury spread, and "what is the rate environment" framing. The CANONICAL current 10Y is `indicators.DGS10.value` at `asOf` — never quote `tenYearTrend.endDate`-windowed values as the current rate. If the result includes a `dataFreshness` field starting with "SEEDED" (FRED_API_KEY unset), you MUST tell the user the live rate feed is offline before quoting any number — the rates are a static snapshot, not current. Returns "not available on this surface" on the static mirror.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]['name'];

// ── executors ──────────────────────────────────────────────────────────────────
const EXECUTORS: Record<ToolName, Exec> = {
  get_portfolio_summary: (s) => {
    // WALT is a "years from now" figure → run-date basis (referenceDate), not the frozen
    // workbook data date. Other KPIs here are level metrics, unaffected by the reference.
    const k = portfolioKpis(s, s.meta.scenario, referenceDate());
    // Same investment-only basis as the KPI cells above (ratified 2026-09-23): the market slices
    // must sum to `value` / `noi`, not to a residence-inclusive total beside them.
    const investment = s.properties.filter(isInvestmentProperty);
    // "Report it as other holdings" is the other half of the 2026-09-23 ruling: wherever the investment
    // headline appears, the residence must appear beside it — otherwise `value` disagrees with the
    // workbook's own Portfolio Total by exactly the residence and the model has no reconciling item.
    const otherCount = k.otherHoldingsCount.value ?? 0;
    const otherValue = fmtUsdCompact(k.otherHoldingsValue.value);
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
        totalDebtBasis: TOTAL_DEBT_BASIS,
        ...(k.affiliateDebt.value ? { affiliateNotesExcluded: fmtUsdCompact(k.affiliateDebt.value) } : {}),
        ...(debtBasisIssues(s.dataQuality ?? []).length ? { debtBasisFlags: debtBasisIssues(s.dataQuality ?? []) } : {}),
        totalCash: fmtUsdCompact(k.totalCash.value),
        waltYears: k.walt.value,
        valueByMarket: marketAllocation(investment, 'value').map((m) => ({ market: m.market, value: fmtUsdCompact(m.value), pct: fmtPct(m.pct) })),
        noiByMarket: marketAllocation(investment, 'noi').map((m) => ({ market: m.market, noi: fmtUsdCompact(m.value), pct: fmtPct(m.pct) })),
        ...(otherCount > 0 ? { otherHoldingsValue: otherValue, otherHoldingsCount: otherCount } : {}),
        note:
          'Counts are investment assets (the "Sepich Portfolio" bundles 8 buildings as one row); SF is Oxford-share.' +
          (otherCount > 0
            ? ` Value, NOI, SF and counts EXCLUDE ${otherCount} non-investment holding${otherCount === 1 ? '' : 's'} (the residence), carried separately as other holdings at ${otherValue}; the workbook's own Portfolio Total includes it.`
            : ''),
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
        noi: fmtUsdCompact(p.noi), capRate: fmtPct(p.capRate), dscr: p.dscr, ltv: propertyLtvLabel(p), affiliateNote: isAffiliateNoteProperty(p),
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
          annualRent: fmtUsdCompact(l.annualRent), contractAnnualRent: fmtUsdCompact(contractAnnualRent(l)), status: l.status, leaseEnd: l.leaseEnd, monthsToExpiry: l.monthsToExpiry,
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
        externalDebtBasis: EXTERNAL_DEBT_BASIS,
        ...(d.affiliateDebt > 0 ? { affiliateNotesExcluded: fmtUsdCompact(d.affiliateDebt) } : {}),
        ...(debtBasisIssues(s.dataQuality ?? []).length ? { debtBasisFlags: debtBasisIssues(s.dataQuality ?? []) } : {}),
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

  get_deals: (s) => {
    // Residue sweep (refute finding, CRITICAL): a PUBLIC deal's own free-text `nextAction` can name
    // a confidential deal (a pricing/comps cross-reference) — dropping rows by `confidential` alone
    // missed this, and it is the exact scenario this tool's own test fixture already carried.
    const conf = confidentialScope(s);
    const visible = s.deals.filter((d) => !d.confidential);
    return {
      data: visible.map((d) => ({
        name: d.name, stage: d.stage, market: d.market, sf: d.sf, estPrice: fmtUsdCompact(d.estPrice),
        capRate: fmtPct(d.capRate, 2), irr: fmtPct(d.irr),
        nextAction: conf.mentions(d.nextAction) ? REDACTED_DETAIL : d.nextAction,
      })),
      refs: visible.map((d) => ({ type: 'deal', id: d.id, label: d.shortName ?? d.name })),
    };
  },

  get_relationships: (s, input) => {
    const kind = input.kind ? asStr(input.kind) : null;
    const q = input.query ? norm(asStr(input.query)) : null;
    const conf = confidentialScope(s);
    let rows = s.counterparties.filter((c) => !isConfidentialCounterparty(c, conf));
    if (kind) rows = rows.filter((c) => c.kind === kind);
    if (q) rows = rows.filter((c) => norm(c.name).includes(q) || norm(c.firm ?? '').includes(q));
    rows = rows.slice(0, 20);
    return {
      data: rows.map((c) => ({ name: c.name, kind: c.kind, firm: c.firm, role: c.role, email: c.email, market: c.market })),
      refs: rows.map((c) => ({ type: 'counterparty', id: c.id, label: c.name })),
    };
  },

  get_alerts: (s) => {
    // Alert day-counts and near-term exposure track the run date, not the workbook data date.
    const ref = referenceDate();
    const raw = evaluateConditions(s, { referenceDate: ref });
    const r = revenueAtRisk(s.leases, ref);
    // Confidentiality pass BEFORE anything is derived. Every count, ref and row below comes off the
    // filtered list: reporting `count: 3` beside two visible alerts would itself disclose that a
    // third deal exists and is being withheld.
    const conf = confidentialScope(s);
    const insights = !conf.any
      ? raw
      : raw
          // The deal's own alerts, by id — the only case where dropping the row is correct: the row
          // IS the confidential deal, so no redacted version of it is safe to keep.
          .filter((i) => !(i.entityType === 'deal' && i.entityId && conf.ids.has(i.entityId)))
          // TITLE is deliberately NEVER checked here (2nd refute pass, 2026-09-10 — an earlier
          // version of this function did, and that was itself the bug). A title is
          // template-derived from the entity's OWN canonical name field, never free text (verified
          // across every category in conditions.ts) — a surviving row's title can only coincide with
          // a confidential deal's name/shortName by substring accident (shortName "Easton" landing
          // inside "29000 Information Lane, Easton MD"), never by actually referencing the deal.
          // Redacting that title bought NOTHING: the identical canonical name is already reachable
          // unfiltered via get_property/get_loans/get_leases in the very same conversation, so a
          // model that wanted it could just ask — while the redacted stand-in string was itself a
          // distinguishing "something is being withheld right here" tell, and (the actual defect
          // that pass caught) blanking `detail` alongside a title-only hit destroyed real content —
          // once a covenant-breach DSCR detail — that had already been proven clean.
          //
          // DETAIL is the one field checked, because it is the one field that legitimately carries
          // human free text (a nextAction cross-reference is the proven case) rather than a
          // templated name. Redact-in-place, not drop: the row stays counted, so a real alert about
          // an unrelated entity is never silently denied.
          .map((i) => (conf.mentions(i.detail) ? { ...i, detail: REDACTED_DETAIL } : i));
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
    // Refute finding (HIGH): get_relationships' confidentiality rule (orphaned-link + free-text
    // residue) was implemented ONLY there — the same withheld counterparty, and any counterparty
    // whose own name/firm/role/notes named a confidential deal, was still reachable via search.
    const conf = confidentialScope(s);
    const refs: EntityRefLite[] = [];
    for (const p of s.properties) if (norm(p.name).includes(q)) refs.push({ type: 'property', id: p.id, label: p.name });
    for (const l of s.leases) if (norm(l.company ?? l.tenantName).includes(q)) refs.push({ type: 'lease', id: l.id, label: l.company ?? l.tenantName });
    for (const l of s.loans) if (norm(l.name).includes(q)) refs.push({ type: 'loan', id: l.id, label: l.name });
    for (const d of s.deals) if (!d.confidential && norm(d.name).includes(q)) refs.push({ type: 'deal', id: d.id, label: d.name });
    for (const c of s.counterparties) if (!isConfidentialCounterparty(c, conf) && norm(c.name).includes(q)) refs.push({ type: 'counterparty', id: c.id, label: c.name });
    const top = refs.slice(0, 20);
    return { data: top.map((r) => ({ type: r.type, name: r.label })), refs: top };
  },

  run_scenario: (s, input) => {
    const scenario = (asStr(input.scenario) || 'Base') as ScenarioName;
    const a = buildAnalytics(s, scenario, referenceDate());
    const k = a.kpis;
    // Same disclosure as get_portfolio_summary (ratified 2026-09-23): the residence is never shocked and
    // is reported beside the investment headline in every scenario.
    const otherCount = k.otherHoldingsCount.value ?? 0;
    const otherValue = fmtUsdCompact(k.otherHoldingsValue.value);
    return {
      data: {
        scenario,
        value: fmtUsdCompact(k.value.value),
        noi: fmtUsdCompact(k.noi.value),
        weightedCapRate: fmtPct(k.weightedCapRate.value),
        ltv: fmtPct(k.ltv.value),
        ...(otherCount > 0 ? { otherHoldingsValue: otherValue, otherHoldingsCount: otherCount } : {}),
        note:
          (scenario === 'Base' ? 'Workbook figures.' : 'Modeled — derived from scenario factors.') +
          (otherCount > 0 ? ` Value/NOI exclude ${otherCount} non-investment holding${otherCount === 1 ? '' : 's'} (the residence), carried unshocked as other holdings at ${otherValue}.` : ''),
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

  get_macro: () => ({
    // Fallback (no live macro provider injected on this surface). The live server injects a real
    // provider via the agent (server/macro/getMacro.ts); see server/ai/agent.ts macroProvider opt.
    data: { result: 'Live macro is not available on this surface.' },
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
