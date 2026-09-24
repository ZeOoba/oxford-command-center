import type { DigestItem } from '@/brain/principal-digest';

export function digestSummary(items: DigestItem[]) {
  const critical = items.filter((i) => i.kind === 'insight' && i.rank === 0);
  return {
    critical: critical.length,
    review: items.filter((i) => i.kind === 'insight' && i.rank !== 0).length,
    deals: items.filter((i) => i.kind === 'deal').length,
    top: critical.slice(0, 3),
  };
}
