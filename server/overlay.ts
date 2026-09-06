import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import type { PortfolioSnapshot, DealStage, TenantArrears } from '../src/contracts/index';
import { Task, RenewalStage, CompSet, AcquisitionInput } from '../src/contracts/index';
import type { LeaseRunAssumptions } from '../src/contracts/lease-run';
import { coerceNonNegMoney } from '../src/lib/money';
import { deriveArBalances } from './ar/derive-ar-balances';

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
  /**
   * Phase 3 — user-supplied market rents for the under-market gap signal (L-4) and rent-forecast
   * renew_at_market scenario. Keyed by leaseId (precedence) or propertyKey. $/SF PSF annual.
   * Overlay-only — no external API is used or planned. Coerced via coerceNonNegMoney on load
   * (negative/junk → 0) to prevent a hand-edited value from fabricating a spurious market-rent.
   */
  marketRents: Record<string, number>;
}
export const EMPTY_OVERLAY: Overlay = { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, tenantArrears: {}, acquisitionInputs: {}, leaseRunAssumptions: {}, marketRents: {} };

// Resolved at CALL time (not module load) so a late process.env.OVERLAY_PATH — set by tests for
// isolation, or by the harness after load-env runs — is honored. Production behavior is unchanged:
// index.ts runs loadEnvFile() before importing this module, so the env value (or the default) is
// identical to the previous module-const at every real call site.
// Exported (refute 2026-07-22 round 3) so a caller that needs to pre-check the file BEFORE calling
// loadOverlay — e.g. scripts/ar-import-headless.ts guarding against an unattended write amplifying a
// corrupt overlay.json into a full reset — resolves the SAME path loadOverlay/saveOverlay use,
// rather than re-deriving (and risking drifting from) the OVERLAY_PATH/default logic.
export function overlayPath(): string {
  return process.env.OVERLAY_PATH ?? join(process.cwd(), 'data', 'overlay.json');
}

/** Result of the pre-flight overlay check — mirrors evaluateAnomalyFloor's discriminated shape so
 *  callers act on data instead of each re-implementing the refusal. */
export type OverlayPrecondition = { refuse: true; reason: string } | { refuse: false };

/**
 * Pre-flight check for any UNATTENDED writer that is about to merge the overlay onto a freshly
 * parsed snapshot (or save the overlay back). Returns a refusal instead of throwing so the caller
 * chooses its own failure mode — process.exit(1) for the CLI writers, throw for ar-import-headless.
 *
 * loadOverlay() deliberately fails OPEN to EMPTY_OVERLAY on anything it cannot read: a defensible
 * default for a UI-driven mutation, and a silent data-loss path for a scheduled writer, since
 * applyOverlay() with an empty overlay ZEROES the enrichment sections (tenantArrears, arBalances,
 * renewalStages, dealComps, marketRents, noiBudgets) in whatever it writes.
 *
 * THREE refusal cases, all of which previously reached loadOverlay() in at least one writer:
 *   1. MISSING file      — added 2026-09-05. The prior guard was `if (existsSync(path)) {...}`, so
 *                          an absent overlay skipped validation entirely and fell straight through
 *                          to the zeroing path. That is exactly what happened when spec v1.7 began
 *                          running `npm run extract` inside a git worktree: data/overlay.json is
 *                          gitignored, `git worktree add` brings tracked files only, and the run
 *                          exited 0 having nulled 44 tenantArrears / 44 arBalances / 2 dealComps /
 *                          1 renewalStages. Only the snapshot task's section-shrink guard caught it.
 *   2. UNPARSEABLE JSON  — a JSON.parse throw.
 *   3. WRONG TOP-LEVEL SHAPE — `null`, `[]`, `0`, `"str"` all parse fine but make loadOverlay()
 *                          fall back to EMPTY_OVERLAY internally, zeroing data via a different
 *                          shape than a parse error.
 *
 * A file containing `{}` is ALLOWED: an empty overlay object is indistinguishable from a legitimate
 * fresh install, and refusing it would leave a first-ever run with no way forward. That is also the
 * documented escape hatch named in the missing-file reason — bootstrapping stays possible, but it
 * must be a deliberate act, not the silent default.
 */
