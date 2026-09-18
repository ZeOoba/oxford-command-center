// src/primitives/Tabs.tsx
//
// Shared underline-strip Tabs primitive (IA decongestion Phase 0 — see
// docs/superpowers/plans/2026-09-18-ia-decongestion-tabs.md). Wraps
// react-aria-components' Tabs/TabList/Tab (locked at 1.18.0 — do not bump) so every
// module gets the W3C APG keyboard pattern for free instead of the 7 hand-rolled,
// non-ARIA pill-button copies this primitive replaces (Phase 1, separate PR).
//
// Visual contract: design_handoff_ora_command_center/app/ora.css:328-334 (`.tabs`/`.tab`/
// `.tab.on`) — an underline strip, not the pill look several modules currently ship.
// Ported using this repo's EXISTING token names (--border-subtle, --accent, --text-primary,
// --text-secondary, --text-tertiary, --font-mono) rather than the handoff's raw --line/--ink
// names, and via RAC's `isSelected` render prop (inline style) rather than a `[data-selected]`
// CSS selector, matching the conditional-inline-style convention already used for tab state in
// src/modules/intel/IntelModule.tsx and for reduced-motion gating in TierBoard.tsx/Sidebar.tsx.
import type { ReactNode } from 'react';
import { Tabs as RACTabs, TabList, Tab, type Key } from 'react-aria-components';
import { cn } from '@/lib/cn';
import { isStill } from '@/lib/stillMode';
import { Badge, type BadgeTone } from './Badge';

/** Mirrors the reduced-motion gate already used in TierBoard.tsx / Sidebar.tsx / useCountUp.ts —
 *  an inline style always outranks a `motion-reduce:*` class, so the flag must be read in JS. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface TabSpec {
  id: string;
  label: string;
  /** R4 — a critical/warning item living in a non-default tab surfaces here so severity
   *  survives tabbing. Count 0 renders nothing; count > 99 caps the label at "99+". */
  badge?: { count: number; tone: BadgeTone };
  /** Tabs sharing a `group` render together; a subtle divider appears where the group
   *  changes (ported from IntelModule's intelligence/data-ops split). Tabs with no group
   *  never get a divider. */
  group?: string;
}

export interface TabsProps {
  tabs: TabSpec[];
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  /** 'automatic' (default, arrow keys move selection immediately) or 'manual' (arrow keys
   *  move focus only; Enter/Space selects) — R9. Use 'manual' for any tab whose panel fires a
   *  warehouse query on selection, so arrowing through the strip doesn't fan out queries. */
  keyboardActivation?: 'automatic' | 'manual';
  'aria-label': string;
  /** Tab panels — typically one or more <TabPanel id="..."> (react-aria-components) children,
   *  one per tab id. Left to the caller so panel-level concerns (shouldForceMount, lazy data
   *  fetching keyed off the panel's own id) stay with the panel, not this primitive. */
  children: ReactNode;
  className?: string;
}

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * Underline-strip tab primitive. Selection state (`selectedKey`) is owned by the caller — pair
 * with `useTabParam` to keep it in the URL (R10), or plain `useState` for ephemeral tab state.
 */
export function Tabs({
  tabs,
  selectedKey,
  onSelectionChange,
  keyboardActivation = 'automatic',
  'aria-label': ariaLabel,
  children,
  className,
}: TabsProps) {
  const reduceMotion = isStill() || prefersReducedMotion();
  const transition = reduceMotion ? 'none' : 'color 120ms, border-color 120ms';

  return (
    <RACTabs
      selectedKey={selectedKey}
      onSelectionChange={(key: Key) => onSelectionChange(String(key))}
      keyboardActivation={keyboardActivation}
      className={cn(className)}
    >
      <TabList
        aria-label={ariaLabel}
        className="flex items-center gap-0.5 overflow-x-auto"
        style={{ borderBottom: '1px solid var(--border-subtle)', marginBottom: '14px' }}
      >
        {tabs.map((t, i) => {
          // NOTE: TabList's children must be Tab elements directly — react-aria-components
          // builds its selection Collection by walking DIRECT children, so wrapping a Tab in a
          // plain host element (e.g. a <span> to co-locate the group divider) silently drops it
          // from the collection and renders an empty tablist. The divider instead renders as a
          // non-selectable sibling via Tab's own `data-` styling hook: each Tab that starts a
          // new group gets a left border standing in for the divider, keeping every child of
          // TabList an actual Tab.
          const prev = tabs[i - 1];
          const startsNewGroup = t.group !== undefined && prev !== undefined && t.group !== prev.group;
          return (
            <Tab
              key={t.id}
              id={t.id}
              className={({ isFocusVisible }) =>
                cn(
                  'num relative flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap py-2.5 pr-3.5 text-2xs font-semibold outline-none',
                  startsNewGroup ? 'ml-3 pl-3.5' : 'pl-3.5',
                  isFocusVisible && 'ring-2 ring-offset-1',
                )
              }
              style={({ isSelected, isHovered, isFocusVisible }) => ({
                color: isSelected
                  ? 'var(--text-primary)'
                  : isHovered
                    ? 'var(--text-secondary)'
                    : 'var(--text-tertiary)',
                borderBottom: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
                borderLeft: startsNewGroup ? '1px solid var(--border-strong)' : undefined,
                marginBottom: '-1px',
                transition,
                ...(isFocusVisible ? { outline: '2px solid var(--accent)', outlineOffset: '2px' } : null),
              })}
            >
              {t.label}
              {t.badge && t.badge.count > 0 && (
                <Badge tone={t.badge.tone}>{formatBadgeCount(t.badge.count)}</Badge>
              )}
            </Tab>
          );
        })}
      </TabList>
      {children}
    </RACTabs>
  );
}

export { TabPanel } from 'react-aria-components';
