// server/warehouse/anomalies.ts
// Per-property, between consecutive periods, flag the ratified anomaly conditions using
// INTEL_CONFIG (pure, db-free over PeriodMetrics[]). A decline flag fires only when the
// metric DROPS past its threshold (negative growth beyond the cutoff); expense-growth
// fires on positive growth past +15%. Severity scales by how far PAST the threshold the
// move is: m = |move| / threshold; m ≥ critical-mult → critical, ≥ high → high,
// ≥ moderate → moderate, else low. Thresholds/multiples live in INTEL_CONFIG, never here.
import { INTEL_CONFIG, type AnomalySeverity } from './intel-config';
import type { PeriodMetrics } from './metrics';
import { pctChange } from './growth';

export type AnomalyKind =
  | 'expense-growth'
  | 'revenue-decline'
  | 'noi-decline'
  | 'noi-per-sf-decline'
  | 'new-category'
  | 'category-spike';

export interface AnomalyFlag {
  propertyId: string;
  period: string; // the later period of the consecutive pair
  kind: AnomalyKind;
  severity: AnomalySeverity;
  detail: string;
  metricValue: number | null; // the signed move (growth %) or magnitude that triggered it
}

// Categories watched for spikes (cost categories where a jump is materially diagnostic).
const SPIKE_CATEGORIES = ['Taxes', 'Insurance', 'Repairs & Maintenance', 'Utilities'];

/** Severity from a magnitude `move` measured against `threshold` (both positive). */
function severityFor(move: number, threshold: number): AnomalySeverity {
  const { severityMultiples } = INTEL_CONFIG.anomaly;
  if (threshold <= 0) return 'low';
  const m = move / threshold;
  if (m >= severityMultiples.critical) return 'critical';
  if (m >= severityMultiples.high) return 'high';
  if (m >= severityMultiples.moderate) return 'moderate';
  return 'low';
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Walk each property's periods ascending and emit anomaly flags for consecutive pairs. */
export function detectAnomalies(metrics: PeriodMetrics[]): AnomalyFlag[] {
  const groups = new Map<string, PeriodMetrics[]>();
  for (const m of metrics) {
    const arr = groups.get(m.propertyId) ?? [];
    arr.push(m);
    groups.set(m.propertyId, arr);
  }

  const flags: AnomalyFlag[] = [];
  const cfg = INTEL_CONFIG.anomaly;

  for (const series of groups.values()) {
    const sorted = [...series].sort((a, b) => a.period.localeCompare(b.period));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const propertyId = cur.propertyId;
      const period = cur.period;

      // expense-growth: positive opex growth past +expenseGrowthPct
      const expG = pctChange(prev.opex, cur.opex);
      if (expG !== null && expG > cfg.expenseGrowthPct) {
        flags.push({
          propertyId, period, kind: 'expense-growth',
          severity: severityFor(expG, cfg.expenseGrowthPct),
          detail: `Operating expenses grew ${pct(expG)} (>${pct(cfg.expenseGrowthPct)} threshold)`,
          metricValue: expG,
        });
      }

      // revenue-decline: revenue drops past −revenueDeclinePct
      const revG = pctChange(prev.revenue, cur.revenue);
      if (revG !== null && revG < -cfg.revenueDeclinePct) {
        flags.push({
          propertyId, period, kind: 'revenue-decline',
          severity: severityFor(Math.abs(revG), cfg.revenueDeclinePct),
          detail: `Revenue declined ${pct(revG)} (past −${pct(cfg.revenueDeclinePct)} threshold)`,
          metricValue: revG,
        });
      }

      // noi-decline: NOI drops past −noiDeclinePct
      const noiG = pctChange(prev.noi, cur.noi);
      if (noiG !== null && noiG < -cfg.noiDeclinePct) {
        flags.push({
          propertyId, period, kind: 'noi-decline',
          severity: severityFor(Math.abs(noiG), cfg.noiDeclinePct),
          detail: `NOI declined ${pct(noiG)} (past −${pct(cfg.noiDeclinePct)} threshold)`,
          metricValue: noiG,
        });
      }

      // noi-per-sf-decline: NOI/SF drops past −noiPerSfDeclinePct
      const noiSfG = pctChange(prev.noiPerSf, cur.noiPerSf);
      if (noiSfG !== null && noiSfG < -cfg.noiPerSfDeclinePct) {
        flags.push({
          propertyId, period, kind: 'noi-per-sf-decline',
          severity: severityFor(Math.abs(noiSfG), cfg.noiPerSfDeclinePct),
          detail: `NOI per SF declined ${pct(noiSfG)} (past −${pct(cfg.noiPerSfDeclinePct)} threshold)`,
          metricValue: noiSfG,
        });
      }

      // new-category: an opex category present in the later period but absent earlier
      for (const cat of Object.keys(cur.categories)) {
        const wasPresent = Object.prototype.hasOwnProperty.call(prev.categories, cat);
        if (!wasPresent && (cur.categories[cat] ?? 0) !== 0) {
          flags.push({
            propertyId, period, kind: 'new-category',
            severity: 'low',
            detail: `New expense category appeared: ${cat} (${cur.categories[cat]!.toFixed(0)})`,
            metricValue: cur.categories[cat] ?? null,
          });
        }
      }

      // category-spike: a watched cost category grew past +categorySpikePct
      for (const cat of SPIKE_CATEGORIES) {
        const before = prev.categories[cat];
        const after = cur.categories[cat];
        const catG = pctChange(before, after);
        if (catG !== null && catG > cfg.categorySpikePct) {
          flags.push({
            propertyId, period, kind: 'category-spike',
            severity: severityFor(catG, cfg.categorySpikePct),
            detail: `${cat} spiked ${pct(catG)} (>${pct(cfg.categorySpikePct)} threshold)`,
            metricValue: catG,
          });
        }
      }
    }
  }

  return flags;
}
