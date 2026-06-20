// server/briefing/compose.ts
//
// Maps EXISTING warehouse analytics → a typed BriefingModel (the single render input). The cardinal
// rule (adversarial #1): the composer READS the same engine outputs the Intelligence pages call —
// scoreProperties / propertyPeriodMetrics / drivers / anomalies / growth / benchmarks / pmScorecards
// / lease-run — and NEVER recomputes a figure. A number in the PDF therefore cannot disagree with the
// number on the screen, because it is the same number formatted with the same helpers (fmtUsd/fmtPct).
//
// Every section degrades gracefully: a missing score / no second full year / no lease terms / no PM
// data renders an explicit '—'/'n/a' Figure, never a crash or a blank (Behavior contract #4).
//
// Confidentiality (Behavior contract #3): a BriefingModel is ownership-FINANCIAL (100%-basis figures
// keyed by the property slug). The composer NEVER reads seed-deals.ts or any deal term. As a fail-loud
// backstop it runs assertNoConfidential on the finished model before returning it.
import { fmtUsd, fmtUsdCompact, fmtPct } from '../../src/analytics/format';
import type { WarehouseDb } from '../warehouse/db';
import { propertyPeriodMetrics } from '../warehouse/metrics';
import type { PeriodMetrics } from '../warehouse/metrics';
import { scoreProperties } from '../warehouse/scores';
import { decomposeNoiChange, noiImpactByCategory } from '../warehouse/drivers';
import { detectAnomalies } from '../warehouse/anomalies';
import { sinceAcquisition } from '../warehouse/growth';
import { benchmarkMetric, pmScorecards } from '../warehouse/benchmarks';
import { getLeaseTerms } from '../warehouse/lease-terms';
import { projectLeaseRun, resolveAssumptions, computeMarkToMarket } from '../warehouse/lease-run';
import { loadOverlay } from '../overlay';
import { WORKBOOK_AS_OF } from '../config';
import {
  fullYearPeriods,
  pickDriverPeriods,
  pickPeriodMetrics,
  buildAnnualSeries,
  rootCauseLine,
  recommendedAction,
} from '../../src/modules/intel/property-intel';
import { assertNoConfidential } from './confidential';
import { managerSlug } from '../../src/contracts/briefing';
import type {
  PropertyBriefingModel,
  ManagerBriefingModel,
  BriefingMeta,
  Figure,
  Kpi,
  DriverLine,
  AnomalyLine,
  LeaseRunSummaryBlock,
} from '../../src/contracts/briefing';

export { managerSlug };

/**
 * Formats a value as a USD currency figure.
 *
 * @param value - A numeric value or `null`
 * @returns A Figure object with the value displayed as formatted USD
 */
function usdFig(value: number | null): Figure {
  return { display: fmtUsd(value), value: value ?? null, unit: 'usd' };
}
/**
 * Formats a USD value as a compact Figure object.
 *
 * @returns A Figure with compactly formatted USD display and unit 'usd'
 */
function usdCompactFig(value: number | null): Figure {
  return { display: fmtUsdCompact(value), value: value ?? null, unit: 'usd' };
}
/**
 * Formats a value as a USD-per-square-foot figure.
 *
 * @returns A Figure object with the value formatted as USD per square foot, or '—' if the value is null or non-finite.
 */
function usdPerSfFig(value: number | null): Figure {
  return { display: value === null || !Number.isFinite(value) ? '—' : `${fmtUsd(value, true)} /SF`, value: value ?? null, unit: 'usd_per_sf' };
}
/**
 * Creates a percentage figure from a numeric value.
 *
 * @returns A `Figure` object with the value formatted as a percentage.
 */
function pctFig(value: number | null): Figure {
  return { display: fmtPct(value), value: value ?? null, unit: 'pct' };
}
/**
 * Creates a Figure displaying a signed percentage.
 *
 * Non-negative values are prefixed with `+`. Null or non-finite values display as `—`.
 *
 * @returns A Figure with the percentage formatted for display, the original value, and unit `pct`
 */
function signedPctFig(value: number | null): Figure {
  const display = value === null || !Number.isFinite(value) ? '—' : value >= 0 ? `+${fmtPct(value)}` : fmtPct(value);
  return { display, value: value ?? null, unit: 'pct' };
}
/**
 * Formats a numeric score for display, with a fallback placeholder for null or non-finite values.
 *
 * @returns A `Figure` object with the score formatted to one decimal place, or `'—'` if the value is missing or non-finite.
 */
