// src/shell/tab-types.ts
//
// Types + the house tab-cap for the two-level module registry (IA decongestion Phase 4a — see
// docs/superpowers/plans/2026-09-18-ia-decongestion-tabs.md §2b). Deliberately React-lazy-free so
// tab declarations (`src/modules/*/tabs.ts`) and the alias table can import it without dragging
// the module registry (and every lazy chunk) into a cycle.
import type { ComponentType } from 'react';
import type { BadgeTone } from '@/primitives/Badge';

/** House rule: a destination declares at most this many tabs (no primary-source basis — a
 *  geometric/readability convention; see plan §1 R6 and §2b correction 6). */
export const MAX_TABS_PER_DESTINATION = 5;

export interface TabBadge {
  count: number;
  tone: BadgeTone;
  /** What the count counts ("critical alerts"), for hover and assistive text. Several attention counts
   *  share the screen and each counts a different population (design review 2026-10-31, finding 5). */
  noun?: string;
}

export interface ModuleTabDef {
  /** The `?tab=` value. Stable — it is a shareable deep link. */
  id: string;
  label: string;
  /** Extra palette search terms — typically the legacy rail label this tab absorbed
   *  ("Tasks" for Worklist > Today) so an absorbed module stays findable via ⌘K. */
  aliases?: readonly string[];
  /** The panel body for destinations composed of existing modules (`<Destination>`).
   *  Omitted when the destination component renders its own panels (Financials, Data). */
  Component?: ComponentType;
  /** R4 badge source — a hook over data the module/AlertBell ALREADY fetch (never a new query).
   *  Called once per render in a fixed order, so it must be a module-level constant. */
  useBadge?: () => TabBadge | undefined;
}

/** Returns a human-readable violation, or null when the tab list is within the house cap. */
export function tabCapViolation(destinationId: string, tabs: readonly ModuleTabDef[] | undefined): string | null {
  if (!tabs || tabs.length <= MAX_TABS_PER_DESTINATION) return null;
  return `Destination "${destinationId}" declares ${tabs.length} tabs; the house cap is ${MAX_TABS_PER_DESTINATION}.`;
}

/** Dev-only guard (never throws, never runs in production builds). */
export function warnIfTooManyTabs(destinationId: string, tabs: readonly ModuleTabDef[] | undefined): void {
  // Cast: this repo's tsconfig doesn't load vite/client types; Vite still replaces `import.meta.env`.
  if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return;
  const msg = tabCapViolation(destinationId, tabs);
  if (msg) console.warn(`[tabs] ${msg}`);
}
