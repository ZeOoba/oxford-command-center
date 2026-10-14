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
// confidential-terms.json; this is a confidentiality gate, so it FAILS CLOSED (throws) if that file is
// absent, unreadable, or empty. The only way to run with reduced (placeholder-only) coverage is the
// explicit CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 opt-out — never an automatic/silent fallback (see
// loadTerms() below). NEVER echo a matched term back out (don't widen the leak) — report only the label.
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

/** Used ONLY when an operator has explicitly set CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 to
 *  knowingly accept reduced-coverage scanning on a box without the live hooks file. It carries NO
 *  real deal identifier — those live ONLY in confidential-terms.json (gitignored, off-machine) and
 *  must never land in a git-tracked file (the pre-push hook scans history for them). The structural
 *  placeholder term is impossible to collide with real ownership-financial text. */
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
 * Exported so Brain's roster watcher observes the exact file `loadTerms` reads (one resolver, no drift).
 */
export function termsPath(): string {
  return (
    process.env.CONFIDENTIAL_TERMS_PATH ??
    join(homedir(), '.claude', 'hooks', 'confidential-terms.json')
  );
}

/**
 * Loads active confidential deal terms from the live file.
 *
 * This is a confidentiality gate, not a productivity gate: it fails CLOSED. If
 * `confidential-terms.json` is absent or unreadable, this throws by default — it does NOT
 * silently degrade to scanning only the built-in placeholder, because that would let real
 * deal identifiers sail through undetected with no operator-visible signal beyond an easily
 * missed stderr line (see the 2026-07-06 audit finding this fixes).
 *
 * The ONLY way to run with reduced (placeholder-only) coverage is to explicitly set
 * `CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1` — a deliberate, logged acknowledgment, never an
 * automatic fallback. Do NOT key this off `NODE_ENV==='test'`: that is an automatic signal
 * vitest sets by default, not a human decision, and is exactly the condition that let this
 * guard silently no-op in CI for weeks. Tests get real matching coverage via a git-tracked
 * synthetic fixture wired through `CONFIDENTIAL_TERMS_PATH` in tests/setup.ts instead.
 *
 * @returns A record mapping deal identifiers to their term configurations.
 * @throws If the file is absent/unreadable/empty and CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER is not set.
 */
function loadTerms(): Record<string, DealTerms> {
  const path = termsPath();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const out: Record<string, DealTerms> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (key.startsWith('_') || typeof val !== 'object' || val === null) continue;
      out[key] = val as DealTerms;
    }
    if (Object.keys(out).length > 0) return out;
  } catch {
    // unreadable/invalid → fall through to the closed-by-default handling below
  }
  if (process.env['CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER'] === '1') {
    // Deliberate, explicit opt-in to reduced coverage -- always warn, regardless of NODE_ENV,
    // since choosing this mode should never be silent.
    process.stderr.write(
      '[briefing] WARNING: confidential-terms.json absent or unreadable at ' +
        path +
        ' -- CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 set, so the confidentiality guard is scanning ' +
        'the built-in placeholder ONLY; real deal identifiers will NOT be caught.\n',
    );
    return FALLBACK_TERMS;
  }
  throw new Error(
    `confidential-terms.json is absent, unreadable, or empty at ${path} -- refusing to render ` +
      'with a disabled confidentiality guard. Fix: provide a readable terms file at that path ' +
      '(or set CONFIDENTIAL_TERMS_PATH to point at one), or, ONLY for a deliberately reduced-' +
      'coverage dev box, set CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 to acknowledge and proceed ' +
      'with placeholder-only scanning.',
  );
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