/** Domains whose loss is what "zeroing the snapshot" actually means. Kept as a literal list, not
 *  `Object.keys(EMPTY_OVERLAY)`, so ADDING a domain does not silently widen the emptiness test. */
const ENRICHMENT_DOMAINS = [
  'dealStages', 'tasks', 'renewalStages', 'tenantNotes', 'dealComps',
  'noiBudgets', 'tenantArrears', 'acquisitionInputs', 'marketRents',
] as const;

/** True when every enrichment domain is absent or empty — i.e. merging this overlay is
 *  indistinguishable from merging EMPTY_OVERLAY, which is exactly what zeroes a snapshot. */
function hasNoEnrichment(o: Record<string, unknown>): boolean {
  return ENRICHMENT_DOMAINS.every((k) => {
    const v = o[k];
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v as object).length === 0;
    return false;
  });
}

export function evaluateOverlayPrecondition(
  path: string,
  opts: { expectEnriched?: boolean } = {},
): OverlayPrecondition {
  if (!existsSync(path)) {
    return {
      refuse: true,
      reason:
        `${path} not found — refusing to proceed (would zero enrichment data: tenantArrears, ` +
        `arBalances, renewalStages, dealComps, marketRents, noiBudgets). The overlay is gitignored ` +
        `local state, so a fresh git worktree or clone will NOT have it: copy it in from the live ` +
        `checkout, or point OVERLAY_PATH at it. To bootstrap a genuinely new install on purpose, ` +
        `set ALLOW_EMPTY_OVERLAY=1 to bootstrap a genuinely new install on purpose.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return {
      refuse: true,
      reason: `${path} is corrupt/unparseable — refusing to proceed (would zero enrichment data). Fix or restore it first. (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      refuse: true,
      reason: `${path} is valid JSON but not a valid overlay object — refusing to proceed (would zero enrichment data). Fix or restore it first.`,
    };
  }
  // The residual the missing-file check alone does NOT close: an overlay that is PRESENT and a
  // well-formed object but carries no enrichment merges exactly like EMPTY_OVERLAY and zeroes the
  // snapshot at exit 0 — the 2026-09-05 outcome via a different door. Two realistic ways to get one
  // WITHOUT any operator error: a first server-side saveOverlay() in a fresh checkout writes a
  // near-empty file, and (before this change) the missing-file message told operators to create
  // `{}` by hand — a remedy that re-armed the very failure it was printed to stop.
  //
  // Only the SNAPSHOT writers pass expectEnriched. ar-import-headless and migrate-lease-overlay-ids
  // must NOT: an empty overlay is legitimate on a genuinely first AR sweep, which is about to
  // POPULATE arrears rather than merge them onto a snapshot. Bootstrapping stays possible for both
  // via ALLOW_EMPTY_OVERLAY=1 — deliberate, auditable in the environment, and impossible to reach
  // by accidentally truncating a file.
  if (opts.expectEnriched && process.env.ALLOW_EMPTY_OVERLAY !== '1' && hasNoEnrichment(parsed as Record<string, unknown>)) {
    return {
      refuse: true,
      reason:
        `${path} parses but carries NO enrichment data (every domain empty) — refusing to proceed. ` +
        `Merging it would zero tenantArrears, arBalances, renewalStages, dealComps, marketRents and ` +
        `noiBudgets in the snapshot exactly as a missing overlay would. This is usually a truncated ` +
        `or freshly-bootstrapped overlay, NOT the real one: copy the live checkout's ` +
        `data/overlay.json in, or point OVERLAY_PATH at it. If this install genuinely has no overlay ` +
        `data yet, set ALLOW_EMPTY_OVERLAY=1 to proceed on purpose.`,
    };
  }
  return { refuse: false };
}

/** Advance path through the pipeline (Refinance/Dead are off-path — set explicitly). */
export const STAGE_FLOW: DealStage[] = ['Sourcing', 'Candidate', 'LOI/PSA', 'Due Diligence', 'Closing', 'Closed'];

export function nextStage(stage: DealStage): DealStage | null {
  const i = STAGE_FLOW.indexOf(stage);
  if (i < 0 || i >= STAGE_FLOW.length - 1) return null;
  return STAGE_FLOW[i + 1]!;
}

/** Coerce a raw asOfDate value (JSON round-trips a Date as an ISO string) to a Date, or null when
 *  absent/unparseable — never throws, matching the rest of this loader's fail-safe-salvage style. */
function coerceArrearsDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Coerce a raw sourceFile value to a non-empty string, or null. */
function coerceSourceFile(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Coerce the on-disk tenantArrears map PER BUCKET (via the shared coerceNonNegMoney) so a partial /
 *  hand-edited / legacy / export record yields a contract-valid {d30,d60,d90,d90plus} of non-negative
 *  numbers. overlay.json is the documented QB-AR-export / manual-entry surface (CLAUDE.md §9), NOT
 *  re-parsed through PortfolioSnapshot on the live path, so an AR-aging row legitimately carries a
 *  negative current bucket (a credit) or a currency-formatted string ('$12,500', '1,200.00'). We
 *  SALVAGE per bucket, never drop a balance: dropping the whole record would silently suppress a
 *  co-occurring real 60+ delinquency (refute F3/edges). A non-object record value carries no buckets
 *  and is skipped. The SAME coerceNonNegMoney is the in-memory backstop in conditions.ts, so the
 *  load path and the rule agree on exactly one coercion (no string/number asymmetry).
 *
 *  asOfDate/sourceFile are carried through ONLY when the raw record has the key at all (refute
 *  2026-07-22: this loader used to silently DROP both fields on every load, which erased the headless
 *  AR feed's provenance on the very next overlay save and defeated conditions.ts's staleness gate,
 *  whose `'asOfDate' in r` check requires the key's PRESENCE, not just a non-null value, to
 *  distinguish "Track-B-stamped" from "legacy/manual, never stamped"). Adding the key unconditionally
 *  would wrongly promote every pre-existing legacy record into the stamped bucket on next load. */
function parseArrears(raw: unknown): Record<string, TenantArrears> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, TenantArrears> = {};
  for (const [leaseId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue; // a non-object record value carries no buckets
    const r = v as Record<string, unknown>;
    const entry: TenantArrears = { d30: coerceNonNegMoney(r.d30), d60: coerceNonNegMoney(r.d60), d90: coerceNonNegMoney(r.d90), d90plus: coerceNonNegMoney(r.d90plus) };
    if ('asOfDate' in r) entry.asOfDate = coerceArrearsDate(r.asOfDate);
    if ('sourceFile' in r) entry.sourceFile = coerceSourceFile(r.sourceFile);
    out[leaseId] = entry;
  }
  return out;
}

/** Validate a Record overlay map per entry: KEEP entries that parse against `schema`, DROP (with a
 *  visible warning — never silently) those that do not. overlay.json bypasses Zod on the live path,
 *  so a hand-edited or schema-migrated entry could otherwise crash its consumer (scoring/comps);
 *  failing safe (drop + surface) beats passing malformed data downstream. App-written entries are
 *  valid by construction (the write routes Zod-validate), so this is a no-op for normal data. */
function validRecord<S extends z.ZodTypeAny>(raw: unknown, schema: S, label: string): Record<string, z.infer<S>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, z.infer<S>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = schema.safeParse(v);
    if (r.success) out[k] = r.data;
    else console.warn(`overlay: dropping invalid ${label} entry "${k}" (failed its contract)`);
  }
  return out;
}
/** Keep only string-valued entries (free-text maps: dealStages, tenantNotes). */
function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}
/** Coerce a propertyId→number budget map through the shared money coercer (negative/junk → 0). */
function coerceBudgets(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = coerceNonNegMoney(v);
  return out;
}
/** Keep only entries that parse as a Task; drop+warn the rest. */
function validTasks(raw: unknown): Task[] {
  if (!Array.isArray(raw)) return [];
  const out: Task[] = [];
  for (const t of raw) {
    const r = Task.safeParse(t);
    if (r.success) out.push(r.data);
    else console.warn('overlay: dropping invalid task entry (failed its contract)');
  }
  return out;
}

