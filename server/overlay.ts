import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PortfolioSnapshot, Task, DealStage, RenewalStage, CompSet } from '../src/contracts/index';

/**
 * Write-back overlay (Phase 5). The master workbook is canonical and READ-ONLY, so user
 * mutations — deal-stage advances and created tasks — persist to a local JSON overlay and are
 * merged onto each freshly-parsed snapshot. The workbook is never written. The deployed mirror is
 * read-only (no server, no overlay). Decision 2026-06-03: local JSON overlay over Notion/workbook.
 */
export interface Overlay {
  /** dealId → overridden stage. */
  dealStages: Record<string, string>;
  /** User-created tasks (appended to the workbook's checklist). */
  tasks: Task[];
  /** leaseId → renewal pipeline stage. */
  renewalStages: Record<string, RenewalStage>;
  /** tenantId (slug) → free-text note. */
  tenantNotes: Record<string, string>;
  /** dealId → cached AI-sourced comp research. */
  dealComps: Record<string, CompSet>;
}
export const EMPTY_OVERLAY: Overlay = { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {} };

const OVERLAY_PATH = process.env.OVERLAY_PATH ?? join(process.cwd(), 'data', 'overlay.json');

/** Advance path through the pipeline (Refinance/Dead are off-path — set explicitly). */
export const STAGE_FLOW: DealStage[] = ['Sourcing', 'Candidate', 'LOI/PSA', 'Due Diligence', 'Closing', 'Closed'];

export function nextStage(stage: DealStage): DealStage | null {
  const i = STAGE_FLOW.indexOf(stage);
  if (i < 0 || i >= STAGE_FLOW.length - 1) return null;
  return STAGE_FLOW[i + 1]!;
}

export function loadOverlay(): Overlay {
  try {
    if (existsSync(OVERLAY_PATH)) {
      const raw = JSON.parse(readFileSync(OVERLAY_PATH, 'utf8')) as Partial<Overlay>;
      return { dealStages: raw.dealStages ?? {}, tasks: raw.tasks ?? [], renewalStages: raw.renewalStages ?? {}, tenantNotes: raw.tenantNotes ?? {}, dealComps: raw.dealComps ?? {} };
    }
  } catch {
    /* corrupt overlay → start clean */
  }
  return { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {} };
}

export function saveOverlay(o: Overlay): void {
  try {
    mkdirSync(dirname(OVERLAY_PATH), { recursive: true });
    writeFileSync(OVERLAY_PATH, JSON.stringify(o, null, 2));
  } catch {
    /* best-effort */
  }
}

/** Merge user mutations onto a freshly-parsed snapshot. Pure — no I/O. */
export function applyOverlay(s: PortfolioSnapshot, o: Overlay): PortfolioSnapshot {
  const deals = s.deals.map((d) => {
    const stage = o.dealStages[d.id];
    return stage && stage !== d.stage ? { ...d, stage: stage as DealStage } : d;
  });
  const tasks = o.tasks.length ? [...o.tasks, ...s.tasks] : s.tasks;
  return { ...s, deals, tasks, renewalStages: o.renewalStages, tenantNotes: o.tenantNotes, dealComps: o.dealComps };
}
