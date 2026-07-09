import { cn } from '@/lib/cn';
import { Badge, type BadgeTone } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { fmtUsdCompact } from '@analytics/index';

export interface TierItemAction {
  label: string;
  onPress?: () => void;
  href?: string;
}

export interface TierItem {
  id: string;
  rank?: number;
  category?: string;
  categoryTone?: BadgeTone;
  impactUsd?: number | null;
  impactKind?: 'gain' | 'risk' | 'info';
  title: string;
  detail?: string;
  action?: TierItemAction;
  /** Additional actions beyond the single primary `action` (e.g. a read toggle plus two snooze durations). */
  actions?: TierItemAction[];
  chips?: string[];
  /** De-emphasizes the card (e.g. an already-read alert) without removing it from the rank order. */
  muted?: boolean;
}

export interface TierTotal {
  label: string;
  totalUsd: number;
}

export interface Tier {
  key: string;
  title: string;
  subtitle?: string;
  tone: 'neg' | 'warn' | 'info' | 'pos' | 'accent' | 'accent2';
  items: TierItem[];
  totalsBySpine?: TierTotal[];
}

const TONE_COLOR: Record<Tier['tone'], string> = {
  neg: 'var(--color-neg)',
  warn: 'var(--color-warn)',
  info: 'var(--color-info)',
  pos: 'var(--color-pos)',
  accent: 'var(--accent)',
  accent2: 'var(--color-accent2)',
};

const TEXT_TONE_COLOR: Record<Tier['tone'], string> = {
  neg: 'var(--text-neg)',
  warn: 'var(--text-warn)',
  info: 'var(--text-info)',
  pos: 'var(--text-pos)',
  accent: 'var(--text-accent)',
  accent2: 'var(--text-accent2)',
};

// Severity glow — only the "hot" tones glow; cool/flat tones (warn/info/accent2) stay flat.
const TONE_GLOW: Partial<Record<Tier['tone'], string>> = {
  neg: '0 0 8px var(--color-neg)',
  pos: '0 0 8px var(--color-pos)',
  accent: '0 0 8px var(--accent)',
};

/**
 * Reduced-motion gate for the severity glow / hover lift.
 *
 * These effects are set via inline `style`, and an inline style always outranks
 * any class selector (Tailwind v4 adds no `!important`), so a `motion-reduce:*`
 * CLASS cannot suppress them. The repo's CSS `@media (prefers-reduced-motion)`
 * block only zeroes animation/transition *duration*, not a static box-shadow or
 * a transform *value*. So the value itself must be gated in JS — mirroring the
 * codebase's existing pattern of gating an inline style on a JS-computed flag
 * (StatusPill's `isStill()`, Button's `isHovered`). Read at render/interaction
 * time (non-reactive), consistent with `isStill()`.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const IMPACT_COLOR: Record<NonNullable<TierItem['impactKind']>, string> = {
  gain: 'var(--text-pos)',
  risk: 'var(--text-neg)',
  info: 'var(--text-info)',
};

const COLUMN_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};

function formatImpact(item: TierItem): string {
  if (item.impactUsd === null || item.impactUsd === undefined) return '—';
  return fmtUsdCompact(item.impactUsd);
}

function impactColor(kind: TierItem['impactKind']): string {
  return kind ? IMPACT_COLOR[kind] : 'var(--text-secondary)';
}

function allActions(item: TierItem): TierItemAction[] {
  return [...(item.action ? [item.action] : []), ...(item.actions ?? [])];
}

export function TierBoard({ tiers, columns = 3 }: { tiers: Tier[]; columns?: 1 | 2 | 3 | 4 }) {
  return (
    <div
      role="list"
      aria-label="Tier board"
      className={cn('grid items-start gap-3', COLUMN_CLASS[columns], 'max-[920px]:grid-cols-1')}
    >
      {tiers.map((tier) => (
        <div key={tier.key} role="listitem">
          <TierColumn tier={tier} />
        </div>
      ))}
    </div>
  );
}

function TierColumn({ tier }: { tier: Tier }) {
  const color = TONE_COLOR[tier.tone];
  const glow = prefersReducedMotion() ? undefined : TONE_GLOW[tier.tone];
  return (
    <Card as="section" className="overflow-hidden">
      <div
        className="flex items-center gap-2.5 px-4 pt-3.5 pb-3"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: color, boxShadow: glow }}
        />
        <div className="min-w-0">
          <div
            className="num truncate text-2xs font-semibold uppercase"
            style={{ letterSpacing: '0.1em', color: 'var(--text-primary)' }}
          >
            {tier.title}
          </div>
          {tier.subtitle && (
            <div className="num truncate text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              {tier.subtitle}
            </div>
          )}
        </div>
        <span
          className="num ml-auto shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold"
          style={{
            background: 'var(--surface-overlay)',
            border: `1px solid ${TEXT_TONE_COLOR[tier.tone]}`,
            color: TEXT_TONE_COLOR[tier.tone],
          }}
        >
          {tier.items.length}
        </span>
      </div>
      {tier.totalsBySpine && tier.totalsBySpine.length > 0 && (
        <div
          className="flex flex-wrap gap-x-3 gap-y-1 px-4 py-2"
          style={{ background: 'var(--surface-overlay)', borderBottom: '1px solid var(--border-subtle)' }}
        >
          {tier.totalsBySpine.map((t) => (
            <span key={t.label} className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>
              {t.label}:{' '}
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fmtUsdCompact(t.totalUsd)}</span>
            </span>
          ))}
        </div>
      )}
      {tier.items.length === 0 ? (
        <div className="px-4 py-8 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Clear
        </div>
      ) : (
        <ul className="flex flex-col gap-2 p-3">
          {tier.items.map((item) => (
            <TierCard key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function TierCard({ item }: { item: TierItem }) {
  const actions = allActions(item);
  return (
    <li
      className="group rounded-[var(--radius-md)] p-3 transition-[border-color,transform] duration-[120ms]"
      style={{
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border-subtle)',
        opacity: item.muted ? 0.55 : 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'color-mix(in oklab, var(--accent) 45%, transparent)';
        if (!prefersReducedMotion()) e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
        e.currentTarget.style.transform = '';
      }}
    >
      <div className="flex items-center gap-2">
        {item.rank !== undefined && (
          <span className="num text-2xs font-semibold" style={{ color: 'var(--text-tertiary)' }}>
            {`#${item.rank}`}
          </span>
        )}
        {item.category && <Badge tone={item.categoryTone ?? 'neutral'}>{item.category}</Badge>}
        <span className="num ml-auto text-sm font-semibold" style={{ color: impactColor(item.impactKind) }}>
          {formatImpact(item)}
        </span>
      </div>
      <div className="mt-1.5 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        {item.title}
      </div>
      {item.detail && (
        <div className="num mt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          {item.detail}
        </div>
      )}
      {item.chips && item.chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.chips.map((chip) => (
            <Badge key={chip} tone="neutral">
              {chip}
            </Badge>
          ))}
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {actions.map((a) =>
            a.href ? (
              <a
                key={a.label}
                href={a.href}
                className="num text-2xs font-semibold"
                style={{ color: 'var(--text-accent)' }}
              >
                {a.label}
              </a>
            ) : (
              <Button key={a.label} size="sm" variant="ghost" onPress={a.onPress}>
                {a.label}
              </Button>
            ),
          )}
        </div>
      )}
    </li>
  );
}