function scoreFig(value: number | null): Figure {
  return { display: value === null || !Number.isFinite(value) ? '—' : value.toFixed(1), value: value ?? null, unit: 'count' };
}

// ── Provenance / freshness ─────────────────────────────────────────────────────────────────────
/**
 * Retrieves the latest committed warehouse import date.
 *
 * @returns A date string in YYYY-MM-DD format for the latest committed import, or `null` if unavailable.
 */
export function latestCommittedImportDate(db: WarehouseDb): string | null {
  try {
    const row = db
      .prepare(`SELECT MAX(imported_at) AS m FROM import_batches WHERE status = 'committed'`)
      .get() as { m: string | null } | undefined;
    const m = row?.m ?? null;
    return m ? m.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Builds briefing metadata with generation date and data freshness.
 *
 * @returns `BriefingMeta` with generation date, latest committed import date, and branding information.
 */
function buildMeta(db: WarehouseDb, generatedDate: string): BriefingMeta {
  return {
    generatedDate,
    workbookAsOf: WORKBOOK_AS_OF,
    dataFreshness: latestCommittedImportDate(db),
    confidentialMarking: 'CONFIDENTIAL — INTERNAL',
    masthead: 'OXFORD REALTY ADVISORS',
  };
}

// ── Property name / manager lookup (authoritative: property_master) ────────────────────────────
interface MasterRow {
  id: string;
  name: string | null;
  market: string | null;
  property_manager: string | null;
  pm_contact: string | null;
}

/**
 * Fetches all property master records from the warehouse.
 *
 * @returns An array of property master rows. Returns an empty array if a database error occurs.
 */
function masterRows(db: WarehouseDb): MasterRow[] {
  try {
    return db
      .prepare(`SELECT id, name, market, property_manager, pm_contact FROM property_master`)
      .all() as MasterRow[];
  } catch {
    return [];
  }
}

// ── Per-property briefing ──────────────────────────────────────────────────────────────────────
export interface ComposeOptions {
  /** The generated-date stamped into the footer — INJECTED (never Date.now() inside the renderer),
   *  so the model (and the extracted PDF text) is deterministic. */
  generatedDate: string;
}

/**
 * Constructs a lease-run summary block for a property, including tenant projections and rent-status transition markers.
 *
 * @returns A `LeaseRunSummaryBlock` with tenant and financial projections; `present` is `false` if no lease terms exist.
 */
function leaseRunBlock(db: WarehouseDb, propertyId: string, metrics: PeriodMetrics[]): LeaseRunSummaryBlock {
  const terms = getLeaseTerms(db, propertyId);
  if (terms.length === 0) {
    return {
      present: false,
      tenant: null,
      currentExpiry: null,
      stabilizedNoi: usdFig(null),
      indicativeValue: usdFig(null),
      belowMarket: false,
      rolloverLabels: [],
    };
  }
  const overlay = loadOverlay();
  const assumptions = resolveAssumptions(overlay.leaseRunAssumptions?.[propertyId]);
  const projection = projectLeaseRun(terms[0]!, assumptions);
  // Cohort base = latest-period revenue-per-SF distribution (same as the lease-run route).
  const periods = [...new Set(metrics.map((m) => m.period))].sort((a, b) => a.localeCompare(b));
  const latest = periods[periods.length - 1];
  const cohort = latest
    ? (() => {
        const b = benchmarkMetric(metrics, latest, 'revenuePerSf');
        return { median: b.median, p25: b.p25, n: b.n };
      })()
    : { median: null, p25: null, n: 0 };
  const mtm = computeMarkToMarket(projection, cohort);
  // Rollover markers: lease-year labels where the rent STATUS changes (mirrors api.ts rolloverLabels).
  const rolloverLabels: string[] = [];
  let prev: string | null = null;
  for (const p of projection.periods) {
    if (prev !== null && p.status !== prev) rolloverLabels.push(p.leaseYearLabel);
    prev = p.status;
  }
  return {
    present: true,
    tenant: projection.tenant,
    currentExpiry: projection.currentExpiry,
    stabilizedNoi: usdFig(projection.stabilizedNoi),
    indicativeValue: usdCompactFig(projection.indicativeValue),
    belowMarket: mtm.belowMarket,
    rolloverLabels,
  };
}

/**
 * Composes a briefing model for a property.
 *
 * Returns `null` if the property has no metrics and no master row.
 *
 * @returns A `PropertyBriefingModel`, or `null` if the property does not exist.
 */
export function composePropertyBriefing(
  db: WarehouseDb,
  propertyId: string,
  opts: ComposeOptions,
): PropertyBriefingModel | null {
  const allMetrics = propertyPeriodMetrics(db);
  const series = allMetrics.filter((m) => m.propertyId === propertyId).sort((a, b) => a.period.localeCompare(b.period));
  const master = masterRows(db).find((r) => r.id === propertyId);
  // Unknown property with no metrics AND no master row → caller renders 404.
  if (series.length === 0 && !master) return null;

  const scores = scoreProperties(db, allMetrics);
  const score = scores.find((s) => s.propertyId === propertyId) ?? null;

  // Display name: master.name (authoritative) → any metric propertyName → propertyId.
  // Use || (not ??) so empty/whitespace names fall through to the next candidate.
  const name =
    (master?.name?.trim() || series.find((m) => m.propertyName?.trim())?.propertyName?.trim()) ?? propertyId;

  // KPI band — read the level metrics at the latest FULL-YEAR period (the screen's basis).
  const level = pickPeriodMetrics(series, null);
  const sa = sinceAcquisition(series);
  const kpis: Kpi[] = [
    {
      label: 'NOI',
      figure: usdFig(level?.noi ?? null),
      spark: buildAnnualSeries(series, (m) => m.noi),
    },
    {
      label: 'NOI margin',
      figure: pctFig(level?.noiMargin ?? null),
      spark: buildAnnualSeries(series, (m) => m.noiMargin),
    },
    {
      label: 'NOI / SF',
      figure: usdPerSfFig(level?.noiPerSf ?? null),
      spark: buildAnnualSeries(series, (m) => m.noiPerSf),
    },
    {
      label: 'NOI since acquisition',
      figure: signedPctFig(sa.noiGrowth),
      spark: [],
    },
  ];

  // Headline NOI trend sparkline (ascending FY NOI).
  const noiTrend = buildAnnualSeries(series, (m) => m.noi);

  // ΔNOI drivers — decompose between the two latest FULL-YEAR periods (the screen's waterfall).
  const driverPeriods = pickDriverPeriods(series);
  let drivers: DriverLine[] = [];
  let rootCause: string | null = null;
  if (driverPeriods) {
    const a = series.find((m) => m.period === driverPeriods.from);
    const b = series.find((m) => m.period === driverPeriods.to);
    if (a && b) {
      const decomp = decomposeNoiChange(noiImpactByCategory(a), noiImpactByCategory(b));
      drivers = decomp.drivers.slice(0, 5).map((d) => ({
        category: d.category,
        delta: usdFig(d.delta),
        contributionPct: pctFig(d.contributionPct),
      }));
      rootCause = rootCauseLine({ ...decomp, propertyId, from: driverPeriods.from, to: driverPeriods.to });
    }
  }

  // Anomalies for this property (read straight off the engine).
  const anomalies: AnomalyLine[] = detectAnomalies(allMetrics)
    .filter((x) => x.propertyId === propertyId)
    .map((x) => ({ severity: x.severity, kind: x.kind, detail: x.detail }));

  // Benchmark — NOI/SF quartile + cohort median, from the score + the benchmarks engine.
  const benchPeriod = score?.period ?? fullYearPeriods(series).slice(-1)[0]?.period ?? '';
  const bench = benchPeriod ? benchmarkMetric(allMetrics, benchPeriod, 'noiPerSf') : null;

  const model: PropertyBriefingModel = {
    kind: 'property',
    meta: buildMeta(db, opts.generatedDate),
    subject: {
      propertyId,
      name,
      market: master?.market ?? null,
      manager: master?.property_manager ?? null,
      scoredPeriod: score?.period ?? null,
    },
    verdict: {
      health: scoreFig(score?.health ?? null),
      healthBand: score?.healthBand ?? 'concern',
      attentionBand: score?.attentionBand ?? 'red',
      capitalAction: score?.capitalAction ?? 'monitor',
      rootCause,
      recommendation: score ? recommendedAction(score) : 'Insufficient data to recommend an action.',
    },
    kpis,
    noiTrend,
    drivers,
    anomalies,
    leaseRun: leaseRunBlock(db, propertyId, allMetrics),
    benchmark: {
      noiPerSfQuartile: score?.noiPerSfQuartile ?? null,
      cohortSize: score?.benchmarkCohortSize ?? bench?.n ?? 0,
      noiPerSf: usdPerSfFig(level?.noiPerSf ?? null),
      cohortMedianNoiPerSf: usdPerSfFig(bench?.median ?? null),
    },
  };

  assertNoConfidential(model); // fail-loud backstop (Behavior contract #3)
  return model;
}

/**
 * Generates a briefing for a property manager containing ranked properties, aggregate metrics, and recommended actions.
 *
 * @returns A `ManagerBriefingModel` with portfolio data, scorecard metrics, and attention items, or `null` if no managed properties are found.
 */
export function composeManagerBriefing(
  db: WarehouseDb,
  managerId: string,
  opts: ComposeOptions,
): ManagerBriefingModel | null {
  const allMetrics = propertyPeriodMetrics(db);
  const masters = masterRows(db);
  // Resolve the manager by slug match on the property_master.property_manager string.
  const managed = masters.filter((r) => r.property_manager && managerSlug(r.property_manager) === managerId);
  if (managed.length === 0) return null;
  const managerName = managed[0]!.property_manager!;
  const contact = managed.find((r) => r.pm_contact)?.pm_contact ?? null;

  const scorecard = pmScorecards(db, allMetrics).find((s) => managerSlug(s.propertyManager) === managerId) ?? null;
  const scores = scoreProperties(db, allMetrics);

  // Managed-property rows: each carries the SAME score the per-property page shows. Sorted by
  // attention severity (red→green) then name, so the worst assets lead the roll-up.
  const ATTENTION_ORDER: Record<string, number> = { red: 0, orange: 1, yellow: 2, green: 3 };
  const rows = managed
    .map((m) => {
      const sc = scores.find((s) => s.propertyId === m.id) ?? null;
      const level = pickPeriodMetrics(
        allMetrics.filter((x) => x.propertyId === m.id).sort((a, b) => a.period.localeCompare(b.period)),
        null,
      );
      return {
        propertyId: m.id,
        name: m.name ?? m.id,
        health: scoreFig(sc?.health ?? null),
        healthBand: sc?.healthBand ?? ('concern' as const),
        noi: usdFig(level?.noi ?? null),
        attentionBand: sc?.attentionBand ?? ('red' as const),
      };
    })
    .sort((a, b) => {
      const d = (ATTENTION_ORDER[a.attentionBand] ?? 0) - (ATTENTION_ORDER[b.attentionBand] ?? 0);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });

  // Aggregate attention items: distinct high/critical anomalies + orange/red property names.
  const anomalies = detectAnomalies(allMetrics);
  const managedIds = new Set(managed.map((m) => m.id));
  const attentionItems: string[] = [];
  for (const r of rows) {
    if (r.attentionBand === 'red' || r.attentionBand === 'orange') {
      attentionItems.push(`${r.name}: attention ${r.attentionBand} (health ${r.health.display}).`);
    }
  }
  for (const a of anomalies) {
    if (!managedIds.has(a.propertyId)) continue;
    if (a.severity === 'high' || a.severity === 'critical') {
      const nm = managed.find((m) => m.id === a.propertyId)?.name ?? a.propertyId;
      attentionItems.push(`${nm}: ${a.detail}`);
    }
  }

  // Ranked action list: worst attention first → concrete verb.
  const actionList: string[] = rows
    .filter((r) => r.attentionBand === 'red' || r.attentionBand === 'orange')
    .map((r) => `Review ${r.name} with the manager — ${r.attentionBand} attention, health ${r.health.display}.`);
  if (actionList.length === 0) actionList.push('No flagged actions — portfolio within tolerance.');

  const model: ManagerBriefingModel = {
    kind: 'manager',
    meta: buildMeta(db, opts.generatedDate),
    subject: {
      managerId,
      name: managerName,
      contact,
      propertyCount: scorecard?.propertyCount ?? managed.length,
      smallSample: scorecard?.smallSample ?? managed.length < 3,
    },
    scorecard: {
      avgNoiPerSf: usdPerSfFig(scorecard?.avgNoiPerSf ?? null),
      avgNoiGrowth: signedPctFig(scorecard?.avgNoiGrowth ?? null),
      avgExpenseGrowth: signedPctFig(scorecard?.avgExpenseGrowth ?? null),
    },
    managedProperties: rows,
    attentionItems,
    actionList,
  };

  assertNoConfidential(model);
  return model;
}
