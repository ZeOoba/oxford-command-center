// src/modules/property-financials/components.tsx
//
// Small shared pieces of the Property Financials views: severity pill (icon + label, never colour
// alone), the n/m cell with its reason on hover / focus, and the module's honest empty state.
import type { ReactNode } from 'react';
import type { PfInsight } from '@contracts/property-financials';
import { NM } from '@analytics/property-financials/format';
import type { MetricResult } from '@analytics/property-financials/periods';

const SEVERITY_ICON_NAME: Readonly<Record<PfInsight['severity'], string>> = {
  High: 'filled circle',
  Medium: 'diamond',
  Low: 'hollow circle',
};

/** High = filled circle, Medium = diamond, Low = hollow circle (CSS ::before) + the label. */
export function SeverityPill({ severity }: { severity: PfInsight['severity'] }) {
  return (
    <span className={`pf-pill ${severity}`} data-icon={SEVERITY_ICON_NAME[severity]} title={`${severity} severity`}>
      {severity}
    </span>
  );
}

/** "n/m" with the refusal reason as a tooltip and accessible name. */
export function NotMeaningful({ reason }: { reason: string }) {
  return (
    <span className="pf-nm" title={reason} aria-label={`not meaningful: ${reason}`} tabIndex={0}>
      {NM}
    </span>
  );
}

/** A MetricResult cell: the formatted value, or n/m with its reason. */
export function MetricCell({ result, format, className }: { result: MetricResult; format: (v: number) => string; className?: (v: number) => string }) {
  if (result.value === null) return <NotMeaningful reason={result.reason} />;
  return <span className={className?.(result.value)}>{format(result.value)}</span>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pf-empty" role="status">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
