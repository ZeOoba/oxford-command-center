import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PortfolioSnapshot, Task, DealStage, RenewalStage, CompSet, AcquisitionInput, TenantArrears } from '../src/contracts/index';
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
  /** leaseId → AR aging buckets (audit Fix #2 — collections monitoring). */
  tenantArrears: Record<string, TenantArrears>;
  /** propertyId → overridden lease-run assumptions (partial; merged onto the spec defaults). */
  leaseRunAssumptions: Record<string, Partial<LeaseRunAssumptions>>;
}
export const EMPTY_OVERLAY: Overlay = { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, tenantArrears: {}, acquisitionInputs: {}, leaseRunAssumptions: {} };

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

/** Coerce the on-disk tenantArrears map PER BUCKET so a partial / hand-edited / legacy / export
 *  record yields a contract-valid {d30,d60,d90,d90plus} of non-negative numbers. overlay.json is the
 *  documented QB-AR-export / manual-entry surface (CLAUDE.md §9) and is NOT re-parsed through
 *  PortfolioSnapshot on the live path, so a real AR-aging row legitimately carries a negative current
 *  bucket (an unapplied credit/prepayment) or a numeric-string amount from a CSV export. We SALVAGE,
 *  never drop a balance: `TenantArrears.safeParse`-then-drop would discard such a row whole and
 *  silently suppress a co-occurring real 60+ delinquency — the exact failure F3 set out to kill
 *  (refute F3/edges). A real positive number (or numeric string) survives; a negative / non-finite /
 *  non-numeric bucket zeroes; only a non-object record value is skipped entirely. The matching
 *  defense-in-depth lives in conditions.ts `num()`. Other overlay maps keep tolerant passthrough. */
function arrearsBucket(v: unknown): number {
  // Strings arrive from a hand-edit or a pasted QB/Excel/CSV AR-aging export, which render money WITH
  // a currency symbol, thousands separators, and accounting parens for a credit ('$12,500',
  // '1,200.00', '(500)'). Normalize those BEFORE Number() so a real balance is salvaged, not silently
  // zeroed — a bare Number('12,500') is NaN, which would re-introduce the F3 suppression for the
  // commonest export format (refute edges). Parens → negative → clamped to 0 (a credit is not a
  // past-due balance). Truly non-numeric junk ('n/a') still → 0.
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const s = v.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
    n = s === '' ? NaN : Number(s);
  } else {
    n = NaN;
  }
  return Number.isFinite(n) && n > 0 ? n : 0; // negative / credit / NaN / non-numeric → 0; never negative
}
function parseArrears(raw: unknown): Record<string, TenantArrears> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, TenantArrears> = {};
  for (const [leaseId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue; // a non-object record value carries no buckets
    const r = v as Record<string, unknown>;
    out[leaseId] = { d30: arrearsBucket(r.d30), d60: arrearsBucket(r.d60), d90: arrearsBucket(r.d90), d90plus: arrearsBucket(r.d90plus) };
  }
  return out;
}

export function loadOverlay(): Overlay {
  try {
    if (existsSync(overlayPath())) {
      const raw = JSON.parse(readFileSync(overlayPath(), 'utf8')) as Partial<Overlay>;
      return { dealStages: raw.dealStages ?? {}, tasks: raw.tasks ?? [], renewalStages: raw.renewalStages ?? {}, tenantNotes: raw.tenantNotes ?? {}, dealComps: raw.dealComps ?? {}, noiBudgets: raw.noiBudgets ?? {}, tenantArrears: parseArrears(raw.tenantArrears), acquisitionInputs: raw.acquisitionInputs ?? {}, leaseRunAssumptions: raw.leaseRunAssumptions ?? {} };
    }
  } catch {
    /* corrupt overlay → start clean */
  }
  return { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, tenantArrears: {}, acquisitionInputs: {}, leaseRunAssumptions: {} };
}

export async function saveOverlay(o: Overlay): Promise<boolean> {
  try {
    await mkdir(dirname(overlayPath()), { recursive: true });
    await writeFile(overlayPath(), JSON.stringify(o, null, 2));
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
export async function setLeaseRunAssumptions(
  propertyId: string,
  patch: Partial<LeaseRunAssumptions>,
): Promise<Partial<LeaseRunAssumptions>> {
  const o = loadOverlay();
  const merged = { ...(o.leaseRunAssumptions[propertyId] ?? {}), ...patch };
  const ok = await saveOverlay({ ...o, leaseRunAssumptions: { ...o.leaseRunAssumptions, [propertyId]: merged } });
  if (!ok) throw new Error(`Failed to persist overlay for property ${propertyId}`);
  return merged;
}

/** Merge user mutations onto a freshly-parsed snapshot. Pure — no I/O. */
export function applyOverlay(s: PortfolioSnapshot, o: Overlay): PortfolioSnapshot {
  const deals = s.deals.map((d) => {
    const stage = o.dealStages[d.id];
    return stage && stage !== d.stage ? { ...d, stage: stage as DealStage } : d;
  });
  const tasks = o.tasks.length ? [...o.tasks, ...s.tasks] : s.tasks;
  return { ...s, deals, tasks, renewalStages: o.renewalStages, tenantNotes: o.tenantNotes, dealComps: o.dealComps, noiBudgets: o.noiBudgets, tenantArrears: o.tenantArrears, acquisitionInputs: o.acquisitionInputs };
}
