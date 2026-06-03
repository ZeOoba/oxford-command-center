import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
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
}: Props) {
  const animated = useCountUp(value);
  const display = value === null ? '—' : format(animated);
  const deltaUp = (delta ?? 0) >= 0;

  return (
    <Card className="overflow-hidden">
      <span aria-hidden className="absolute left-0 top-0 h-full w-[3px]" style={{ background: accentColor, opacity: 0.85 }} />
      <div className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-3.5 pl-5">
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
    </Card>
  );
}
