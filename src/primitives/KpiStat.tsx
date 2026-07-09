import type { ReactNode, MouseEventHandler } from 'react';
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

  const content = (
    <>
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
      {interactive && (
        <ArrowUpRight
          size={13}
          aria-hidden
          className="absolute right-2.5 top-2.5 opacity-0 transition-opacity duration-[140ms] motion-reduce:transition-none group-hover:opacity-100"
          style={{ color: 'var(--accent)' }}
        />
      )}
    </>
  );

  if (!interactive) {
    return <Card className="overflow-hidden">{content}</Card>;
  }

  // Card is intentionally non-polymorphic: its `as` prop is typed
  // 'div' | 'section' | 'article' and it forwards no href/onClick/mouse/style
  // props to the rendered element. So the interactive variant renders a native
  // <a>/<button> (real link/button semantics) and replicates Card's base
  // surface styling here. The border starts transparent and animates to accent
  // on hover — set inline so it wins over any class-level border. See
  // .superpowers/sdd/task-4-report.md for the full rationale.
  const surfaceClass = cn(
    'group relative block w-full overflow-hidden rounded-[var(--radius-lg)] p-0 text-left appearance-none',
    'transition-[transform,border-color] duration-[140ms] motion-reduce:transition-none',
    'hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 cursor-pointer',
  );
  const surfaceStyle = {
    background: 'var(--surface-raised)',
    boxShadow: 'var(--shadow-card)',
    border: '1px solid transparent',
  } as const;
  const onMouseEnter: MouseEventHandler<HTMLElement> = (e) => {
    e.currentTarget.style.borderColor = 'color-mix(in oklab, var(--accent) 45%, transparent)';
  };
  const onMouseLeave: MouseEventHandler<HTMLElement> = (e) => {
    e.currentTarget.style.borderColor = 'transparent';
  };

  return href ? (
    <a
      href={href}
      className={surfaceClass}
      style={surfaceStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {content}
    </a>
  ) : (
    <button
      type="button"
      onClick={onPress}
      className={surfaceClass}
      style={surfaceStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {content}
    </button>
  );
}
