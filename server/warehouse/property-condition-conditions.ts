// server/warehouse/property-condition-conditions.ts
//
// Server-side Property Condition alert conditions (Phase 3 of
// docs/capital/2026-10-07-pca-capex-ledger-integration-plan.md). Reads the migration-035 ledger through
// buildPropertyConditionReport — the SAME read model the destination renders — so "current" (the most
// recent report per property, no age cutoff) means exactly one thing in the alerts and in the UI.
//
//   pca-warranty-<propertyKey>-<component>   — severity: warning (one per asset fact)
//     Fires when a warranty END YEAR STATED in the source document is within
//     ALERT_THRESHOLDS.pcaWarrantyWarnYears years ahead of the reference year (inclusive of the
//     reference year itself), or lapsed at most ALERT_THRESHOLDS.pcaWarrantyLapsedYears years behind it.
//     Older lapses are history and stay silent. The register states end YEARS, never dates, so the
//     whole condition is year-grain and the detail says "in <year>", never a day count. A warranty with
//     no stated end year never alerts (nothing is derived from install year + a guessed term).
//
//   pca-dated-reports                        — severity: info (ONE rollup insight)
//     Fires when at least one property's most recent PCA is pcaDatedReportYears (5) or more whole years
//     old AND still lists immediate repairs (> $0). Rolled up into a single insight so a handful of
//     old reports cannot flood the digest every run. Because "current" is the newest report we have, a
//     dated report is still USED — this alert says so out loud instead of excluding it.
//
// Severity ceiling is `warning`/`info`: nothing here is ever `critical`, so none of it reaches the
// per-critical alert email path (run.ts diffCriticalAlerts only emails criticals).
//
// A warehouse WITHOUT migration 035 (the table is absent) returns [] — the feature is simply not
// deployed there, which is not a failure. Any other read error propagates: run.ts turns it into a
// visible warning insight rather than silently dropping the evaluation.
//
// PURE reads; DETERMINISTIC (sorted by id). NOT a financial-decision function — no engine math,
// scoring, NOI, or capital-allocation; PCA reserves are capex estimates, never Spine A/B NOI.
import type { WarehouseDb } from './db';
import type { Insight } from '../../src/analytics/types';
import { ALERT_THRESHOLDS } from '../../src/analytics/conditions';
import { slug } from '../../src/contracts/common';
import { fmtUsdCompact } from '../../src/analytics/format';
import { buildPropertyConditionReport } from './property-condition';

const MAX_LISTED = 6;

/** Register labels can carry parentheticals and folder notes ('… (folder labelled …)'); keep the digest line readable. */
function shortName(label: string): string {
  const head = (label.split(/\s+[—(]/)[0] ?? label).trim();
  return head.length <= 40 ? head : `${head.slice(0, 39).trimEnd()}…`;
}

function tableExists(db: WarehouseDb, name: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}

export function propertyConditionConditions(db: WarehouseDb, refDate: string): Insight[] {
  if (!tableExists(db, 'pca_reports')) return [];
  const T = ALERT_THRESHOLDS;
  const report = buildPropertyConditionReport(db, refDate);
  if (!report.loaded) return [];
  const refYear = Number(refDate.slice(0, 4));
  const out: Insight[] = [];

  // ── Condition 1: pca-warranty-* ─────────────────────────────────────────────
  const seenIds = new Map<string, number>();
  for (const a of report.schedule) {
    if (a.warrantyEndYear === null) continue;
    const yearsAhead = a.warrantyEndYear - refYear;
    const upcoming = yearsAhead >= 0 && yearsAhead <= T.pcaWarrantyWarnYears;
    const justLapsed = yearsAhead < 0 && -yearsAhead <= T.pcaWarrantyLapsedYears;
    if (!upcoming && !justLapsed) continue;

    // Two asset facts can share (property, component); keep ids unique and stable by order.
    const base = `pca-warranty-${a.propertyKey}-${slug(a.component)}`;
    const n = (seenIds.get(base) ?? 0) + 1;
    seenIds.set(base, n);

    out.push({
      id: n === 1 ? base : `${base}-${n}`,
      severity: 'warning',
      category: 'capex',
      title: `${upcoming ? 'Warranty ending' : 'Warranty lapsed'} — ${a.propertyLabel} · ${a.component}`,
      detail:
        `${a.warranty ?? 'Warranty'}: stated end year ${a.warrantyEndYear} ` +
        `(${upcoming ? (yearsAhead === 0 ? 'this year' : `${yearsAhead} yr${yearsAhead === 1 ? '' : 's'} out`) : `lapsed ${-yearsAhead} yr ago`}). ` +
        (upcoming
          ? 'Inspect and file any claim before it ends, and confirm whether a renewal term applies.'
          : 'Confirm whether a renewal term applies; the component is now out of warranty.') +
        ' Year-grain: the source states a year, not a date.',
      metric: String(a.warrantyEndYear),
      action: { label: 'Review record', kind: 'review' },
      impactAnnualUsd: null,
      spine: 'B',
      provenance: 'derived',
    });
  }

  // ── Condition 2: pca-dated-reports (one rollup) ─────────────────────────────
  const dated = report.properties
    .filter(
      (p) =>
        p.ageYears !== null &&
        p.ageYears >= T.pcaDatedReportYears &&
        (p.current.immediateUsd ?? 0) > 0,
    )
    .sort((a, b) => (b.current.immediateUsd ?? 0) - (a.current.immediateUsd ?? 0) || a.propertyLabel.localeCompare(b.propertyLabel));

  if (dated.length > 0) {
    const listed = dated
      .slice(0, MAX_LISTED)
      .map((p) => `${shortName(p.propertyLabel)} (${p.ageYears} yrs, ${fmtUsdCompact(p.current.immediateUsd)} immediate)`);
    const more = dated.length > MAX_LISTED ? `; +${dated.length - MAX_LISTED} more` : '';
    out.push({
      id: 'pca-dated-reports',
      severity: 'info',
      category: 'capex',
      title: `Dated PCA on file — ${dated.length} ${dated.length === 1 ? 'property' : 'properties'}`,
      detail:
        `The most recent PCA for ${dated.length === 1 ? 'this property is' : 'these properties is'} ${T.pcaDatedReportYears}+ years old ` +
        `and still lists immediate repairs: ${listed.join('; ')}${more}. It remains the newest report on file, so it is still used — ` +
        'its repairs may already be done or have grown. Order a refresh before relying on its reserves.',
      metric: String(dated.length),
      action: { label: 'Review record', kind: 'review' },
      impactAnnualUsd: null,
      spine: 'B',
      provenance: 'derived',
    });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}
