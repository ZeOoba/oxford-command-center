import { AlertTriangle, AlertCircle, Info, ArrowRight, Mail } from 'lucide-react';
import type { Insight, InsightSeverity } from '@analytics/index';
import { fmtUsdCompact } from '@analytics/index';
import { Button } from '@/primitives/Button';
import { useUi } from '@/brain/ui-context';
import { insightToDraft } from '@/brain/draft';

const SEV: Record<InsightSeverity, { color: string; Icon: typeof Info }> = {
  critical: { color: 'var(--color-neg)', Icon: AlertCircle },
  warning: { color: 'var(--color-warn)', Icon: AlertTriangle },
  info: { color: 'var(--color-info)', Icon: Info },
};

export function InsightList({ insights }: { insights: Insight[] }) {
  const ui = useUi();
  if (insights.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
        No alerts. Portfolio is clear.
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {insights.map((i) => {
        const { color, Icon } = SEV[i.severity];
        return (
          <li
            key={i.id}
            className="flex items-start gap-3 px-4 py-3"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <span
              className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full"
              style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
            >
              <Icon size={13} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {i.title}
                </span>
                {i.metric && (
                  <span className="num shrink-0 text-2xs font-semibold" style={{ color }}>
                    {i.metric}
                  </span>
                )}
                {i.impactAnnualUsd !== null && Number.isFinite(i.impactAnnualUsd) && i.impactAnnualUsd > 0 && (
                  <span className="num shrink-0 text-2xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    {fmtUsdCompact(i.impactAnnualUsd)}/yr
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                {i.detail}
              </p>
            </div>
            {i.entityType && i.entityId && (
              <div className="flex shrink-0 items-center gap-1 pt-0.5">
                {(() => {
                  const draft = insightToDraft(i);
                  return draft ? (
                    <Button size="sm" variant="ghost" onPress={() => ui.openDraft(draft)}>
                      <Mail size={12} />
                      Draft
                    </Button>
                  ) : null;
                })()}
                <Button size="sm" variant="ghost" onPress={() => ui.openEntity({ type: i.entityType!, id: i.entityId! })}>
                  View
                  <ArrowRight size={12} />
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
