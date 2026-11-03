// src/modules/command-brain/BrainPanels.tsx
//
// The three report-backed panels of the Brain destination (IA decongestion Phase 4e) — Track record,
// Feedback and Memory — each rendered inside <ReportGate>, which owns the offline / loading gate and the
// disclaimer + KPI strip (Rule G). The JSX is moved verbatim from the former single-module render; every
// figure traces to a resolved calibration outcome or a confidence-by-cohort computation, or renders as an
// explicit "—" gap. Versions is no longer a tab: it is the `?view=versions` SegmentedControl switch inside
// Memory (R5 — no nested tab strips; Brain is capped at 5 tabs).
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { SegmentedControl } from '@/primitives/SegmentedControl';
import { Sparkline } from '@/charts/Sparkline';
import { useTabParam } from '@/lib/useTabParam';
import { useToast } from '@/primitives/toast-context';
import {
  accuracySegments,
  openQuestionSubjectId,
  openQuestionSubjectKind,
  useSubmitFeedback,
  type OpenQuestion,
} from './hooks';
import type { BrainReport } from './ReportGate';
import { MemoryBoard } from './MemoryBoard';
import { TrackRecordList } from './TrackRecordList';

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

export function TrackRecordPanel({ r }: { r: BrainReport }) {
  const segments = accuracySegments(r.accuracySeries);
  const scoreableMonths = segments.reduce((n, s) => n + s.length, 0);

  return (
    <div className="flex flex-col gap-4">
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
                <Sparkline key={i} data={seg} label={`Monthly flag accuracy, segment ${i + 1} of ${segments.length}`} width={Math.max(40, seg.length * 14)} height={40} />
              ))}
            </div>
          )}
        </div>
      </Card>

      <TrackRecordList entries={r.trackRecord} />
    </div>
  );
}

export function FeedbackPanel({ r }: { r: BrainReport }) {
  return (
    <div className="flex flex-col gap-4">
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

      {/* Kept alongside the Feedback list, NOT deleted as a duplicate (R8 check): the two render the same
          openQuestions array but this one carries the `→ wouldClose` line the Feedback row omits. */}
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
    </div>
  );
}

function VersionLog({ r }: { r: BrainReport }) {
  return (
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
  );
}

// R5: the former Versions tab is a view of Memory (`?view=versions`), not a second tab strip.
type MemoryView = 'memory' | 'versions';
const MEMORY_VIEW_KEYS: readonly MemoryView[] = ['memory', 'versions'];
const MEMORY_VIEWS = [
  { value: 'memory', label: 'Memory' },
  { value: 'versions', label: 'Versions' },
] as const;

export function MemoryPanel({ r }: { r: BrainReport }) {
  const [view, setView] = useTabParam<MemoryView>(MEMORY_VIEW_KEYS, 'memory', 'view');

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl options={MEMORY_VIEWS} value={view} onChange={setView} aria-label="Memory views" />
      {view === 'memory' ? (
        <MemoryBoard confidenceByMarket={r.confidenceByMarket} confidenceByManager={r.confidenceByManager} />
      ) : (
        <VersionLog r={r} />
      )}
    </div>
  );
}
