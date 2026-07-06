import { useEffect, useState } from 'react';

export interface GaugeRingProps {
  value: number;
  max?: number;
  label?: string;
  tone?: 'pos' | 'warn' | 'neg' | 'accent';
  size?: number;
}

const TONE_COLOR: Record<NonNullable<GaugeRingProps['tone']>, string> = {
  pos: 'var(--color-pos)',
  warn: 'var(--color-warn)',
  neg: 'var(--color-neg)',
  accent: 'var(--accent)',
};

const STROKE_WIDTH = 10;

function clampRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

function ringGeometry(size: number): { radius: number; circumference: number } {
  const radius = Math.max(0, (size - STROKE_WIDTH) / 2);
  return { radius, circumference: 2 * Math.PI * radius };
}

export function GaugeRing({ value, max = 100, label, tone = 'accent', size = 120 }: GaugeRingProps) {
  const { radius, circumference } = ringGeometry(size);
  const targetOffset = circumference * (1 - clampRatio(value, max));
  const [offset, setOffset] = useState(circumference);

  useEffect(() => {
    setOffset(targetOffset);
  }, [targetOffset]);

  const color = TONE_COLOR[tone];
  const center = size / 2;

  return (
    <div className="inline-flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={label ?? `${Math.round(value)} of ${max}`}
        >
          <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--surface-overlay)" strokeWidth={STROKE_WIDTH} />
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${center} ${center})`}
            style={{ transition: 'stroke-dashoffset var(--dur-slow) var(--ease-out-expo)' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="num font-semibold" style={{ color: 'var(--text-primary)', fontSize: size * 0.28 }}>
            {Math.round(value)}
          </span>
        </div>
      </div>
      {label && (
        <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          {label}
        </span>
      )}
    </div>
  );
}
