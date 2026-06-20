// server/briefing/confidential.ts
//
// A server-side confidential-term scanner for the briefing pipeline — the TypeScript mirror of the
// egress hook's `find_hit` (C:/Users/Owner/.claude/hooks/confidentiality-guard.py). A BriefingModel
// is an ownership-FINANCIAL artifact and by construction carries NO deal terms; this module exists
// to PROVE that invariant in a test (Behavior contract #3) and to fail loud if a future change ever
// let a confidential identifier reach the model.
//
// Lowercase substring match on each active deal's `always` terms, plus the `context` terms gated by a
// `context_requires_any` anchor — identical semantics to the Python guard. The terms come from the live
// confidential-terms.json when readable; when it is absent (a clean CI box without the brain hooks) the
// scan still runs against a small built-in seed of the known active-deal identifiers so the guard never
// silently no-ops. NEVER echo a matched term back out (don't widen the leak) — report only the deal label.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface DealTerms {
  label?: string;
  active?: boolean;
  always?: string[];
  context?: string[];
  context_requires_any?: string[];
}

/** Built-in fallback so the scan is never a no-op on a box WITHOUT the live hooks file (CI). It carries
 *  NO real deal identifier — those live ONLY in confidential-terms.json (gitignored, off-machine) and
 *  must never land in a git-tracked file (the pre-push hook scans history for them). In production the
 *  live file is always present and supersedes this; this placeholder only proves the scanner is wired.
 *  The structural placeholder term is impossible to collide with real ownership-financial text. */
const FALLBACK_TERMS: Record<string, DealTerms> = {
  placeholder: {
    label: 'Confidential Deal',
    active: true,
    always: ['__ora_confidential_placeholder__'],
    context: [],
    context_requires_any: [],
  },
};

/**
 * Resolves the path to the confidential terms configuration file.
 *
 * @returns The path to the confidential terms JSON file, using the `CONFIDENTIAL_TERMS_PATH` environment variable if set, otherwise a default location in the user's home directory.
 */
function termsPath(): string {
  return (
    process.env.CONFIDENTIAL_TERMS_PATH ??
    join(homedir(), '.claude', 'hooks', 'confidential-terms.json')
  );
}

/**
 * Loads active confidential deal terms, preferring the live file and falling back to built-in defaults.
 *
 * @returns A record mapping deal identifiers to their term configurations.
 */
function loadTerms(): Record<string, DealTerms> {
  try {
    const raw = JSON.parse(readFileSync(termsPath(), 'utf8')) as Record<string, unknown>;
    const out: Record<string, DealTerms> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (key.startsWith('_') || typeof val !== 'object' || val === null) continue;
      out[key] = val as DealTerms;
    }
    if (Object.keys(out).length > 0) return out;
  } catch {
    // unreadable → fall through to the built-in seed
  }
  // Warn loudly so operators know the guard is scanning the built-in placeholder only.
  // Suppressed in unit tests to avoid noise.
  if (process.env['NODE_ENV'] !== 'test') {
    process.stderr.write(
      '[briefing] WARNING: confidential-terms.json absent or unreadable — ' +
        'confidentiality guard scanning built-in placeholder only; real deal identifiers will NOT be caught.\n',
    );
  }
  return FALLBACK_TERMS;
}

/**
 * Converts any value into a single flattened string.
 *
 * @returns A flattened string representation of the input value, with nested array and object elements separated by spaces.
 */
export function collectText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(collectText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(collectText).join(' ');
  return '';
}

export interface ConfidentialHit {
  dealLabel: string;
}

/**
 * Scans a value for confidential deal terms.
 *
 * Checks `always` terms (which match unconditionally) and `context` terms (which match only when a `context_requires_any` anchor is present). Matching is case-insensitive and uses substring inclusion.
 *
 * @returns `{ dealLabel: string }` for the first confidential term detected, or `null` if none found.
 */
export function scanForConfidential(value: unknown, terms = loadTerms()): ConfidentialHit | null {
  const low = collectText(value).toLowerCase();
  if (!low) return null;
  for (const [key, deal] of Object.entries(terms)) {
    if (deal.active === false) continue;
    const label = deal.label ?? key;
    for (const t of deal.always ?? []) {
      if (t && low.includes(t.toLowerCase())) return { dealLabel: label };
    }
    const anchors = (deal.context_requires_any ?? []).map((r) => r.toLowerCase());
    if (anchors.length > 0 && anchors.some((a) => low.includes(a))) {
      for (const t of deal.context ?? []) {
        if (t && low.includes(t.toLowerCase())) return { dealLabel: label };
      }
    }
  }
  return null;
}

/**
 * Throws an error if the value contains any confidential term.
 *
 * The error message includes only the deal label.
 *
 * @throws If a confidential term is detected.
 */
export function assertNoConfidential(value: unknown): void {
  const hit = scanForConfidential(value);
  if (hit) {
    throw new Error(
      `briefing model carries a confidential deal term (${hit.dealLabel}) — refusing to render`,
    );
  }
}
