import type { DigestItem } from '@/brain/principal-digest';

export function digestSummary(items: DigestItem[]) {
  const critical = items.filter((i) => i.kind === 'insight' && i.rank === 0);
  const signals = (rows: DigestItem[]) => rows.reduce((n, i) => n + (i.signals ?? 1), 0);
  const review = signals(items.filter((i) => i.kind === 'insight' && i.rank !== 0));
  const deals = items.filter((i) => i.kind === 'deal').length;
  const criticalSignals = signals(critical);
  return {
    critical: criticalSignals,
    review,
    deals,
    /** Headline count: signals, never rows — a rolled-up row stands for all of its members. */
    attention: criticalSignals + review + deals,
    top: critical.slice(0, 3),
  };
}
