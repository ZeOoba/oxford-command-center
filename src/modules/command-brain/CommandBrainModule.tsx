// src/modules/command-brain/CommandBrainModule.tsx
//
// The Command Brain — the honesty-doctrine view over server/warehouse/brain-report.ts's composed
// BrainReport: what the firm's scoring/verdict layer has actually gotten right, how sparse/deep its
// coverage is per cohort, and where it knows it doesn't know. No invented accuracy, memory, or
// confidence figure — every number here traces to a resolved calibration_outcome row or a
// confidence-by-cohort computation, or renders as an explicit "—" gap.
//
// Named 'command-brain' specifically to avoid colliding with src/brain/ — that is a DIFFERENT,
// pre-existing system (client chrome / command-palette). Unrelated code; do not conflate.
//
// On the static mirror / a cold brain server the /brain/report route 503s → useBrainReport surfaces
// isWarehouseUnavailable and the whole module degrades to one informational Card, mirroring
// CalibrationModule's own offline treatment.
import { Gauge } from 'lucide-react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { KpiStat } from '@/primitives/KpiStat';
import { Skeleton } from '@/primitives/Skeleton';
import { Sparkline } from '@/charts/Sparkline';
import { useToast } from '@/primitives/toast-context';
import {
  accuracySegments,
  isWarehouseUnavailable,
  openQuestionSubjectId,
  openQuestionSubjectKind,
  useBrainReport,
  useSubmitFeedback,
  type OpenQuestion,
} from './hooks';
import { MemoryBoard } from './MemoryBoard';
import { TrackRecordList } from './TrackRecordList';

function fmtPct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

function fmtCount(n: number | null): string {
  return n === null || Number.isNaN(n) ? '—' : String(n);
}

function accuracySublabel(
  ci: { lo: number; hi: number } | null,
  overallHitRate: number | null,
  resolvedTotal: number,
): string | undefined {
  if (ci) return `95% CI ${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}%`;
  if (overallHitRate === null) return `${resolvedTotal} resolved outcome${resolvedTotal === 1 ? '' : 's'} — too few to compute a rate`;
  return undefined;
}

function OpenQuestionRow({ q }: { q: OpenQuestion }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{q.title}</div>
      <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{q.detail}</div>
      <div className="text-2xs" style={{ color: 'var(--text-info)' }}>{`→ ${q.wouldClose}`}</div>
    </div>
  );
}

function FeedbackRow({ q }: { q: OpenQuestion }) {
  const { toast } = useToast();
  const feedback = useSubmitFeedback();
  const subjectId = openQuestionSubjectId(q);
  const subjectKind = openQuestionSubjectKind(q.kind);

  const decide = (decision: 'accept' | 'dismiss') => {
    feedback.mutate(
      { subjectKind, subjectId, decision },
      {
        onSuccess: () =>
          toast({ tone: 'success', title: decision === 'accept' ? 'Accepted' : 'Dismissed', description: q.title }),
        onError: (e) =>
          toast({ tone: 'error', title: 'Feedback not recorded', description: e instanceof Error ? e.message : String(e) }),
      },
    );
  };

  return (
    <div className="flex items-start gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{q.title}</div>
        <div className="mt-0.5 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{q.detail}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="subtle" onPress={() => decide('accept')} isDisabled={feedback.isPending}>
          Accept
        </Button>
        <Button size="sm" variant="ghost" onPress={() => decide('dismiss')} isDisabled={feedback.isPending}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function CommandBrainModule() {
  const report = useBrainReport();

  if (isWarehouseUnavailable(report.error)) {
    return (
      <Card>
        <CardHeader title="Command Brain" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <Gauge size={28} style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>The Command Brain requires the live brain server.</div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 440 }}>
            The composed accuracy / track-record / confidence report runs locally alongside the brain
            server. This deployed mirror is read-only and does not include it.
          </div>
        </div>
      </Card>
    );
  }

  if (report.isLoading || !report.data) {
    return <Skeleton style={{ height: 320 }} />;
  }

  const r = report.data;
  const segments = accuracySegments(r.accuracySeries);
  const scoreableMonths = segments.reduce((n, s) => n + s.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Command Brain" trailing={<Badge tone="neutral">advisory only</Badge>} />
        <div className="px-4 py-2.5 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Every figure below traces to a resolved calibration outcome or a confidence-by-cohort
          computation — nothing here is invented. Feedback is display-only: accepting or dismissing a
          question records a decision but never re-weights or re-ranks the scoring engine.
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat
          label="Flag Accuracy"
          value={r.overallHitRate}
          format={fmtPct}
          accentColor="var(--accent)"
          sublabel={accuracySublabel(r.overallCi, r.overallHitRate, r.resolvedTotal)}
        />
        <KpiStat label="Signals Watched" value={r.watchedSignals} format={fmtCount} accentColor="var(--color-info)" />
        <KpiStat
          label="Recalibrations"
          value={r.recalibrations}
          format={fmtCount}
          accentColor="var(--color-pos)"
          sublabel="distinct scoring-config versions"
        />
        <KpiStat label="Resolved Outcomes" value={r.resolvedTotal} format={fmtCount} accentColor="var(--color-accent2)" />
      </div>

      <Card>
        <CardHeader
          title="Flag Accuracy Over Time"
          trailing={<Badge tone="neutral">{`${scoreableMonths} scoreable mo.`}</Badge>}
        />
        <div className="px-4 py-3">
          {segments.length === 0 ? (
            <div className="py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              No scoreable months yet — a month needs at least 5 scoreable verdicts before it plots.
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              {segments.map((seg, i) => (
                <Sparkline key={i} data={seg} width={Math.max(40, seg.length * 14)} height={40} />
              ))}
            </div>
          )}
        </div>
      </Card>

      <TrackRecordList entries={r.trackRecord} />

      <Card>
        <CardHeader title="Feedback" trailing={<Badge tone="neutral">display-only</Badge>} />
        <div className="px-4 pt-2 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Reuses the open questions below as the actionable feed — this report carries no separate
          ranked-insights feed. Accepting or dismissing records a decision; it never changes a score.
        </div>
        {r.openQuestions.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No open questions to act on right now.
          </div>
        ) : (
          <div>
            {r.openQuestions.map((q) => (
              <FeedbackRow key={openQuestionSubjectId(q)} q={q} />
            ))}
          </div>
        )}
      </Card>

      <MemoryBoard confidenceByMarket={r.confidenceByMarket} confidenceByManager={r.confidenceByManager} />

      <Card>
        <CardHeader title="Open Questions" trailing={<Badge tone="neutral">what would sharpen it</Badge>} />
        {r.openQuestions.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No open questions right now.
          </div>
        ) : (
          <div>
            {r.openQuestions.map((q) => (
              <OpenQuestionRow key={openQuestionSubjectId(q)} q={q} />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Version Log"
          trailing={<Badge tone="neutral">{`${r.versionLog.length} event${r.versionLog.length === 1 ? '' : 's'}`}</Badge>}
        />
        {r.versionLog.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No scoring-config changes recorded yet.
          </div>
        ) : (
          <div className="flex flex-col">
            {r.versionLog.map((v, i) => (
              <div
                key={`${v.at}-${i}`}
                className="flex items-center gap-3 px-4 py-2.5"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
              >
                <Badge tone={v.kind === 'config-change' ? 'purple' : 'blue'}>{v.kind}</Badge>
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--text-secondary)' }}>{v.detail}</span>
                <span className="num shrink-0 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{v.at}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
