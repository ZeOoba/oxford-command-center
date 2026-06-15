import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PortfolioSnapshot, Task, DealStage, RenewalStage, CompSet, AcquisitionInput } from '../src/contracts/index';
import type { LeaseRunAssumptions } from '../src/contracts/lease-run';

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
  /** dealId → Acquisition Workbench underwriting inputs. */
  acquisitionInputs: Record<string, AcquisitionInput>;
  /** propertyId → annual NOI budget target (Phase 3 ②). */
  noiBudgets: Record<string, number>;
  /** propertyId → overridden lease-run assumptions (partial; merged onto the spec defaults). */
  leaseRunAssumptions: Record<string, Partial<LeaseRunAssumptions>>;
}
export const EMPTY_OVERLAY: Overlay = { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, acquisitionInputs: {}, leaseRunAssumptions: {} };

// Resolved at CALL time (not module load) so a late process.env.OVERLAY_PATH — set by tests for
// isolation, or by the harness after load-env runs — is honored. Production behavior is unchanged:
// index.ts runs loadEnvFile() before importing this module, so the env value (or the default) is
// identical to the previous module-const at every real call site.
function overlayPath(): string {
  return process.env.OVERLAY_PATH ?? join(process.cwd(), 'data', 'overlay.json');
}

/** Advance path through the pipeline (Refinance/Dead are off-path — set explicitly). */
export const STAGE_FLOW: DealStage[] = ['Sourcing', 'Candidate', 'LOI/PSA', 'Due Diligence', 'Closing', 'Closed'];

export function nextStage(stage: DealStage): DealStage | null {
  const i = STAGE_FLOW.indexOf(stage);
  if (i < 0 || i >= STAGE_FLOW.length - 1) return null;
  return STAGE_FLOW[i + 1]!;
}

export function loadOverlay(): Overlay {
  try {
    if (existsSync(overlayPath())) {
      const raw = JSON.parse(readFileSync(overlayPath(), 'utf8')) as Partial<Overlay>;
      return { dealStages: raw.dealStages ?? {}, tasks: raw.tasks ?? [], renewalStages: raw.renewalStages ?? {}, tenantNotes: raw.tenantNotes ?? {}, dealComps: raw.dealComps ?? {}, noiBudgets: raw.noiBudgets ?? {}, acquisitionInputs: raw.acquisitionInputs ?? {}, leaseRunAssumptions: raw.leaseRunAssumptions ?? {} };
    }
  } catch {
    /* corrupt overlay → start clean */
  }
  return { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, acquisitionInputs: {}, leaseRunAssumptions: {} };
}

export function saveOverlay(o: Overlay): boolean {
  try {
    mkdirSync(dirname(overlayPath()), { recursive: true });
    writeFileSync(overlayPath(), JSON.stringify(o, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist a property's lease-run assumption overrides (confirm-before-write). Merges the patch
 * onto any existing override for the property (so a single field can be edited at a time) and
 * writes the overlay. Returns the resulting partial. Pure of business logic — the engine merges
 * this partial onto the spec defaults. The workbook and warehouse DB are never touched.
 */
export function setLeaseRunAssumptions(
  propertyId: string,
  patch: Partial<LeaseRunAssumptions>,
): Partial<LeaseRunAssumptions> {
  const o = loadOverlay();
  const merged = { ...(o.leaseRunAssumptions[propertyId] ?? {}), ...patch };
  const ok = saveOverlay({ ...o, leaseRunAssumptions: { ...o.leaseRunAssumptions, [propertyId]: merged } });
  if (!ok) throw new Error('Failed to persist overlay');
  return merged;
}

/** Merge user mutations onto a freshly-parsed snapshot. Pure — no I/O. */
export function applyOverlay(s: PortfolioSnapshot, o: Overlay): PortfolioSnapshot {
  const deals = s.deals.map((d) => {
    const stage = o.dealStages[d.id];
    return stage && stage !== d.stage ? { ...d, stage: stage as DealStage } : d;
  });
  const tasks = o.tasks.length ? [...o.tasks, ...s.tasks] : s.tasks;
  return { ...s, deals, tasks, renewalStages: o.renewalStages, tenantNotes: o.tenantNotes, dealComps: o.dealComps, noiBudgets: o.noiBudgets, acquisitionInputs: o.acquisitionInputs };
}
