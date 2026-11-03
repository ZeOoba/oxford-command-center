// Signal discipline: which root cause an alert is a symptom of, so many symptoms can roll into one row.
//
// Derived from the insight id in the VIEW layer on purpose: the ids are produced by
// src/analytics/conditions.ts (financial-decision source, refute-gated), and a presentation concern
// should not widen that blast radius. tests/unit/alert-cause.test.ts runs the real generators and
// asserts this mapping against their output, so a renamed id fails a test instead of silently
// un-grouping an alert.
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^lease-expiry-/, 'lease-expiry-no-signal'],
  [/^lease-lapsed-/, 'lease-lapsed'],
  [/^lease-mtm-/, 'lease-mtm'],
  [/^lease-undermarket-/, 'lease-undermarket'],
  [/^expiring-/, 'lease-expiring-soon'],
  [/^expired-/, 'lease-expired'],
  [/^escalation-/, 'escalation-passed'],
  [/^ins-lapsed-/, 'insurance-lapsed'],
  [/^dscr-floor-/, 'dscr-floor'],
  [/^dscr-(?!floor-)/, 'dscr-covenant'],
  // `ltv-governor-*` is an informational governor deviation, not a breach: no cause, never pinned.
  [/^ltv-(?!governor-)/, 'ltv-ceiling'],
  [/^reconcile-fail$/, 'reconcile-fail'],
];

// Causes whose impact is real but cannot be quantified in dollars (a lapsed policy's exposure is
// not its premium; a covenant or reconciliation breach has no honest annual figure). They rank ahead
// of dollar-ranked rows rather than sinking under the null sort and being cut by a surface cap.
// Hygiene alerts (stale workbook, stale AR) are deliberately NOT pinned: they stay on the alert
// board but must not outrank a breach.
const PINNED_CAUSES: ReadonlySet<string> = new Set([
  'insurance-lapsed',
  'dscr-floor',
  'dscr-covenant',
  'ltv-ceiling',
  'reconcile-fail',
]);

export function isPinnedCause(cause: string | undefined): boolean {
  return cause !== undefined && PINNED_CAUSES.has(cause);
}

/** Pinned until acknowledged: a lapsed-coverage alert you have marked read stops claiming #1.
 *  ALERTS BOARD ONLY, by design: read state lives in the alert store (useAlertView) and the Insights
 *  board, Overview widgets and Digest are built from `merged` insights, which carry none. There an
 *  acknowledged lapse stays pinned (isPinnedCause) until the policy is renewed or its status changes. */
export function isPinnedAlert(insight: { id: string }, read: boolean): boolean {
  return !read && isPinnedCause(causeOf(insight));
}

/** A no-signal expiry this close is its own decision, not one of a batch (design review 2026-10-31). */
export const IMMINENT_EXPIRY_DAYS = 7;

/** Splits no-signal expiries within IMMINENT_EXPIRY_DAYS onto their own cause, so a lease ending
 *  today is never folded into a collapsed "expiring ≤90d" group. Every other cause passes through. */
export function imminentCause(cause: string | undefined, daysToAct: number | null): string | undefined {
  return cause === 'lease-expiry-no-signal' && daysToAct !== null && daysToAct <= IMMINENT_EXPIRY_DAYS
    ? 'lease-expiry-imminent'
    : cause;
}

/** "61d" → 61. Any other metric (a ratio, a percentage) is not a day count. */
function daysFromMetric(metric: string | undefined): number | null {
  const match = metric ? /^(-?\d+)d$/.exec(metric) : null;
  return match ? Number(match[1]) : null;
}

/** Cause and days-to-act for one alert row. The single derivation every board uses (Overview,
 *  Insights, Alerts), so a lease ending today is split out — and a band labelled — the same way
 *  everywhere. */
export function causeAndDays(insight: { id: string; metric?: string }): { cause: string | undefined; daysToAct: number | null } {
  const daysToAct = daysFromMetric(insight.metric);
  return { cause: imminentCause(causeOf(insight), daysToAct), daysToAct };
}

export function causeOf(insight: { id: string }): string | undefined {
  for (const [pattern, cause] of RULES) if (pattern.test(insight.id)) return cause;
  return undefined;
}
