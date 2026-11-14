// server/warehouse/property-condition-conditions.ts
//
// Server-side Property Condition alert conditions (Phase 3 of
// docs/capital/2026-10-07-pca-capex-ledger-integration-plan.md). Reads the migration-035 ledger through
// buildPropertyConditionReport — the SAME read model the destination renders — so "current" (the most
// recent report per property, no age cutoff) means exactly one thing in the alerts and in the UI. Whether a
// current report's dollars are USED is the separate vintage rule (reportStatus): STALE reports are history.
//
//   pca-warranty-<propertyKey>-r<row_seq>    — severity: warning (one per asset fact)
//     The id is the asset fact's row identity (property_key + row_seq, UNIQUE in migration 035),
//     never a component slug plus an ordinal: an ordinal suffix collides with slugs that already end in '-<n>'
//     and moves to a different fact when SQLite row order changes or a sibling fact leaves the window as the
//     year rolls (read/snooze state would then silently hide the wrong warning). The suffix 'r<digits>' contains
//     no '-', so splitting at the last '-' recovers (propertyKey, row_seq): the mapping is injective.
//     STABILITY LIMIT: row_seq is the fact's position in ONE register version's import. The id is stable only
//     within that register version; a re-import of a revised register can renumber row_seq, so a read/snooze
//     state keyed on the old id may then point at a different fact (or none). Treat ids as per-version.
//     Fires when a warranty END YEAR STATED in the source document is within
//     ALERT_THRESHOLDS.pcaWarrantyWarnYears years ahead of the reference year (inclusive of the
//     reference year itself), or lapsed at most ALERT_THRESHOLDS.pcaWarrantyLapsedYears years behind it.
//     Older lapses are history and stay silent. The warehouse stores end YEARS (asset_facts.warranty_end_year),
//     so the window is year-grain and the detail never gives a day count. ONE month-grain refinement, with
//     no schema change: when the end year IS the reference year, the raw warranty text (asset_facts.warranty,
//     the register's 'Warranty' column, e.g. 'JM 20-yr to 03-2026') is read for a stated end MONTH in that
//     year (statedEndMonth). A month before the reference month means the warranty has already lapsed, so
//     the insight is the just-lapsed one, never 'ending this year … file any claim before it ends'. No
//     parseable month (or two conflicting ones) keeps the year-grain 'this year' behaviour. Ids never change.
//     A warranty with no stated end year never alerts (nothing is derived from install year + a guessed term).
//
//   pca-dated-reports                        — severity: info (ONE rollup insight)
//     Fires when at least one property's most recent PCA is pcaDatedReportYears (5) or more CALENDAR years
//     old (as-of year minus report year — a Dec-2021 report counts as 5 in Jan-2026) AND still lists immediate
//     repairs (> $0). Rolled up into a single insight so a handful of old reports cannot flood the digest every
//     run. A report that is STALE under the ONE vintage rule (pca-intelligence.ts reportStatus: pre-2024,
//     undated, or flagged stale) is history: its dollars feed neither the destination's totals nor the
//     capital-allocation improve gate, and the detail says so per listed property.
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
import { fmtUsdCompact } from '../../src/analytics/format';
import { buildPropertyConditionReport } from './property-condition';
import { byCode, reportStatus } from '../../src/analytics/pca-intelligence';

const MAX_LISTED = 6;

