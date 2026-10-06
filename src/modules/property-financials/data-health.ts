// src/modules/property-financials/data-health.ts
//
// Pure model of the Property Financials data-health surfaces (plan T8): the per-property gap
// matcher used by the Explorer and the Scorecard row detail, the leases that belong to no dataset
// entity, exclusion detection, and the panel's fixed disclosure text. No React, no fetch.
//
// Gap sources for one entity:
//   data_quality — a dataset data_quality[] item that names the entity (whole item, verbatim)
//   lease        — the entity's lease was read only partially (confidence other than "text layer")
//   mapping      — the FVC → Sepich square-footage mapping, while the dataset still calls it inferred
// An item is `inferred` when it says so, or (FVC only, while that mapping flag is up) when it rests
// on the Sepich identification. Inferred items render with an [INFERRED] tag.
//
// Matching (label / street / number): an item names an entity when it contains
//   - the entity's street phrase (its id or label without the building number), and any building
//     number written directly before that phrase is the entity's own ("3540 E 5th" names 3540 E 5th;
//     "4595 E 5th" — an FVC building — does not), or
//   - the entity's building number on its own, when it is 4+ digits and not year-like (19xx/20xx), or
//   - an all-caps parenthetical alias of the id ("EGFLLC"), or a listed alias (FVC: "Sepich").
import { PF_ENTITY_IDS, type PfDataset, type PfEntityId, type PfLease } from '@contracts/property-financials';
import { fvcSepichMappingFlag } from '@analytics/property-financials/metrics';
import { fmtLongDate, leaseForEntity } from './model';
import type { PfDataHealthMeta } from './types';

export type PfGapSource = 'data_quality' | 'lease' | 'mapping';

export interface PfGapItem {
  readonly source: PfGapSource;
  readonly text: string;
  readonly inferred: boolean;
}

export interface PfUnattachedLease {
  readonly property: string;
  readonly tenant: string;
  readonly text: string;
}

/** The disclosure every data-health surface carries (CLAUDE.md §1: Spine A = Master Workbook, Spine B = warehouse). */
export const NOI_DISCLOSURE =
  'Normalized NOI · cash basis · computed independently of the warehouse (Spine B) and the Master Workbook (Spine A); not reconciled';

/** Aliases a label cannot carry: the FVC aggregate is the Sepich portfolio (sf.FVC.note). */
const EXTRA_ALIASES: Readonly<Partial<Record<PfEntityId, readonly string[]>>> = { FVC: ['Sepich'] };

const TEXT_LAYER = /^text layer$/i;
const YEAR_LIKE = /^(19|20)\d\d$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trailing parenthetical removed: "55 New Plant (EGFLLC)" → "55 New Plant". */
function baseName(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function parenthetical(s: string): string | null {
  return /\(([^)]*)\)\s*$/.exec(s)?.[1]?.trim() ?? null;
}

interface Matcher {
  readonly number: string | null;
  readonly phrases: readonly string[];
  readonly aliases: readonly string[];
}

function splitNumber(name: string): { number: string | null; street: string } {
  const m = /^(\d[\d-]*)\s+(.+)$/.exec(baseName(name));
  return m ? { number: m[1]!, street: m[2]! } : { number: null, street: baseName(name) };
}

function matcherFor(d: PfDataset, id: PfEntityId): Matcher {
  const fromId = splitNumber(id);
  const fromLabel = splitNumber(d.properties[id].label);
  const phrases = [...new Set([fromId.street, fromLabel.street].filter((s) => s.length > 0))];
  const paren = parenthetical(id);
  const aliases = [...(paren && /^[A-Z0-9]{3,}$/.test(paren) ? [paren] : []), ...(EXTRA_ALIASES[id] ?? [])];
  return { number: fromId.number, phrases, aliases };
}

function numberMatches(own: string | null, written: string | undefined): boolean {
  if (written === undefined) return true;
  return own !== null && written.split('-').includes(own);
}

/** Does `text` name the entity described by `m`? */
function names(text: string, m: Matcher): boolean {
  for (const phrase of m.phrases) {
    const re = new RegExp(`(?:(\\d[\\d-]*)\\s+)?\\b${escapeRe(phrase)}\\b`, 'gi');
    for (const hit of text.matchAll(re)) if (numberMatches(m.number, hit[1])) return true;
  }
  if (m.number && m.number.length >= 4 && !YEAR_LIKE.test(m.number)) {
    if (new RegExp(`(?<![\\d$.,-])${escapeRe(m.number)}(?![\\d])`).test(text)) return true;
  }
  return m.aliases.some((a) => new RegExp(`\\b${escapeRe(a)}\\b`, 'i').test(text));
}

