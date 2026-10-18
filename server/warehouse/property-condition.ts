// server/warehouse/property-condition.ts
//
// Property Condition read model (Phase 2 of docs/capital/2026-10-07-pca-capex-ledger-integration-plan.md):
// turns the migration-035 ledger into the PropertyConditionReport wire contract. PURE READ — no writes,
// no calibration logging, no Spine A/B access. These are capex-reserve / price-basis facts, never NOI.
//
// RULES (mirror the contract header — a future edit must not break them):
//   (1) "Current" = the MOST RECENT report for a property_key (Gabriel, 2026-10-07: "most recent details
//       we have"). There is NO age cutoff. Age and usabilityClass travel as caveats; older reports are
//       kept as history and are never summed into totals.
//   (2) Consultant estimates (pca_components → lifecycle / priceBook) and contractor prices (capex_quotes)
//       stay in separate lists. unitPriceUsdPsf is a per-row derivation, never an aggregate/median
//       (every contractor scope is n=1).
//   (3) Derived figures (age, reservesPsfYr, dueYear, deltaPct, warrantyStatus) are computed here at read
//       time from stored facts; a warranty end year is only ever the one the register stated.
import {
  PropertyConditionReport,
  type PcaCalibrationRow,
  type PcaEvidenceClass,
  type PcaLifecycleRow,
  type PcaPriceBookRow,
  type PcaPropertySummary,
  type PcaQuoteRow,
  type PcaReportBrief,
  type PcaScheduleRow,
  type PcaWarrantyStatus,
} from '../../src/contracts/property-condition';
import { byCode, reportStatus } from '../../src/analytics/pca-intelligence';
import type { WarehouseDb } from './db';

interface ReportRow {
  report_id: string;
  property_key: string;
  property_master_id: string | null;
  property_label: string;
  consultant: string | null;
  report_date: string | null;
  sf: number | null;
  immediate_usd: number | null;
  short_term_usd: number | null;
  reserves_uninfl_usd: number | null;
  reserves_infl_usd: number | null;
  term_years: number | null;
  psf_yr_stated: number | null;
  usability_raw: string | null;
  usability_class: PcaReportBrief['usabilityClass'];
  notes: string | null;
}

/** Year of a YYYY / YYYY-MM / YYYY-MM-DD date, or null. */
function yearOf(date: string | null): number | null {
  if (date === null) return null;
  const y = Number(date.slice(0, 4));
  return Number.isInteger(y) ? y : null;
}

function brief(r: ReportRow): PcaReportBrief {
  return {
    reportId: r.report_id,
    reportDate: r.report_date,
    consultant: r.consultant,
    usabilityClass: r.usability_class,
    usabilityRaw: r.usability_raw,
    sf: r.sf,
    immediateUsd: r.immediate_usd,
    shortTermUsd: r.short_term_usd,
    reservesUninflUsd: r.reserves_uninfl_usd,
    reservesInflUsd: r.reserves_infl_usd,
    termYears: r.term_years,
    psfYrStated: r.psf_yr_stated,
    notes: r.notes,
  };
}

/** Newest first: dated before undated, later date first (lexicographic is correct for ISO partials), report_id desc as tiebreak. */
function newestFirst(a: ReportRow, b: ReportRow): number {
  if (a.report_date === null && b.report_date !== null) return 1;
  if (a.report_date !== null && b.report_date === null) return -1;
  // This picks each property's CURRENT report, so it is a selection rule, not a display sort. Ruled 2026-10-17 (Gabriel):
  // a same-date tie goes to the code-unit-greatest report_id, so the choice never depends on host locale or ICU.
  // Dates compare as raw strings, so a year-only '2025' ranks below '2025-03-01' (monthsSince reads year-only as December;
  // the two never disagree on the register today, which has no same-property mixed-precision pair in one year).
  return byCode(b.report_date ?? '', a.report_date ?? '') || byCode(b.report_id, a.report_id);
}

export function warrantyStatus(endYear: number | null, asOfYear: number): PcaWarrantyStatus {
  if (endYear === null) return 'unknown';
  if (endYear < asOfYear) return 'expired';
  if (endYear === asOfYear) return 'ends-this-year';
  return endYear - asOfYear <= 2 ? 'expiring' : 'active';
}