/** Register labels can carry parentheticals and folder notes ('… (folder labelled …)'); keep the digest line readable. */
function shortName(label: string): string {
  const head = (label.split(/\s+[—(]/)[0] ?? label).trim();
  return head.length <= 40 ? head : `${head.slice(0, 39).trimEnd()}…`;
}

function tableExists(db: WarehouseDb, name: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The END MONTH (1-12) stated in raw warranty text for the given end year, or null when none is stated
 * or the text is ambiguous. Formats: 'MM-YYYY' / 'MM/YYYY' / 'M/YYYY' (the register's 'to 12-2037',
 * 'Exp. 03/2026'), ISO 'YYYY-MM' (optionally '-DD'), and a month name or 3-letter abbreviation before the
 * year ('March 2026', 'Mar. 2026', 'Sept 2026', 'Mar-2026'). Only mentions in the stated end year count, and
 * when the text has a 'to' clause (the importer reads the end year from the first one) only the text from
 * there on is read, so a start date ('from 10/2022 to 10/2026') is never mistaken for the end. Two different
 * months for the end year → null (year-grain fallback), never a guess.
 */
export function statedEndMonth(warranty: string | null, endYear: number): number | null {
  if (warranty === null) return null;
  const to = /\bto\b/i.exec(warranty);
  const text = to ? warranty.slice(to.index) : warranty;
  const found = new Set<number>();
  const add = (month: number, year: number): void => {
    if (year === endYear && Number.isInteger(month) && month >= 1 && month <= 12) found.add(month);
  };
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})[-/.]((?:19|20)\d{2})(?![\d/-])/g)) add(Number(m[1]), Number(m[2]));
  for (const m of text.matchAll(/(?<![\d/.-])((?:19|20)\d{2})-(\d{1,2})(?:-\d{1,2})?(?![\d/-])/g)) add(Number(m[2]), Number(m[1]));
  for (const m of text.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?[\s,-]*((?:19|20)\d{2})(?!\d)/gi)) {
    add(MONTHS.indexOf((m[1] ?? '').slice(0, 3).toLowerCase() as (typeof MONTHS)[number]) + 1, Number(m[2]));
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

export function propertyConditionConditions(db: WarehouseDb, refDate: string): Insight[] {
  if (!tableExists(db, 'pca_reports')) return [];
  const T = ALERT_THRESHOLDS;
  const report = buildPropertyConditionReport(db, refDate);
  if (!report.loaded) return [];
  const refYear = Number(refDate.slice(0, 4));
  const refMonth = Number(refDate.slice(5, 7)); // NaN for a year-only refDate → month refinement never applies
  const out: Insight[] = [];

  // ── Condition 1: pca-warranty-* ─────────────────────────────────────────────
  // Read the facts with their row identity (row_seq is not part of the read model's schedule contract). The
  // warranty columns are the same raw values the read model's schedule shows.
  const facts = db
    .prepare('SELECT property_key, property_label, component, warranty, warranty_end_year, row_seq FROM asset_facts WHERE warranty_end_year IS NOT NULL')
    .all() as Array<{
    property_key: string; property_label: string; component: string; warranty: string | null; warranty_end_year: number; row_seq: number;
  }>;
  for (const f of facts) {
    const a = { propertyKey: f.property_key, propertyLabel: f.property_label, component: f.component, warranty: f.warranty, warrantyEndYear: f.warranty_end_year };
    const yearsAhead = a.warrantyEndYear - refYear;
    // Month-grain only inside the reference year, and only when the raw text states the month.
    const endMonth = yearsAhead === 0 && refMonth >= 1 && refMonth <= 12 ? statedEndMonth(a.warranty, a.warrantyEndYear) : null;
    const lapsedThisYear = endMonth !== null && endMonth < refMonth;
    const upcoming = yearsAhead >= 0 && yearsAhead <= T.pcaWarrantyWarnYears && !lapsedThisYear;
    const justLapsed = lapsedThisYear || (yearsAhead < 0 && -yearsAhead <= T.pcaWarrantyLapsedYears);
    if (!upcoming && !justLapsed) continue;
    const stated = endMonth !== null ? `stated end ${MONTH_NAMES[endMonth - 1]} ${a.warrantyEndYear}` : `stated end year ${a.warrantyEndYear}`;
    const when = upcoming
      ? yearsAhead === 0 ? 'this year' : `${yearsAhead} yr${yearsAhead === 1 ? '' : 's'} out`
      : lapsedThisYear ? 'lapsed earlier this year' : `lapsed ${-yearsAhead} yr ago`;

    out.push({
      // Stable only within one register version: a revised register's re-import may renumber row_seq (see header).
      id: `pca-warranty-${a.propertyKey}-r${f.row_seq}`,
      severity: 'warning',
      category: 'capex',
      title: `${upcoming ? 'Warranty ending' : 'Warranty lapsed'} — ${a.propertyLabel} · ${a.component}`,
      detail:
        `${a.warranty ?? 'Warranty'}: ${stated} (${when}). ` +
        (upcoming
          ? 'Inspect and file any claim before it ends, and confirm whether a renewal term applies.'
          : 'Confirm whether a renewal term applies; the component is now out of warranty.') +
        (endMonth !== null ? ' Month-grain: the source states a month, not a date.' : ' Year-grain: the source states a year, not a date.'),
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
    .sort((a, b) => (b.current.immediateUsd ?? 0) - (a.current.immediateUsd ?? 0) || byCode(a.propertyLabel, b.propertyLabel) || byCode(a.propertyKey, b.propertyKey));

  if (dated.length > 0) {
    const listed = dated
      .slice(0, MAX_LISTED)
      .map(
        (p) =>
          `${shortName(p.propertyLabel)} (${p.ageYears} yrs, ${fmtUsdCompact(p.current.immediateUsd)} immediate` +
          `${reportStatus(p.current) === 'STALE' ? ', history only' : ''})`,
      );
    const staleCount = dated.filter((p) => reportStatus(p.current) === 'STALE').length;
    const more = dated.length > MAX_LISTED ? `; +${dated.length - MAX_LISTED} more` : '';
    out.push({
      id: 'pca-dated-reports',
      severity: 'info',
      category: 'capex',
      title: `Dated PCA on file — ${dated.length} ${dated.length === 1 ? 'property' : 'properties'}`,
      detail:
        `The most recent PCA for ${dated.length === 1 ? 'this property is' : 'these properties is'} ${T.pcaDatedReportYears}+ calendar years old ` +
        `and still lists immediate repairs: ${listed.join('; ')}${more}. ` +
        (staleCount === dated.length
          ? 'Each is stale (dated before 2024, undated, or flagged stale), so it is history only: its dollars feed neither the repair totals nor the capital-allocation improve gate. '
          : staleCount > 0
            ? 'Reports marked "history only" are stale and feed neither the repair totals nor the improve gate; the others are still used. '
            : 'It remains the newest usable report on file, so it is still used. ') +
        'Its repairs may already be done or have grown. Order a refresh before relying on it.',
      metric: String(dated.length),
      action: { label: 'Review record', kind: 'review' },
      impactAnnualUsd: null,
      spine: 'B',
      provenance: 'derived',
    });
  }

  return out.sort((a, b) => byCode(a.id, b.id));
}
