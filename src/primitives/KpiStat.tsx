import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown, ArrowUpRight } from 'lucide-react';
import type { Provenance as ProvenanceData } from '@contracts/index';
import { useCountUp } from '@/lib/useCountUp';
import { cn } from '@/lib/cn';
import { Card } from './Card';
import { Provenance } from './Provenance';
import { Sparkline } from '@/charts/Sparkline';

interface Props {
  label: string;
  value: number | null;
  format: (n: number | null) => string;
  prov?: ProvenanceData;
  sublabel?: ReactNode;
  delta?: number | null;
  deltaLabel?: string;
  spark?: number[];
  sparkColor?: string;
  accentColor?: string;
  /** Default true. Pass false for exact integer counts that must always equal a figure shown
   *  elsewhere: the count-up shows the previous value until the first animation frame (and
   *  forever when frames are throttled), so a count that changes after mount can read stale. */
  animate?: boolean;
  onPress?: () => void;
  href?: string;
}

// Small corner control used only in the interactive variant. It is a SEPARATE,
// real interactive element (native <button>/<a>) and a SIBLING of — never an
// ancestor of — the Provenance value span, so the card never nests interactive
// content inside interactive content. It sits at reduced opacity AT REST so it
// is discoverable without a hover first, then goes to full opacity when the
// control ITSELF is hovered OR takes keyboard focus (the card carries no hover
// affordance of its own, so the visual signal matches the real click target).
// Deliberately NO `outline-none`: the global `:focus-visible` rule in
// tokens/theme.css supplies the accent focus ring.
const ACTION_CLASS = cn(
  'absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)]',
  'opacity-40 transition-opacity duration-[140ms] motion-reduce:transition-none cursor-pointer',
  'hover:opacity-100 focus-visible:opacity-100',
);

export function KpiStat({
  label,
  value,
  format,
  prov,
  sublabel,
  delta,
  deltaLabel,
  spark,
  sparkColor,
  accentColor = 'var(--accent)',
  animate = true,
  onPress,
  href,
}: Props) {
  const animated = useCountUp(value);
  const display = value === null ? '—' : format(animate ? animated : value);
  const deltaUp = (delta ?? 0) >= 0;
  const interactive = Boolean(onPress || href);

  const body = (
    <div className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-3.5">
      <div className="min-w-0">
        <div
          className="num text-2xs font-semibold uppercase"
          style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}
        >
          {label}
        </div>
        <div
          className="num mt-2 text-2xl font-semibold leading-none"
          style={{ color: 'var(--text-primary)' }}
        >
          {prov ? <Provenance prov={prov}>{display}</Provenance> : display}
        </div>
        {(sublabel || delta != null) && (
          <div className="mt-2 flex items-center gap-2 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {delta != null && (
              <span
                className="num inline-flex items-center gap-0.5 font-semibold"
                style={{ color: deltaUp ? 'var(--text-pos)' : 'var(--text-neg)' }}
              >
                {deltaUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {Math.abs(delta * 100).toFixed(1)}%
              </span>
            )}
            {deltaLabel && <span>{deltaLabel}</span>}
            {sublabel && (
              <span className="truncate" title={typeof sublabel === 'string' ? sublabel : undefined}>
                {sublabel}
              </span>
            )}
          </div>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className={cn('shrink-0 pt-1')}>
          <Sparkline data={spark} label={`${label} trend`} valueFormat={format} color={sparkColor ?? accentColor} />
        </div>
      )}
    </div>
  );

  // Non-interactive: a plain, non-interactive Card — byte-for-byte identical to the
  // rendering before interactive mode existed. Nothing extra is added to the DOM
  // (no corner control, no hover overlay).
  if (!interactive) {
    return <Card className="overflow-hidden">{body}</Card>;
  }

  // Interactive: the Card stays a plain, non-interactive <div> (no role, no
  // tabIndex, no onClick). Clickability lives ONLY in the small corner control,
  // which is a sibling of the Provenance value span — so there is no interactive
  // content nested inside interactive content. The card carries NO hover
  // affordance (no lift, no border tint) — only the corner control signals and
  // is clickable, so the visual affordance matches the real click target.
  const action = href ? (
    <a href={href} aria-label={`View ${label}`} className={ACTION_CLASS} style={{ color: 'var(--accent)' }}>
      <ArrowUpRight size={14} aria-hidden />
    </a>
  ) : (
    <button
      type="button"
      onClick={onPress}
      aria-label={`View ${label}`}
      className={ACTION_CLASS}
      style={{ color: 'var(--accent)' }}
    >
      <ArrowUpRight size={14} aria-hidden />
    </button>
  );

  return (
    <Card className="overflow-hidden">
      {body}
      {action}
    </Card>
  );
}
