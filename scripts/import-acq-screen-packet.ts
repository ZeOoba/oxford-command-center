// scripts/import-acq-screen-packet.ts
//
// Carries the Cowork `acquisition-underwriting` screen into the command-center acquisition engine.
// Before this script the engine had never scored a live deal: underwriting happens in the Cowork skill,
// whose outputs (the ORA. Underwrite_<Property>_<MMDDYYYY>.xlsx model, the IC memo, and per-deal
// scratch JSON such as mirror.json / facts.json / score.json) have no common machine-readable shape and
// nothing moved them into acq_score_inputs (2026-11-23 review, Tier 1 #3).
//
// SOURCE OF RECORD: the screen packet below, a JSON file the skill run writes beside the underwrite
// workbook in the deal folder. It is the engine's own AcquisitionInput contract (src/contracts/
// acquisition.ts) plus deal identity and provenance, so the one Zod schema the engine already enforces
// is the validator. The workbook is NOT parsed: its Inputs tab is free-form label/value rows whose
// labels differ deal to deal (and most gate facts — product type, flood, use, DD-critical status —
// live in the memo text, not the workbook), so a label-scraping reader would guess. Blank beats
// inferred: a field the screen did not establish stays null, and the engine treats null conservatively
// (gate not confirmable, sub-score 0, verdict capped at T2).
//
// Packet shape (one packet, or { "packets": [ ... ] }):
//   {
//     "schema": "ora.acq-screen-packet/1",
//     "skillVersion": "acquisition-underwriting v4.55",       // required, free text
//     "screenedAt": "2026-11-12",                              // required, strict ISO YYYY-MM-DD
//     "deal": {                                                // at least one key; first match wins:
//       "candidateId": "deal:<notion-page-id>",                //   1. acq_candidates.id
//       "notionPageId": "<notion-page-id>",                    //   2. acq_candidates.notion_deal_id
//       "hubspotDealId": "<hubspot deal id>",                  //   3. acq_candidates.id 'deal:hubspot:<id>'
//       "address": "…"                                         //   label only, never matched on
//     },
//     "sourceFiles": ["ORA. Underwrite_….xlsx", "…"],          // optional, provenance
//     "input": { …AcquisitionInput… },                         // required; dealId defaults to the candidate id
//     "notes": { "<field>": "<source / tag>" }                 // optional per-field provenance
//   }
//
// Candidate crosswalk (the importer's property-id crosswalk): a packet is scored only against a
// candidate that ALREADY exists in acq_candidates (the HubSpot / Notion syncs create them). An
// unresolved deal is never inserted as a new candidate — that would invent a pipeline row — and is
// logged to data_quality_issues (kind 'acq-screen-packet-unmapped'); a crosswalk that points at two
// different candidates is logged as 'acq-screen-packet-ambiguous'. Both are skipped. Also skipped as
// 'acq-screen-packet-ambiguous': a file naming one candidate in two packets (array order would decide the
// current score), and a candidate whose street-address twin (the HubSpot / Notion copy of the same
// property: any shared streetKeys key) already holds a current score — scoring both double-counts the deal
// in the pipeline and, once both syncs resolve it, in calibration. Score ONE twin. The match is a
// heuristic that errs toward matching: a false match only skips (DQ row, exit 1); it is never a wrong score.
//
// Locking (merge gate PR #591): each packet's guards, score write and ledger date run under one
// BEGIN IMMEDIATE, so a concurrent importer or sync cannot slip between the check and the write.
//
// Screen order (refute wf_c51f7c6a-65b): each batch row records { screens: { candidateId: screenedAt } }.
// A packet whose screenedAt is OLDER than the newest screen already imported for its candidate is skipped
// ('acq-screen-packet-stale'), so re-importing an old packet cannot reinstate a superseded screen. The
// same date is allowed (a same-day revision; the later import wins).
//
// Rates are decimals. stabilizedYoc / unleveredIrr10yr must lie in (-0.5, 0.5], leveredIrr in (-1, 1],
// envRemediationPctOfPrice in [0, 1]: a percent-form value (7.43 for 7.43%) is a format reject, never
// divided by 100 — it would otherwise clear the yield and IRR floors.
//
// Writes: persistAndLogScore (server/warehouse/acq-engine.ts), the engine's single persistence funnel —
// acq_score_inputs (scored_by 'cowork-skill'), acq_scores, the current-score pointer and the calibration
// verdict, with the governor proxy applied exactly as on every other path, from the RATIFIED ruleset +
// RCT only (fail closed). Then one acq_source_batches row per packet file, keyed by the file's sha256.
//
// Idempotency: acq_score_inputs is UNIQUE(candidate_id, inputs_version) and inputs_version hashes the
// input + ruleset + RCT + governor regime, so re-importing an unchanged packet is a no-op reported as
// 'unchanged' (persistAndLogScore's own idempotency). The file's batch row (keyed by its sha256) is
// MERGED, never replaced: newest screenedAt per candidate, written in an IMMEDIATE transaction. A
// candidate this file already recorded is skipped on a re-import ('already imported' — re-scoring it
// could only reinstate a screen another file has since superseded), so re-running a file picks up only
// the candidates it skipped before. A changed packet for the same deal is a new input: it becomes the
// candidate's current score.
//
// Rejected (format; reported, never persisted, never auto-fixed): wrong or missing schema, blank
// skillVersion, non-ISO or future screenedAt, no deal identity, an input that fails the AcquisitionInput
// contract or carries a key the contract does not know at any depth (a misspelled field must not be
// silently dropped), any non-finite number, negative money, non-positive SF, maxBuildingSf > totalSf,
// a percent-form rate.
//
// Outcomes are NOT logged here. A packet imported for a candidate that is already acquired / passed is
// scored (the record is useful) but the import prints a warning: a verdict persisted after the decision
// must not be auto-scored against it. If the screen predates the decision, resolve via
// resolveManualOutcome. Live transitions are logged by the HubSpot / Notion syncs (terminalTransition).
// Known limit (accepted, refute wf_c51f7c6a-65b): the check reads the LOCAL status. A deal already closed
// in HubSpot / Notion but not yet synced reads 'active', so a screen made after that decision is scored
// with no warning and the next sync binds the outcome to it. Run scripts/acq-sync.ts before importing.
//
// Usage: npx tsx scripts/import-acq-screen-packet.ts <packet.json> [--db <path>] [--dry-run]
//   --dry-run validates and crosswalks only; nothing is written.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AcquisitionInput } from '../src/contracts/acquisition';
import { openWarehouseNoMigrate } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { persistAndLogScore } from '../server/warehouse/acq-engine';
import type { PersistOutcome } from '../server/warehouse/acq-engine';
import { loadRatifiedRct, loadRatifiedRuleset } from '../server/warehouse/acquisition';
import type { AcquisitionRuleset, ReplacementCostTable } from '../src/contracts/acquisition';
import { isIsoCalendarDate } from '../server/warehouse/placeholder-data';
import { loadEnvFile } from '../server/load-env';
import { refuseIfSynthetic } from '../server/real-data-status';