export function loadOverlay(): Overlay {
  try {
    if (existsSync(overlayPath())) {
      const raw = JSON.parse(readFileSync(overlayPath(), 'utf8')) as Partial<Overlay>;
      // Every overlay map is now coerced/validated on load — overlay.json bypasses Zod on the live
      // path, so this is the one place that closes the bypass class for the whole surface. Numeric
      // money fields go through coerceNonNegMoney (never drop a balance); structured maps are
      // per-entry Zod-validated (drop+warn an invalid entry rather than crash its consumer);
      // free-text maps are string-filtered. leaseRunAssumptions is a partial merged onto spec
      // defaults, so it is validated at the merge site, not here.
      return {
        dealStages: stringRecord(raw.dealStages),
        tasks: validTasks(raw.tasks),
        renewalStages: validRecord(raw.renewalStages, RenewalStage, 'renewalStages'),
        tenantNotes: stringRecord(raw.tenantNotes),
        dealComps: validRecord(raw.dealComps, CompSet, 'dealComps'),
        noiBudgets: coerceBudgets(raw.noiBudgets),
        tenantArrears: parseArrears(raw.tenantArrears),
        acquisitionInputs: validRecord(raw.acquisitionInputs, AcquisitionInput, 'acquisitionInputs'),
        leaseRunAssumptions: raw.leaseRunAssumptions ?? {},
        // Phase 3: market rents — coerce per entry via coerceNonNegMoney (negative/junk → 0).
        // A 0 is treated as "absent" by the consumer (marketRentGaps skips 0 market rents).
        marketRents: coerceBudgets(raw.marketRents),
      };
    }
  } catch {
    /* corrupt overlay → start clean */
  }
  return { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, tenantArrears: {}, acquisitionInputs: {}, leaseRunAssumptions: {}, marketRents: {} };
}

export async function saveOverlay(o: Overlay): Promise<boolean> {
  try {
    const path = overlayPath();
    await mkdir(dirname(path), { recursive: true });
    // Atomic write (temp file + rename), not a direct writeFile: overlay.json is the canonical
    // mutation store for every write-back this module exposes (deal stages, tasks, notes, NOI
    // budgets, tenantArrears, ...). A crash/power-loss mid-write previously left it truncated, and
    // loadOverlay's corrupt-file handling silently resets to a clean/empty overlay on the NEXT load —
    // refute 2026-07-22 round 2/edges: the headless AR feed added an UNATTENDED scheduled writer on
    // this same path, so that failure mode is no longer gated behind a human UI action. A rename is a
    // single filesystem operation on the same volume — either the old file remains intact or the new
    // one is fully in place; there is no truncated-in-between state to observe.
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(o, null, 2));
    await rename(tmp, path);
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
  return { ...s, deals, tasks, renewalStages: o.renewalStages, tenantNotes: o.tenantNotes, dealComps: o.dealComps, noiBudgets: o.noiBudgets, tenantArrears: o.tenantArrears, arBalances: deriveArBalances(s.leases, o.tenantArrears), acquisitionInputs: o.acquisitionInputs, marketRents: o.marketRents };
}
