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

export function causeOf(insight: { id: string }): string | undefined {
  for (const [pattern, cause] of RULES) if (pattern.test(insight.id)) return cause;
  return undefined;
}