export const SCREEN_PACKET_SCHEMA = 'ora.acq-screen-packet/1';
/** acq_source_batches.source for packets imported by this script. */
export const SCREEN_PACKET_SOURCE = 'screen-packet';

// ── Parse (pure: no DB, no I/O) ───────────────────────────────────────────────────────────────

const DealRef = z.object({
  candidateId: z.string().trim().min(1).optional(),
  notionPageId: z.string().trim().min(1).optional(),
  hubspotDealId: z.string().trim().min(1).optional(),
  address: z.string().optional(),
}).strict();

const PacketEnvelope = z.object({
  schema: z.literal(SCREEN_PACKET_SCHEMA),
  skillVersion: z.string().trim().min(1),
  screenedAt: z.string(),
  deal: DealRef,
  sourceFiles: z.array(z.string()).optional(),
  // Validated separately below (strict, so an unknown key is a reject rather than silently stripped).
  input: z.record(z.string(), z.unknown()),
  notes: z.record(z.string(), z.string()).optional(),
}).strict();

const StrictInput = AcquisitionInput.strict();

export interface ParsedScreenPacket {
  index: number;
  skillVersion: string;
  screenedAt: string;
  deal: z.infer<typeof DealRef>;
  /** Contract-parsed input; dealId is '' when the packet omitted it (filled with the candidate id at import). */
  input: AcquisitionInput;
  inputHadDealId: boolean;
}

export interface ScreenPacketReject {
  index: number;
  reason: string;
}

const MONEY_FIELDS = ['price', 'allInBasis', 'replacementCostTotal'] as const;

/**
 * Plausible decimal bands for the rate inputs the contract leaves unbounded (refute wf_c51f7c6a-65b, HIGH):
 * the IC memo prints these as percents, and a packet carrying 6.0 / 7.43 instead of 0.06 / 0.0743 parsed
 * cleanly and cleared the yield and IRR floors. A value outside the band is a FORMAT reject — never
 * divided by 100 (the importer does not auto-fix). Exclusive low, inclusive high.
 */
const RATE_BANDS: ReadonlyArray<readonly ['stabilizedYoc' | 'unleveredIrr10yr' | 'leveredIrr', number, number]> = [
  ['stabilizedYoc', -0.5, 0.5],
  ['unleveredIrr10yr', -0.5, 0.5],
  ['leveredIrr', -1, 1],
];