function leaseGapText(l: PfLease): string {
  return `Lease (${l.tenant}): ${l.confidence}.`;
}

/** Every known gap / caution for one entity, data_quality items first (dataset order). */
export function gapsForEntity(d: PfDataset, id: PfEntityId): PfGapItem[] {
  const m = matcherFor(d, id);
  const fvc = id === 'FVC' ? fvcSepichMappingFlag(d.sf.FVC) : null;
  const inferred = (text: string): boolean => /\binferred\b/i.test(text) || (fvc?.active === true && /\bSepich\b/.test(text));
  const out: PfGapItem[] = [];
  for (const item of d.data_quality) {
    if (mentionsExcluded(item, d.meta.excluded)) continue;
    if (names(item, m)) out.push({ source: 'data_quality', text: item, inferred: inferred(item) });
  }
  const lease = leaseForEntity(d.leases, id);
  if (lease && !TEXT_LAYER.test(lease.confidence.trim())) out.push({ source: 'lease', text: leaseGapText(lease), inferred: false });
  if (fvc?.active) out.push({ source: 'mapping', text: fvc.text, inferred: true });
  return out;
}

/** Leases whose property is not one of the dataset entities (e.g. "no P&L in folder"). */
export function unattachedLeaseGaps(d: PfDataset): PfUnattachedLease[] {
  const attached = new Set(PF_ENTITY_IDS.map((id) => leaseForEntity(d.leases, id)).filter((l): l is PfLease => l !== null));
  return d.leases
    .filter((l) => !attached.has(l))
    .map((l) => ({ property: l.property, tenant: l.tenant, text: `${l.tenant} lease on file; ${l.confidence}.` }));
}

/** meta.excluded entries without their status parenthetical: "2203-2207 Northwood (pending)" → "2203-2207 Northwood". */
export function excludedNames(excluded: readonly string[]): string[] {
  return excluded.map(baseName).filter((s) => s.length > 0);
}

/** True when `text` names an excluded property (by its full name or its street words). */
export function mentionsExcluded(text: string, excluded: readonly string[]): boolean {
  return excludedNames(excluded).some((name) => {
    const { street } = splitNumber(name);
    return text.toLowerCase().includes(name.toLowerCase()) || new RegExp(`\\b${escapeRe(street)}\\b`, 'i').test(text);
  });
}

/**
 * monthly-long.csv (the GL-level audit layer) is LOCAL-ONLY by Gabriel's ruling of 2026-10-06: gitignored and
 * kept off the remote, so a fresh clone or a CI checkout legitimately has no CSV. Its absence is a policy state,
 * not a fault, and the panel says so in these words.
 */
export const AUDIT_CSV_ABSENT_TEXT =
  'Audit CSV not present on this machine (kept off the remote by policy); regenerate with the refresh pipeline';

export type PfCsvAuditStatus =
  | { readonly kind: 'sha'; readonly sha: string }
  | { readonly kind: 'absent'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

/** The loader's sanitized error for a file that is not on disk ends in the errno code, e.g. "stat failed (ENOENT)". */
const NOT_ON_DISK = /\((ENOENT|ENOTDIR)\)$/;

/**
 * How the data-health panel presents the CSV hash. Absence is claimed ONLY for a missing file (or a server that
 * sent neither a hash nor an error); any other read failure (EBUSY, EACCES, changed mid-read) stays a visible error.
 */
export function csvAuditStatus(meta: Pick<PfDataHealthMeta, 'csvSha256' | 'csvError'>): PfCsvAuditStatus {
  if (meta.csvSha256) return { kind: 'sha', sha: meta.csvSha256 };
  if (meta.csvError === null || NOT_ON_DISK.test(meta.csvError)) return { kind: 'absent', text: AUDIT_CSV_ABSENT_TEXT };
  return { kind: 'error', text: meta.csvError };
}

/** First 12 hex characters of a sha256, for display (the full value goes in the title). */
export function shortSha(sha: string | null): string | null {
  return sha === null ? null : sha.slice(0, 12);
}

/** '5 days since 30 Sep 2026', or the server's reason for a future as-of (a negative day count is never shown). */
export function freshnessAge(meta: PfDataHealthMeta): string {
  if (meta.ageDays < 0) return meta.stalenessReason ? `${meta.stalenessReason} (${fmtLongDate(meta.as_of)})` : `as of ${fmtLongDate(meta.as_of)}`;
  return `${meta.ageDays} day${meta.ageDays === 1 ? '' : 's'} since ${fmtLongDate(meta.as_of)}`;
}