function evidenceClass(recordType: string | null, status: string | null): PcaEvidenceClass {
  const st = (status ?? '').toLowerCase();
  const rt = (recordType ?? '').toLowerCase();
  if (st === 'superseded') return 'superseded';
  if (rt === 'estimate') return 'budget';
  if (rt === 'contract' || st === 'awarded' || st === 'completed') return 'executed';
  return 'quoted';
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

export function buildPropertyConditionReport(db: WarehouseDb, asOf: string): PropertyConditionReport {
  const asOfYear = Number(asOf.slice(0, 4));

  const reportRows = db.prepare('SELECT * FROM pca_reports').all() as ReportRow[];

  // ── properties: latest report per property_key is "current"; the rest are history ──
  const byKey = new Map<string, ReportRow[]>();
  for (const r of reportRows) {
    const g = byKey.get(r.property_key);
    if (g) g.push(r);
    else byKey.set(r.property_key, [r]);
  }

  const currentByKey = new Map<string, ReportRow>();
  const properties: PcaPropertySummary[] = [];
  for (const [key, group] of byKey) {
    const ordered = [...group].sort(newestFirst);
    const cur = ordered[0];
    if (!cur) continue;
    currentByKey.set(key, cur);
    const curYear = yearOf(cur.report_date);
    const hasFigures = [cur.immediate_usd, cur.short_term_usd, cur.reserves_uninfl_usd, cur.reserves_infl_usd].some((v) => v !== null);
    properties.push({
      propertyKey: key,
      propertyLabel: cur.property_label,
      propertyMasterId: cur.property_master_id,
      current: brief(cur),
      history: ordered.slice(1).map(brief),
      ageYears: curYear === null ? null : Math.max(0, asOfYear - curYear),
      reservesPsfYr:
        cur.reserves_uninfl_usd !== null && cur.sf !== null && cur.sf > 0 && cur.term_years !== null
          ? cur.reserves_uninfl_usd / cur.sf / cur.term_years
          : null,
      hasDollarFigures: hasFigures,
    });
  }
  // Largest near-term exposure first (immediate + short-term), then label.
  properties.sort((a, b) => {
    const ea = (a.current.immediateUsd ?? 0) + (a.current.shortTermUsd ?? 0);
    const eb = (b.current.immediateUsd ?? 0) + (b.current.shortTermUsd ?? 0);
    return eb - ea || byCode(a.propertyLabel, b.propertyLabel) || byCode(a.propertyKey, b.propertyKey);
  });

  // STALE (pre-2024 / undated / flagged-stale) current reports are history: they never feed dollar totals or the
  // figures count (same single vintage rule as the client overlay, src/analytics/pca-intelligence.ts reportStatus).
  const live = properties.filter((p) => reportStatus(p.current) !== 'STALE');
  const currents = live.map((p) => p.current);
  const totals = {
    propertiesTotal: properties.length,
    propertiesWithFigures: live.filter((p) => p.hasDollarFigures).length,
    immediateUsd: sum(currents.map((c) => c.immediateUsd)),
    shortTermUsd: sum(currents.map((c) => c.shortTermUsd)),
    reservesUninflUsd: sum(currents.map((c) => c.reservesUninflUsd)),
  };

  // ── schedule: install / warranty facts ──
  const assetRows = db
    .prepare('SELECT * FROM asset_facts ORDER BY property_label, row_seq')
    .all() as Array<{
    property_key: string; property_label: string; component: string; install_fact: string | null;
    install_year: number | null; warranty: string | null; warranty_end_year: number | null; flag: string | null;
  }>;
  const schedule: PcaScheduleRow[] = assetRows.map((a) => ({
    propertyKey: a.property_key,
    propertyLabel: a.property_label,
    component: a.component,
    installFact: a.install_fact,
    installYear: a.install_year,
    ageYears: a.install_year === null ? null : Math.max(0, asOfYear - a.install_year),
    warranty: a.warranty,
    warrantyEndYear: a.warranty_end_year,
    warrantyStatus: warrantyStatus(a.warranty_end_year, asOfYear),
    flag: a.flag,
  }));
  // Warranty problems first (expired, this year, expiring), then by property.
  const warrantyRank: Record<PcaWarrantyStatus, number> = { expired: 0, 'ends-this-year': 1, expiring: 2, active: 3, unknown: 4 };
  schedule.sort((a, b) => warrantyRank[a.warrantyStatus] - warrantyRank[b.warrantyStatus] || byCode(a.propertyLabel, b.propertyLabel));

  // ── lifecycle: consultant-estimated lines from each property's CURRENT report only ──
  const compRows = db
    .prepare('SELECT * FROM pca_components ORDER BY report_id, row_seq')
    .all() as Array<{
    report_id: string; system: string; eul: number | null; age: number | null; rul: number | null;
    rul_raw: string | null; total_usd: number | null; timing: string | null; unit_cost: number | null; uom: string | null;
  }>;
  const reportById = new Map(reportRows.map((r) => [r.report_id, r]));
  const currentIds = new Set([...currentByKey.values()].map((r) => r.report_id));
  const lifecycle: PcaLifecycleRow[] = [];
  const priceBook: PcaPriceBookRow[] = [];
  for (const c of compRows) {
    const rep = reportById.get(c.report_id);
    if (!rep) continue;
    const repYear = yearOf(rep.report_date);
    if (currentIds.has(c.report_id)) {
      lifecycle.push({
        propertyKey: rep.property_key,
        propertyLabel: rep.property_label,
        reportId: c.report_id,
        reportDate: rep.report_date,
        system: c.system,
        eul: c.eul,
        age: c.age,
        rulRaw: c.rul_raw,
        dueYear: c.rul !== null && repYear !== null ? repYear + c.rul : null,
        totalUsd: c.total_usd,
        timing: c.timing,
        basis: 'estimate',
      });
    }
    // Price book: unit costs only; lump sums (LS) and zero/blank unit costs are not comparable prices.
    if (c.unit_cost !== null && c.unit_cost > 0 && (c.uom ?? '').toUpperCase() !== 'LS') {
      priceBook.push({
        reportId: c.report_id,
        propertyKey: rep.property_key,
        propertyLabel: rep.property_label,
        reportYear: repYear,
        system: c.system,
        uom: c.uom,
        unitCost: c.unit_cost,
        basis: 'estimate',
      });
    }
  }
  // Soonest due first; undated last; then largest dollars.
  lifecycle.sort((a, b) => {
    if (a.dueYear === null && b.dueYear !== null) return 1;
    if (a.dueYear !== null && b.dueYear === null) return -1;
    return (a.dueYear ?? 0) - (b.dueYear ?? 0) || (b.totalUsd ?? 0) - (a.totalUsd ?? 0);
  });
  priceBook.sort((a, b) => byCode(a.system, b.system) || (b.reportYear ?? 0) - (a.reportYear ?? 0));

  // ── calibration: curated estimate-vs-executed pairs; delta computed here ──
  const pairRows = db.prepare('SELECT * FROM capex_calibration_pairs ORDER BY row_seq').all() as Array<{
    property_key: string; property_label: string; scope: string; estimate_source: string | null;
    estimate_usd: number | null; estimate_psf: number | null; contractor_source: string | null;
    contractor_usd: number | null; contractor_psf: number | null; comment: string | null;
  }>;
  const calibration: PcaCalibrationRow[] = pairRows.map((p) => {
    let deltaPct: number | null = null;
    let deltaBasis: PcaCalibrationRow['deltaBasis'] = null;
    if (p.estimate_usd !== null && p.estimate_usd > 0 && p.contractor_usd !== null) {
      deltaPct = p.contractor_usd / p.estimate_usd - 1;
      deltaBasis = 'usd';
    } else if (p.estimate_psf !== null && p.estimate_psf > 0 && p.contractor_psf !== null) {
      deltaPct = p.contractor_psf / p.estimate_psf - 1;
      deltaBasis = 'psf';
    }
    return {
      propertyKey: p.property_key,
      propertyLabel: p.property_label,
      scope: p.scope,
      estimateSource: p.estimate_source,
      estimateUsd: p.estimate_usd,
      estimatePsf: p.estimate_psf,
      contractorSource: p.contractor_source,
      contractorUsd: p.contractor_usd,
      contractorPsf: p.contractor_psf,
      deltaPct,
      deltaBasis,
      comment: p.comment,
    };
  });

  // ── quotes: contractor evidence, one row each ──
  const quoteRows = db.prepare('SELECT * FROM capex_quotes ORDER BY doc_date DESC, title').all() as Array<{
    quote_key: string; title: string; property_key: string; property_label: string; vendor: string | null;
    record_type: string | null; status: string | null; trade: string | null; doc_date: string | null;
    quoted_usd: number | null; actual_usd: number | null; qty: number | null; uom: string | null;
    scope_summary: string | null; confidence: string | null; verified: number; funding_class: string | null;
    lease_recovery: string | null; notes: string | null;
  }>;
  const quotes: PcaQuoteRow[] = quoteRows.map((q) => {
    const priced = q.actual_usd ?? q.quoted_usd;
    return {
      quoteKey: q.quote_key,
      title: q.title,
      propertyKey: q.property_key,
      propertyLabel: q.property_label,
      vendor: q.vendor,
      recordType: q.record_type,
      status: q.status,
      trade: q.trade,
      docDate: q.doc_date,
      quotedUsd: q.quoted_usd,
      actualUsd: q.actual_usd,
      qty: q.qty,
      uom: q.uom,
      unitPriceUsdPsf: priced !== null && q.qty !== null && q.qty > 0 && (q.uom ?? '').toUpperCase() === 'SF' ? priced / q.qty : null,
      evidenceClass: evidenceClass(q.record_type, q.status),
      scopeSummary: q.scope_summary,
      confidence: q.confidence,
      verified: q.verified === 1,
      fundingClass: q.funding_class,
      leaseRecovery: q.lease_recovery,
      notes: q.notes,
    };
  });

  const openItems = (db.prepare('SELECT * FROM pca_open_items ORDER BY item_no').all() as Array<{
    item_no: number; severity: 'High' | 'Med' | 'Low' | 'Info'; property_text: string | null; issue: string; action_needed: string | null;
  }>).map((i) => ({
    itemNo: i.item_no,
    severity: i.severity,
    propertyText: i.property_text,
    issue: i.issue,
    actionNeeded: i.action_needed,
  }));

  return PropertyConditionReport.parse({
    asOf,
    loaded: reportRows.length > 0,
    properties,
    totals,
    schedule,
    lifecycle,
    calibration,
    quotes,
    priceBook,
    openItems,
  });
}
