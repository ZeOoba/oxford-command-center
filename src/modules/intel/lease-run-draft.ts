// src/modules/intel/lease-run-draft.ts
//
// Lease-run assumption editor input check (review round 3, 2026-11-24). Kept out of the component
// file so fast refresh keeps working.
import { LEASE_RUN_INPUT_BOUNDS } from '@contracts/lease-run';

/**
 * Validate one assumption draft (review round 3). Percent/rate fields are typed as percent points,
 * the roof reserve as $/SF. Returns the value to write (a fraction for rates) or a plain-words reason.
 */
export function checkAssumptionDraft(key: string, draft: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = draft.trim();
  if (!text) return { ok: false, message: 'Enter a value. A blank box is not saved as 0.' };
  const raw = Number(text);
  if (!Number.isFinite(raw)) return { ok: false, message: 'Enter a number.' };
  const isPct = key !== 'roofStructuralReservePsf';
  const value = isPct ? raw / 100 : raw;
  const b = (LEASE_RUN_INPUT_BOUNDS as Record<string, { min: number; max: number }>)[key];
  if (b && (value < b.min || value > b.max)) {
    const fmt = (n: number) => (isPct ? `${+(n * 100).toFixed(2)}%` : `$${n.toFixed(2)}/SF`);
    return { ok: false, message: `Enter a value between ${fmt(b.min)} and ${fmt(b.max)}.` };
  }
  return { ok: true, value };
}