function issueText(issues: readonly z.ZodIssue[]): string {
  return issues.slice(0, 4).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A key present in the raw input but absent from the parsed result was STRIPPED by a non-strict nested
 * object (ddKnown, use). `.strict()` covers only the top level (merge gate PR #591, S-1): a misspelled
 * `ddKnown.roofs` used to vanish silently. Returns the first such path, or null.
 */
function strippedKeyPath(raw: unknown, parsed: unknown, path: string): string | null {
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return null;
  for (const k of Object.keys(raw)) {
    if (!Object.hasOwn(parsed, k)) return `${path}.${k}`;
    const deeper = strippedKeyPath(raw[k], parsed[k], `${path}.${k}`);
    if (deeper !== null) return deeper;
  }
  return null;
}

/** The first non-finite number anywhere in a parsed value (JSON `1e400` parses to Infinity; z.number() accepts it). */
function nonFinitePath(v: unknown, path: string): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = nonFinitePath(v[i], `${path}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      const hit = nonFinitePath(x, `${path}.${k}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** Today (UTC) plus one day of timezone slack, as YYYY-MM-DD. */
function latestAllowedScreenDate(now: number): string {
  return new Date(now + 86_400_000).toISOString().slice(0, 10);
}

/** Validate one packet object. Returns the parsed packet or a reject reason. */
export function parseScreenPacket(raw: unknown, index = 0, now: number = Date.now()): ParsedScreenPacket | ScreenPacketReject {
  const env = PacketEnvelope.safeParse(raw);
  if (!env.success) return { index, reason: `packet: ${issueText(env.error.issues)}` };
  const p = env.data;
  if (!isIsoCalendarDate(p.screenedAt)) return { index, reason: `screenedAt '${p.screenedAt}' is not an ISO calendar date (YYYY-MM-DD)` };
  // A future date would sit in the screens ledger as the newest screen and mark every real later screen
  // of the deal stale (merge gate PR #591, C-1: a 2062 typo for 2026 blocked the deal permanently).
  if (p.screenedAt > latestAllowedScreenDate(now)) return { index, reason: `screenedAt '${p.screenedAt}' is in the future` };
  if (!p.deal.candidateId && !p.deal.notionPageId && !p.deal.hubspotDealId) {
    return { index, reason: 'deal: needs candidateId, notionPageId or hubspotDealId' };
  }
  const inputHadDealId = typeof p.input['dealId'] === 'string' && (p.input['dealId'] as string).trim() !== '';
  const rawInput = { ...p.input, dealId: inputHadDealId ? p.input['dealId'] : '' };
  const parsed = StrictInput.safeParse(rawInput);
  if (!parsed.success) return { index, reason: `input: ${issueText(parsed.error.issues)}` };
  const input = parsed.data;
  const stripped = strippedKeyPath(rawInput, input, 'input');
  if (stripped !== null) return { index, reason: `${stripped}: unrecognized key (not in the AcquisitionInput contract)` };
  // Infinity would score (e.g. full clear-height points) but persist as JSON null, so the stored input
  // could not reproduce the stored score (merge gate PR #591, C-3).
  const inf = nonFinitePath(input, 'input');
  if (inf !== null) return { index, reason: `${inf}: must be a finite number` };
  for (const f of MONEY_FIELDS) {
    const v = input[f];
    if (v !== null && (!Number.isFinite(v) || v < 0)) return { index, reason: `input.${f}: must be a finite non-negative amount` };
  }
  for (const f of ['maxBuildingSf', 'totalSf'] as const) {
    const v = input[f];
    if (v !== null && (!Number.isFinite(v) || v <= 0)) return { index, reason: `input.${f}: must be a positive SF` };
  }
  if (input.maxBuildingSf !== null && input.totalSf !== null && input.maxBuildingSf > input.totalSf) {
    return { index, reason: 'input: maxBuildingSf exceeds totalSf' };
  }
  for (const [f, lo, hi] of RATE_BANDS) {
    const v = input[f];
    if (v !== null && (!Number.isFinite(v) || v <= lo || v > hi)) {
      return { index, reason: `input.${f}: ${v} is outside (${lo}, ${hi}] — rates are decimals (0.0743 = 7.43%), never percents` };
    }
  }
  const envShare = input.envRemediationPctOfPrice;
  if (envShare !== null && (!Number.isFinite(envShare) || envShare < 0 || envShare > 1)) {
    return { index, reason: `input.envRemediationPctOfPrice: ${envShare} is outside [0, 1] — a decimal share of price, never a percent` };
  }
  return { index, skillVersion: p.skillVersion, screenedAt: p.screenedAt, deal: p.deal, input, inputHadDealId };
}

/** A payload is one packet or { packets: [...] }. */
export function parseScreenPacketPayload(payload: unknown): { packets: ParsedScreenPacket[]; rejected: ScreenPacketReject[] } {
  const list: unknown[] =
    typeof payload === 'object' && payload !== null && Array.isArray((payload as { packets?: unknown }).packets)
      ? (payload as { packets: unknown[] }).packets
      : [payload];
  const packets: ParsedScreenPacket[] = [];
  const rejected: ScreenPacketReject[] = [];
  list.forEach((raw, i) => {
    const r = parseScreenPacket(raw, i);
    if ('reason' in r) rejected.push(r);
    else packets.push(r);
  });
  return { packets, rejected };
}

// ── Crosswalk ─────────────────────────────────────────────────────────────────────────────────

export type CrosswalkResult =
  | { kind: 'found'; candidateId: string; status: string }
  | { kind: 'unmapped' }
  | { kind: 'ambiguous'; ids: string[] };

/** Resolve a packet's deal reference to ONE existing acq_candidates row. Never creates one. */
export function resolveCandidate(db: WarehouseDb, deal: ParsedScreenPacket['deal']): CrosswalkResult {
  const hits = new Map<string, string>();
  const byId = db.prepare('SELECT id, status FROM acq_candidates WHERE id = ?');
  if (deal.candidateId) {
    const r = byId.get(deal.candidateId) as { id: string; status: string } | undefined;
    if (r) hits.set(r.id, r.status);
  }
  if (deal.notionPageId) {
    const rows = db.prepare('SELECT id, status FROM acq_candidates WHERE notion_deal_id = ? OR id = ?')
      .all(deal.notionPageId, `deal:${deal.notionPageId}`) as Array<{ id: string; status: string }>;
    for (const r of rows) hits.set(r.id, r.status);
  }
  if (deal.hubspotDealId) {
    const r = byId.get(`deal:hubspot:${deal.hubspotDealId}`) as { id: string; status: string } | undefined;
    if (r) hits.set(r.id, r.status);
  }
  if (hits.size === 0) return { kind: 'unmapped' };
  // Every supplied reference must agree. A Notion page and a HubSpot deal for the same property are
  // separate candidates today (acq-hubspot-sync.ts NAMESPACE note) — scoring both from one packet would
  // double-count it in the ranked pipeline, so name ONE (candidateId) instead.
  if (hits.size > 1) return { kind: 'ambiguous', ids: [...hits.keys()].sort() };
  const [[candidateId, status]] = [...hits.entries()] as [[string, string]];
  return { kind: 'found', candidateId, status };
}

// ── Import (DB writes) ────────────────────────────────────────────────────────────────────────

export interface ScreenPacketFileMeta {
  path: string;
  sha256: string;
}

export interface ScreenPacketImportResult {
  scored: Array<{ index: number; candidateId: string; persisted: PersistOutcome; verdict: string; composite: number; candidateStatus: string }>;
  unmapped: number;
  /** Crosswalk hits two candidates, one candidate is named twice in the file, or its twin is already scored. */
  ambiguous: number;
  /** screenedAt older than the newest screen already imported for the candidate. */
  stale: number;
  /** Already scored by an earlier run of this same file; skipped, not an error. */
  alreadyImported: number;
  failed: number;
  batchId: string | null;
}

function recordDq(db: WarehouseDb, kind: string, detail: string): void {
  try {
    const open = db.prepare("SELECT 1 FROM data_quality_issues WHERE kind = ? AND detail = ? AND status = 'open' LIMIT 1").get(kind, detail);
    if (!open) db.prepare("INSERT INTO data_quality_issues (kind, detail, severity) VALUES (?, ?, 'warn')").run(kind, detail);
  } catch { /* observational — never blocks the import */ }
}

function dealLabel(deal: ParsedScreenPacket['deal']): string {
  return [
    deal.candidateId && `candidateId=${deal.candidateId}`,
    deal.notionPageId && `notionPageId=${deal.notionPageId}`,
    deal.hubspotDealId && `hubspotDealId=${deal.hubspotDealId}`,
  ].filter(Boolean).join(' ');
}

/**
 * Score each parsed packet through persistAndLogScore.
 *
 * ONE WRITE LOCK PER PACKET (merge gate PR #591, race R-1/R-2): the guards (already imported, twin,
 * stale), the score write and this packet's screen date in the file's batch row all run inside one
 * `BEGIN IMMEDIATE` … `COMMIT`. A second importer (or a sync) blocks on busy_timeout and then sees this
 * packet's committed score and date, so it can neither slip an older screen past the stale guard nor score
 * the twin of a property just scored. persistAndLogScore has no real await (its writes are synchronous and
 * its own db.transaction nests as a savepoint), so nothing else runs on this connection inside the lock.
 *
 * Per-packet isolation: a failure rolls back that packet's score AND its ledger date together, is recorded
 * (data_quality_issues 'acq-screen-packet-check-violation'), and the rest still run.
 */
export async function importScreenPackets(
  db: WarehouseDb,
  packets: readonly ParsedScreenPacket[],
  ruleset: AcquisitionRuleset,
  rct: ReplacementCostTable,
  file: ScreenPacketFileMeta | null,
): Promise<ScreenPacketImportResult> {
  const out: ScreenPacketImportResult = { scored: [], unmapped: 0, ambiguous: 0, stale: 0, alreadyImported: 0, failed: 0, batchId: null };

  // Candidates scored by an EARLIER packet of this same run: a later packet resolving to one of them is a
  // duplicate, never an 'already imported' no-op (refute wf_99b93364-38d).
  const scoredThisRun = new Set<string>();

  for (const p of packets) {
    let open = false;
    let target = dealLabel(p.deal);
    try {
      db.exec('BEGIN IMMEDIATE');
      open = true;
      // EVERY guard input is read under the lock — including the named-twice count: the crosswalk is NOT
      // immutable during a run, because a concurrent HubSpot / Notion sync can create the candidate two of
      // this file's packets resolve to (refute wf_99b93364-38d). A twin this same run just scored is seen
      // too (a file holding both twins scores only the first).
      const multi = candidatesNamedTwice(db, packets);
      let g = guardPacket(db, p, multi, candidatesAlreadyImported(db, file));
      const xw = g.kind === 'score' ? null : resolveCandidate(db, p.deal);
      const dupId = g.kind === 'score' ? g.candidateId : xw?.kind === 'found' ? xw.candidateId : null;
      if (dupId !== null && scoredThisRun.has(dupId) && !(g.kind === 'skip' && g.counter === 'ambiguous')) {
        g = { kind: 'skip', counter: 'ambiguous', dqKind: 'acq-screen-packet-ambiguous',
          detail: `${dupId}: named by more than one packet in one file; the first was scored, this one was not` };
      }
      if (g.kind === 'skip') {
        if (g.dqKind !== null) recordDq(db, g.dqKind, g.detail);
        db.exec('COMMIT');
        open = false;
        out[g.counter] += 1;
        continue;
      }
      target = g.candidateId;
      const input: AcquisitionInput = p.inputHadDealId ? p.input : { ...p.input, dealId: g.candidateId };
      const r = await persistAndLogScore(db, g.candidateId, input, ruleset, rct, { scoredBy: 'cowork-skill' });
      if (file) recordBatch(db, file, { [g.candidateId]: p.screenedAt }, new Set([p.skillVersion]));
      db.exec('COMMIT');
      open = false;
      scoredThisRun.add(g.candidateId);
      out.scored.push({
        index: p.index, candidateId: g.candidateId, persisted: r.persisted,
        verdict: r.score.verdict, composite: r.score.composite, candidateStatus: g.status,
      });
    } catch (e) {
      if (open && db.inTransaction) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back by SQLite */ }
      }
      out.failed += 1;
      recordDq(db, 'acq-screen-packet-check-violation', `${target}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (file && out.scored.length > 0) out.batchId = batchIdFor(file);
  return out;
}

export type PacketGuard =
  | { kind: 'score'; candidateId: string; status: string }
  | { kind: 'skip'; counter: 'unmapped' | 'ambiguous' | 'stale'; dqKind: string; detail: string }
  /** Not an error: this file already scored the candidate on an earlier run (no DQ row). */
  | { kind: 'skip'; counter: 'alreadyImported'; dqKind: null; detail: string };

/** The batch-row id of a packet file. */
export function batchIdFor(file: ScreenPacketFileMeta): string {
  return `${SCREEN_PACKET_SOURCE}:${file.sha256.slice(0, 16)}`;
}

/**
 * Candidates an earlier run of THIS file already recorded in its batch row (refute wf_52534d83-279):
 * re-scoring them on a re-import can only reinstate a screen another file has since superseded on the
 * same date. Empty when the file was never imported or its notes do not parse.
 */
export function candidatesAlreadyImported(db: WarehouseDb, file: ScreenPacketFileMeta | null): Set<string> {
  if (!file) return new Set();
  const row = db.prepare('SELECT notes FROM acq_source_batches WHERE id = ?').get(batchIdFor(file)) as { notes: string | null } | undefined;
  try {
    const screens = (JSON.parse(row?.notes ?? 'null') as { screens?: unknown } | null)?.screens;
    return typeof screens === 'object' && screens !== null ? new Set(Object.keys(screens)) : new Set();
  } catch {
    return new Set();
  }
}

/** Candidate ids that more than one packet of this file resolves to (refute wf_c51f7c6a-65b). */
export function candidatesNamedTwice(db: WarehouseDb, packets: readonly ParsedScreenPacket[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const p of packets) {
    const xw = resolveCandidate(db, p.deal);
    if (xw.kind === 'found') n.set(xw.candidateId, (n.get(xw.candidateId) ?? 0) + 1);
  }
  return new Map([...n].filter(([, c]) => c > 1));
}

/**
 * The per-packet skip rules shared by the import and by --dry-run: unmapped, crosswalk ambiguous, already
 * imported from this file, named twice in the file, scored twin, stale screen. Reads only; the caller
 * records the DQ row. The real run adds one rule a dry run cannot see — a candidate scored by an EARLIER
 * packet of the same run is skipped as ambiguous — and re-reads every rule under each packet's lock.
 */
export function guardPacket(
  db: WarehouseDb,
  p: ParsedScreenPacket,
  namedTwice: ReadonlyMap<string, number>,
  alreadyImported: ReadonlySet<string> = new Set(),
): PacketGuard {
  const xw = resolveCandidate(db, p.deal);
  if (xw.kind === 'unmapped') {
    return { kind: 'skip', counter: 'unmapped', dqKind: 'acq-screen-packet-unmapped',
      detail: `${dealLabel(p.deal)}: no acq_candidates row; run the HubSpot / Notion sync first (packet not scored)` };
  }
  if (xw.kind === 'ambiguous') {
    return { kind: 'skip', counter: 'ambiguous', dqKind: 'acq-screen-packet-ambiguous',
      detail: `${dealLabel(p.deal)}: matches ${xw.ids.join(', ')}; name one candidateId (packet not scored)` };
  }
  if (alreadyImported.has(xw.candidateId)) {
    return { kind: 'skip', counter: 'alreadyImported', dqKind: null,
      detail: `${xw.candidateId}: already imported from this file (not re-scored)` };
  }
  const times = namedTwice.get(xw.candidateId);
  if (times !== undefined) {
    return { kind: 'skip', counter: 'ambiguous', dqKind: 'acq-screen-packet-ambiguous',
      detail: `${xw.candidateId}: named by ${times} packets in one file; split them (no packet for it scored)` };
  }
  const twin = scoredTwin(db, xw.candidateId);
  if (twin !== null) {
    return { kind: 'skip', counter: 'ambiguous', dqKind: 'acq-screen-packet-ambiguous',
      detail: `${xw.candidateId}: same street address as ${twin}, which already holds a current score; score ONE twin (packet not scored)` };
  }
  const latest = latestScreenedAt(db, xw.candidateId);
  if (latest !== null && p.screenedAt < latest) {
    return { kind: 'skip', counter: 'stale', dqKind: 'acq-screen-packet-stale',
      detail: `${xw.candidateId}: packet screenedAt ${p.screenedAt} is older than the imported screen of ${latest} (packet not scored)` };
  }
  return { kind: 'score', candidateId: xw.candidateId, status: xw.status };
}

/**
 * Write (or MERGE into) the file's batch row. Called once per scored packet, inside that packet's
 * BEGIN IMMEDIATE (where its own transaction nests as a savepoint), so the date commits or rolls back with
 * the score. An existing row's `screens` map is merged — newest date per candidate — never replaced (refute
 * wf_de354fb0-4c3: INSERT OR IGNORE dropped a later run's date and let an older screen through the stale
 * guard). candidate_count is the merged map's size.
 */
function recordBatch(
  db: WarehouseDb,
  file: ScreenPacketFileMeta,
  screens: Readonly<Record<string, string>>,
  scoredVersions: ReadonlySet<string>,
): string {
  const id = batchIdFor(file);
  // Inside importScreenPackets' per-packet BEGIN IMMEDIATE this nests as a savepoint; called on its own it
  // takes the write lock before the read (IMMEDIATE), so a concurrent writer waits on busy_timeout instead
  // of failing the upgrade with SQLITE_BUSY_SNAPSHOT (refute wf_52534d83-279).
  db.transaction(() => {
    const prior = db.prepare('SELECT notes FROM acq_source_batches WHERE id = ?').get(id) as { notes: string | null } | undefined;
    let priorNotes: Record<string, unknown> = {};
    if (prior?.notes) {
      try {
        const d = JSON.parse(prior.notes) as unknown;
        if (typeof d === 'object' && d !== null && !Array.isArray(d)) priorNotes = d as Record<string, unknown>;
      } catch { /* unparseable notes: rebuilt from this run below */ }
    }
    const merged: Record<string, string> = {};
    const priorScreens = priorNotes['screens'];
    if (typeof priorScreens === 'object' && priorScreens !== null) {
      for (const [k, v] of Object.entries(priorScreens as Record<string, unknown>)) {
        if (typeof v === 'string' && isIsoCalendarDate(v)) merged[k] = v;
      }
    }
    for (const [k, v] of Object.entries(screens)) {
      if (!Object.hasOwn(merged, k) || v > merged[k]!) merged[k] = v;
    }
    const priorVersions = Array.isArray(priorNotes['skillVersions']) ? (priorNotes['skillVersions'] as unknown[]).filter((v): v is string => typeof v === 'string') : [];
    const notes = JSON.stringify({
      path: file.path, sha256: file.sha256, screens: merged,
      skillVersions: [...new Set([...priorVersions, ...scoredVersions])],
      ingestedBy: 'scripts/import-acq-screen-packet.ts',
    });
    if (prior) {
      db.prepare('UPDATE acq_source_batches SET candidate_count = ?, notes = ? WHERE id = ?').run(Object.keys(merged).length, notes, id);
    } else {
      db.prepare('INSERT INTO acq_source_batches (id, source, label, candidate_count, notes) VALUES (?, ?, ?, ?, ?)')
        .run(id, SCREEN_PACKET_SOURCE, basename(file.path), Object.keys(merged).length, notes);
    }
  }).immediate();
  return id;
}

/**
 * The newest screenedAt this importer has recorded for a candidate (null = none). Read from the
 * `screens` map in each screen-packet batch's notes — no migration, acq_source_batches is the import
 * ledger. A batch whose notes do not parse is ignored (it carries no screen dates to compare), and so is a
 * date later than today + 1 day (a future date written by hand or before the parse-side check would
 * otherwise mark every real later screen stale).
 */
export function latestScreenedAt(db: WarehouseDb, candidateId: string, now: number = Date.now()): string | null {
  const rows = db.prepare('SELECT notes FROM acq_source_batches WHERE source = ?').all(SCREEN_PACKET_SOURCE) as Array<{ notes: string | null }>;
  const latestAllowed = latestAllowedScreenDate(now);
  let best: string | null = null;
  for (const { notes } of rows) {
    let d: unknown;
    try { d = JSON.parse(notes ?? 'null'); } catch { continue; }
    const screens = (d as { screens?: unknown } | null)?.screens;
    if (typeof screens !== 'object' || screens === null || !Object.hasOwn(screens, candidateId)) continue;
    const v = (screens as Record<string, unknown>)[candidateId];
    if (typeof v === 'string' && isIsoCalendarDate(v) && v <= latestAllowed && (best === null || v > best)) best = v;
  }
  return best;
}

const STREET_ABBREV: Readonly<Record<string, string>> = {
  road: 'rd', street: 'st', avenue: 'ave', drive: 'dr', boulevard: 'blvd', parkway: 'pkwy', lane: 'ln',
  court: 'ct', place: 'pl', highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w', circle: 'cir',
};

function addressWords(address: string): string[] {
  return address.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/ +/).filter(Boolean);
}

function keyAt(words: readonly string[], i: number): string {
  return [words[i], ...words.slice(i + 1, i + 3).map((w) => (Object.hasOwn(STREET_ABBREV, w) ? STREET_ABBREV[w]! : w))].join(' ');
}

/**
 * Street-number + next two words, abbreviation-normalized, from the FIRST 2-6 digit token: '4410 Sample
 * Road' and '4410 Sample Rd, Exampleville' both key '4410 sample rd'. Null when the text has no such token.
 */
export function streetKey(address: string | null): string | null {
  if (!address) return null;
  const words = addressWords(address);
  const i = words.findIndex((w) => /^[0-9]{2,6}$/.test(w));
  if (i < 0 || i + 1 >= words.length) return null;
  return keyAt(words, i);
}

/**
 * EVERY candidate street key in the text: one per 2-6 digit token (with at least one word after it). The
 * first one is streetKey's key, so the set always contains it.
 *
 * Why a set (merge gate PR #591; refutes wf_6f36c81a-7bd and wf_aea96b00-a7e): each attempt to pick THE
 * street number or to separate twins by parsed city / ZIP / unit opened a new false negative — a leading
 * 'Suite 120,', an SF figure read as a ZIP, 'Commerce Building 4410 …', '4410 66 Hwy' — and a missed twin is
 * double-scored, the costly direction. Matching on ANY shared key is monotone: it catches every pair the
 * single key caught, plus those where the street number is not the first number. Its only cost is more false
 * MATCHES (two different properties sharing a number + two words, e.g. the same street in another city),
 * which skip with an ambiguous DQ row and exit 1, never a wrong score.
 */
export function streetKeys(address: string | null): Set<string> {
  const out = new Set<string>();
  if (!address) return out;
  // The committed head's single key is ALWAYS in the set, unfiltered — that is what keeps the match
  // monotone (never a twin missed that the single key caught).
  const head = streetKey(address);
  if (head !== null) out.add(head);
  // Additional keys only where the number can be a street number (refute wf_99b93364-38d): not the tail of
  // a thousands group ('15,000 SF' would key '000 sf' and match every N,000 SF deal), and not followed by a
  // size / country / unit word ('43215 usa', '25000 sf').
  const raw = address.toLowerCase();
  const words = addressWords(address);
  const thousandsTails = new Set((raw.match(/\d,(\d{3})\b/g) ?? []).map((m) => m.slice(2)));
  for (let i = 0; i + 1 < words.length; i++) {
    const w = words[i]!;
    if (!/^[0-9]{2,6}$/.test(w)) continue;
    if (w.length === 3 && thousandsTails.has(w) && i > 0 && /^[0-9]+$/.test(words[i - 1]!)) continue;
    if (/^[0-9]+$/.test(words[i + 1]!)) continue; // '15' of '15,000', a ZIP+4, a number run
    if (NON_STREET_WORDS.has(words[i + 1]!)) continue;
    out.add(keyAt(words, i));
  }
  return out;
}

/** A number followed by one of these is a size, place or unit figure, not a street number. */
const NON_STREET_WORDS: ReadonlySet<string> = new Set([
  'sf', 'sq', 'sqft', 'ft', 'feet', 'square', 'acre', 'acres', 'ac', 'usa', 'us', 'united', 'county',
  'suite', 'ste', 'unit', 'units', 'bldg', 'building', 'buildings', 'bldgs', 'mo', 'month', 'yr', 'year',
]);

/**
 * Another candidate sharing any street key (streetKeys) that already holds a current score (refute
 * wf_c51f7c6a-65b): the HubSpot and Notion twins of one property are separate candidates, and scoring both
 * double-counts the deal in the ranked pipeline and, once both syncs resolve it, in calibration. Candidates
 * are checked in id order so the reported twin, and the DQ text, are stable.
 */
export function scoredTwin(db: WarehouseDb, candidateId: string): string | null {
  const self = db.prepare('SELECT address FROM acq_candidates WHERE id = ?').get(candidateId) as { address: string | null } | undefined;
  const mine = streetKeys(self?.address ?? null);
  if (mine.size === 0) return null;
  const others = db.prepare('SELECT id, address FROM acq_candidates WHERE id <> ? AND current_score_id IS NOT NULL ORDER BY id')
    .all(candidateId) as Array<{ id: string; address: string | null }>;
  return others.find((o) => [...streetKeys(o.address)].some((k) => mine.has(k)))?.id ?? null;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

export interface CliArgs {
  filePath: string;
  db?: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let db: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--db') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --db');
      db = next;
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('Usage: npx tsx scripts/import-acq-screen-packet.ts <packet.json> [--db <path>] [--dry-run]');
  }
  return { filePath: positional[0]!, db, dryRun };
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** CLI entry. Exported for the exit-code tests; returns the process exit code (0 ok, 1 anything skipped / rejected / failed). */
export async function main(argv: string[]): Promise<number> {
  loadEnvFile();
  // The packet itself is never a manifest path, but a checkout running on synthetic stand-ins must not
  // write engine scores into a warehouse beside them (same rule as every other warehouse writer).
  refuseIfSynthetic('import-acq-screen-packet');
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(args.filePath);
  } catch (e) {
    console.error(`cannot read ${args.filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`cannot parse ${args.filePath} as JSON: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const { packets, rejected } = parseScreenPacketPayload(payload);
  for (const r of rejected) console.error(`  ✗ packet ${r.index} rejected: ${r.reason}`);

  // Anchored to this checkout like scripts/acq-sync.ts, so a task launched elsewhere hits the warehouse
  // this checkout's .env names. NoMigrate: refuses a warehouse behind this code rather than migrating it.
  const dbPath = args.db ?? process.env.WAREHOUSE_DB ?? join(REPO_ROOT, 'data', 'warehouse', 'finance.sqlite');
  if (!existsSync(dbPath)) {
    console.error(`no warehouse DB at ${dbPath}`);
    return 1;
  }
  let db: WarehouseDb;
  try {
    db = openWarehouseNoMigrate(dbPath);
  } catch (e) {
    console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const file: ScreenPacketFileMeta = { path: args.filePath, sha256: createHash('sha256').update(bytes).digest('hex') };
  try {
    if (args.dryRun) {
      // Same guards as the real run. Limit: a twin pair that is BOTH unscored and both in this file is
      // only caught by the real run (the second twin's check sees the first one's new score).
      const multi = candidatesNamedTwice(db, packets);
      const already = candidatesAlreadyImported(db, file);
      let skipped = 0;
      for (const p of packets) {
        const g = guardPacket(db, p, multi, already);
        if (g.kind === 'skip' && g.counter !== 'alreadyImported') skipped += 1;
        console.log(`  packet ${p.index}: ${g.kind === 'score' ? `→ ${g.candidateId} (${g.status})` : `SKIP ${g.counter}: ${g.detail}`}`);
      }
      console.log(`import-acq-screen-packet (dry run): ${skipped} would be skipped as errors, ${rejected.length} rejected — nothing written`);
      return rejected.length + skipped > 0 ? 1 : 0;
    }
    const ruleset = loadRatifiedRuleset();
    const rct = loadRatifiedRct();
    const r = await importScreenPackets(db, packets, ruleset, rct, file);
    for (const s of r.scored) {
      console.log(`  ✓ ${s.candidateId}: ${s.verdict} (composite ${s.composite.toFixed(1)}) — ${s.persisted}`);
      if (s.candidateStatus === 'acquired' || s.candidateStatus === 'passed') {
        console.log(`    ⚠ candidate is already '${s.candidateStatus}': outcome not auto-logged (a verdict persisted after the decision is not a prediction). If the screen predates the decision, resolve via resolveManualOutcome.`);
      }
    }
    console.log(
      `import-acq-screen-packet: ${r.scored.length} scored, ${r.unmapped} unmapped, ${r.ambiguous} ambiguous, ${r.stale} stale, ${r.alreadyImported} already imported, ${r.failed} failed, ${rejected.length} rejected`
      + (r.batchId ? ` (batch ${r.batchId})` : ''),
    );
    return rejected.length + r.unmapped + r.ambiguous + r.stale + r.failed > 0 ? 1 : 0;
  } catch (e) {
    console.error(`import-acq-screen-packet: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
}

// Run the CLI only when invoked directly — importing for tests must never open a db or write.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/import-acq-screen-packet.ts')) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e: unknown) => {
    console.error('import-acq-screen-packet crashed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
