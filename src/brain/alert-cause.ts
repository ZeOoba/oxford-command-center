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
];

// Causes whose impact is real but cannot be quantified in dollars (a lapsed policy's exposure is
// not its premium). They rank ahead of dollar-ranked rows rather than sinking under the null sort.
const PINNED_CAUSES: ReadonlySet<string> = new Set(['insurance-lapsed']);

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

export function causeOf(insight: { id: string }): string | undefined {
  for (const [pattern, cause] of RULES) if (pattern.test(insight.id)) return cause;
  return undefined;
}
