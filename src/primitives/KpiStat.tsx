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
  onPress?: () => void;
  href?: string;
}

// Small corner control used only in the interactive variant. It is a SEPARATE,
// real interactive element (native <button>/<a>) and a SIBLING of — never an
// ancestor of — the Provenance value span, so the card never nests interactive
// content inside interactive content. It stays opacity-0 until the card is
// hovered OR the control itself takes keyboard focus, so it is discoverable by
// both mouse and keyboard. Deliberately NO `outline-none`: the global
// `:focus-visible` rule in tokens/theme.css supplies the accent focus ring.
const ACTION_CLASS = cn(
  'absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)]',
  'opacity-0 transition-opacity duration-[140ms] motion-reduce:transition-none cursor-pointer',
  'group-hover:opacity-100 focus-visible:opacity-100',
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
  onPress,
  href,
}: Props) {
  const animated = useCountUp(value);
  const display = value === null ? '—' : format(animated);
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
                style={{ color: deltaUp ? 'var(--color-pos)' : 'var(--color-neg)' }}
              >
                {deltaUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {Math.abs(delta * 100).toFixed(1)}%
              </span>
            )}
            {deltaLabel && <span>{deltaLabel}</span>}
            {sublabel && <span className="truncate">{sublabel}</span>}
          </div>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className={cn('shrink-0 pt-1')}>
          <Sparkline data={spark} color={sparkColor ?? accentColor} />
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
  // content nested inside interactive content. The whole card still lifts and
  // reveals an accent border tint on hover, but purely as a VISUAL affordance
  // (aria-hidden overlay; nothing interactive is attached to the card itself).
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
    <Card
      className={cn(
        'group overflow-hidden transition-transform duration-[140ms] motion-reduce:transition-none',
        'hover:-translate-y-0.5 motion-reduce:hover:translate-y-0',
      )}
    >
      {/* Purely-visual accent border tint on hover. aria-hidden + pointer-events-none
          so it contributes nothing interactive and never intercepts input. Its
          border color is set inline (identical color-mix to the prior interactive
          surface); only its opacity is toggled by group-hover, so it never fights an
          inline style. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[var(--radius-lg)] opacity-0 transition-opacity duration-[140ms] motion-reduce:transition-none group-hover:opacity-100"
        style={{ border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)' }}
      />
      {body}
      {action}
    </Card>
  );
}
