// server/property-financials/status-store.ts
//
// Per-insight workflow store for the Property Financials module (plan T4): who owns an insight, when
// it is due, and where it stands (open → in_progress → resolved | dismissed, with a required reason
// for a dismissal). The dataset's insights[] are read-only source data; this file is the ONLY thing
// the module writes, and it lives OUTSIDE the dataset directory (config.ts
// propertyFinancialsStatusPath(), default data/property-financials-status.json, gitignored like
// data/overlay.json). It never writes dataset.json or monthly-long.csv.
//
// Write discipline:
//   - read-modify-write is fully synchronous, so two requests in the one Brain Server process can
//     never interleave (the event loop runs each to completion);
//   - each write goes to a unique temp file then renameSyncWithRetry (server/lib/rename-retry.ts,
//     the repo's Windows AV/indexer-safe publish), so a reader or a crash never sees a partial file;
//   - a corrupt or schema-invalid store FAILS LOUD (StatusStoreCorruptError) and is never overwritten
//     — silently resetting would erase every owner/due date (cf. server/brief/state.ts).
// Known limit: two separate PROCESSES writing at the same instant can lose one update (last rename
// wins); the file itself stays valid. Only the Brain Server writes this file.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { renameSyncWithRetry } from '../lib/rename-retry';

export const PF_INSIGHT_STATUSES = ['open', 'in_progress', 'resolved', 'dismissed'] as const;
export type PfInsightStatus = (typeof PF_INSIGHT_STATUSES)[number];

/** Insight ids as the contract defines them (PfInsight.id). */
export const INSIGHT_ID_RE = /^[A-Z]+-\d+$/;

/** A real calendar date: `YYYY-MM-DD` that round-trips through Date (rejects 2026-02-30). */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a real calendar date');

const Owner = z.string().trim().min(1).max(80);
const Reason = z.string().trim().min(1).max(500);

function dismissRule(v: { status: PfInsightStatus; dismissReason?: string | null }, ctx: z.RefinementCtx): void {
  const has = v.dismissReason !== undefined && v.dismissReason !== null;
  if (v.status === 'dismissed' && !has) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dismissReason'], message: 'required when status is dismissed' });
  }
  if (v.status !== 'dismissed' && has) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dismissReason'], message: 'only allowed when status is dismissed' });
  }
}

/** PUT body. Strict: an unknown key is rejected, not stripped. */
export const InsightStatusInput = z
  .object({
    owner: Owner.nullable(),
    dueDate: IsoDate.nullable(),
    status: z.enum(PF_INSIGHT_STATUSES),
    dismissReason: Reason.nullable().optional(),
  })
  .strict()
  .superRefine(dismissRule);
export type InsightStatusInput = z.input<typeof InsightStatusInput>;

export const InsightStatusRecord = z
  .object({
    insightId: z.string().regex(INSIGHT_ID_RE),
    owner: Owner.nullable(),
    dueDate: IsoDate.nullable(),
    status: z.enum(PF_INSIGHT_STATUSES),
    dismissReason: Reason.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(dismissRule);
export type InsightStatusRecord = z.infer<typeof InsightStatusRecord>;

const StoreFile = z
  .object({
    version: z.literal(1),
    records: z.record(z.string().regex(INSIGHT_ID_RE), InsightStatusRecord),
  })
  .strict()
  .refine((f) => Object.entries(f.records).every(([k, r]) => r.insightId === k), 'record key must equal insightId');
type StoreFile = z.infer<typeof StoreFile>;

/** The store exists but cannot be trusted. Fixed message: no path, no file content. */
export class StatusStoreCorruptError extends Error {
  constructor() {
    super('insight status store is unreadable or invalid');
    this.name = 'StatusStoreCorruptError';
  }
}

function errCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null;
}

function readStore(path: string): StoreFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { version: 1, records: {} };
    throw e; // transient lock etc.: says nothing about content — propagate (→ 500), never reset
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StatusStoreCorruptError();
  }
  const parsed = StoreFile.safeParse(json);
  if (!parsed.success) throw new StatusStoreCorruptError();
  return parsed.data;
}

function writeStore(path: string, store: StoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
    renameSyncWithRetry(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Every stored record keyed by insight id ({} when the store does not exist yet). */
export function readInsightStatuses(path: string): Record<string, InsightStatusRecord> {
  return readStore(path).records;
}

export type PutInsightStatusResult =
  | { ok: true; record: InsightStatusRecord }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid'; issues: string[] };

/**
 * Validate and persist one insight's workflow state. `knownIds` is the loaded dataset's insights[]
 * id set: an id outside it is `not_found` and nothing is written. Issues carry Zod path + code only.
 */
export function putInsightStatus(
  path: string,
  insightId: string,
  body: unknown,
  knownIds: ReadonlySet<string>,
  now: Date,
): PutInsightStatusResult {
  if (!INSIGHT_ID_RE.test(insightId) || !knownIds.has(insightId)) return { ok: false, reason: 'not_found' };
  const parsed = InsightStatusInput.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`) };
  }
  const store = readStore(path);
  const record: InsightStatusRecord = {
    insightId,
    owner: parsed.data.owner,
    dueDate: parsed.data.dueDate,
    status: parsed.data.status,
    dismissReason: parsed.data.dismissReason ?? null,
    updatedAt: now.toISOString(),
  };
  writeStore(path, { version: 1, records: { ...store.records, [insightId]: record } });
  return { ok: true, record };
}
