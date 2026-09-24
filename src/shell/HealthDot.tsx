// TopBar system-health status dot (IA decongestion Phase 4a). System Health left the sidebar rail;
// this is its surface. Reads the same sources HealthModule does (freshness from the brain state,
// the snapshot's data-quality flags, and the shared `/api/health` feeds[] query — 2026-09-23
// review gap #2) and opens /health on press.
import { useSnapshot } from '@/data/queries';
import { useBrain } from '@/data/brain-context';
import { useHealth } from '@/data/health';
import { useUi } from '@/brain/ui-context';
import { computeFreshness } from '@/lib/freshness';
import { computeHealthSignal, type HealthTone } from '@/lib/healthSignal';
import { useNow } from '@/lib/useNow';

const DOT: Record<HealthTone, string> = {
  ok: 'var(--color-pos)',
  warn: 'var(--color-warn)',
  error: 'var(--color-neg)',
  neutral: 'var(--text-tertiary)',
};

export function HealthDot() {
  const { data } = useSnapshot();
  const { state } = useBrain();
  const ui = useUi();
  const healthQuery = useHealth();
  const feeds = healthQuery.data?.feeds ?? [];
  const signal = computeHealthSignal(computeFreshness(state, useNow()), data?.snapshot.dataQuality ?? [], feeds);
  const name = `System health: ${signal.label} — ${signal.detail}`;
  return (
    <button
      onClick={() => ui.setActiveModule('health')}
      aria-label={name}
      title={name}
      data-health-tone={signal.tone}
      className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]"
      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: DOT[signal.tone], boxShadow: signal.tone === 'error' ? `0 0 6px ${DOT.error}` : undefined }} />
    </button>
  );
}
