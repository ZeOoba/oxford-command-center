// server/warehouse/om-extract.ts
import { scanForConfidential } from '../briefing/confidential';
import { pdfToText } from '../lib/pdf-text';
import fieldsConfig from './om-extract-fields.json';

export type OmExtractResult =
  | { ok: true; fields: Record<string, string>; fieldCount: number; rawText?: string }
  | { ok: false; error: string; status: number };

export interface OmExtractOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  // Injectable for tests — avoids needing to vi.mock the pdf-parse module
  pdfParseFn?: (buffer: Buffer) => Promise<{ text: string }>;
  // Confidentiality verdict for the deal the upload is tied to — a boolean, or (what the route
  // passes, built in server/ai/egress-guards.ts) a LIVE predicate that asks the roster. Undefined
  // (no dealId / blank-deal upload) means there is no tied deal to check; mentionsConfidentialDeal
  // below still checks the OM text for every other one. This module takes a verdict rather than a
  // Deal so it never reads the roster itself — mirrors server/ai/comps.ts's pre-network guard.
  //
  // A predicate is evaluated at entry AND again immediately before the network call, because a
  // roster claim can land during the PDF parse (refute wf_fb398b02-494). A throw counts as
  // confidential.
  dealConfidential?: boolean | (() => boolean);
  // Set true by the caller when a dealId WAS supplied but the Deal record couldn't be resolved
  // (brain snapshot unavailable, or an unknown/stale id) — confidentiality can't be verified in
  // that case. This must fail CLOSED rather than silently proceeding as non-confidential, mirroring
  // server/briefing/confidential.ts's fail-closed doctrine for confidentiality gates. Distinct from
  // omitting dealConfidential entirely (no dealId at all — nothing to check against, safe to proceed).
  dealLookupFailed?: boolean;
  // Roster scan of the extracted OM text BEFORE it is sent to Anthropic (cc-audit-army
  // 2026-09-28, om-extract-flag-only-guard): the flags above only cover an upload tied to a known
  // Deal, so a blank-deal upload of a confidential OM skipped every check. Returns a hit (deal
  // label only, never the matched term) or null. Defaults to server/briefing/confidential.ts's
  // scanForConfidential, which THROWS when the roster is unavailable; that fails CLOSED here.
  // Injectable so unit tests need no machine-local roster.
  confidentialScan?: (text: string) => { dealLabel: string } | null;
  // Deal-name gate over the OM text, evaluated right before the network call (#478 item 1): true
  // when the text names ANY deal that is confidential right now — flagged, or claimed by the live
  // roster through a field the OM may not carry (owner/lender). Covers blank-deal uploads and
  // uploads tied to a different (public) deal, which the two flags above never see. The route's
  // version (server/ai/egress-guards.ts) throws when the deal list is unavailable; a throw counts as
  // a hit (fail closed).
  mentionsConfidentialDeal?: (text: string) => boolean;
}

// Fields loaded from om-extract-fields.json — edit that file to add/tune fields without touching this module.
interface OmField {
  key: string;
  desc: string;
  enum?: readonly string[];
}
const EXTRACTABLE_FIELDS: readonly OmField[] = fieldsConfig.fields;

const VALID_KEYS = new Set<string>(EXTRACTABLE_FIELDS.map((f) => f.key));

type OmSchemaProperty =
  | { type: ['string', 'null'] }
  | { anyOf: [{ type: 'string'; enum: readonly string[] }, { type: 'null' }] };

export interface OmExtractJsonSchema {
  type: 'object';
  properties: Record<string, OmSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

/** Builds the Anthropic `output_config.format` JSON Schema from the field manifest.
 *
 *  Every field is REQUIRED and nullable (`type:['string','null']`, or `anyOf` with an
 *  embedded `null` branch for the 3 enum fields) rather than optional-and-omittable. This
 *  is not a style choice — empirically verified against the live API (2026-07-18): a 15-
 *  property schema with NONE required (the "omit what you can't find" shape the Anthropic
 *  docs describe as supported) reliably hits "Grammar compilation timed out" server-side,
 *  even with zero enums. The all-required + nullable shape compiles in ~12s and returns
 *  correct results. The model still expresses "not found" — as an explicit JSON `null`
 *  instead of an omitted key — which extractOmFields()'s existing `typeof v === 'string'`
 *  filter already drops, so "never guess" is preserved with no change to the read path.
 *  Every property here counts against Anthropic's "parameters with union types" limit (16,
 *  separate from the unused "optional parameters" limit of 24) — 16 total is the documented
 *  ceiling (not the trigger point), this schema uses 15, so a 16th field still fits; a 17th
 *  extractable field would need to split into a second schema/call. */
export function buildOmExtractSchema(): OmExtractJsonSchema {
  const properties: Record<string, OmSchemaProperty> = {};
  for (const field of EXTRACTABLE_FIELDS) {
    properties[field.key] = field.enum
      ? { anyOf: [{ type: 'string', enum: field.enum }, { type: 'null' }] }
      : { type: ['string', 'null'] };
  }
  return { type: 'object', properties, required: EXTRACTABLE_FIELDS.map((f) => f.key), additionalProperties: false };
}

const SYSTEM =
  `You are a commercial real estate data extractor. Extract field values from the OM text.\n` +
  `The response is schema-constrained; every listed key will be present in your output.\n` +
  `Rules:\n` +
  `- Only fill in a field when it is stated explicitly in the document with high confidence.\n` +
  `- Use null for any field not clearly present. Do NOT guess or infer.\n` +
  `- Numbers: digits only, no currency symbols, no commas, no units.\n` +
  `- Percentages: 0–100 range (not decimal). Example: "15" not "0.15".\n` +
  `- hasDock / hasDriveIn: output exactly "yes" or "no" (never guess — use null if not stated).\n` +
  `- constructionType: output exactly one of the listed values, or null if not stated.\n` +
  `- If a field is absent or ambiguous, use null.`;

/** A boolean is taken as given; a live predicate is evaluated now, and a throw counts as confidential. */
function isDealConfidential(v: OmExtractOptions['dealConfidential']): boolean {
  if (typeof v !== 'function') return !!v;
  try {
    return v();
  } catch {
    return true;
  }
}

export async function extractOmFields(
  pdfBuffer: Buffer,
  opts: OmExtractOptions,
): Promise<OmExtractResult> {
  // Confidentiality egress guard (mirrors server/ai/comps.ts): a confidential deal's OM text must
  // never reach the Anthropic API. Block before any PDF parse or network call, regardless of
  // API-key state — the caller resolves the Deal and passes `confidential` down BEFORE this call.
  if (isDealConfidential(opts.dealConfidential)) {
    return {
      ok: false,
      error: 'OM extraction is disabled for confidential deals — sending this PDF to the Anthropic API would leak the deal identity externally.',
      status: 403,
    };
  }
  if (opts.dealLookupFailed) {
    return {
      ok: false,
      error: 'Could not verify this deal\'s confidentiality status (deal not found or the brain snapshot is unavailable) — refusing to send OM text externally until this can be confirmed.',
      status: 403,
    };
  }

  if (!opts.apiKey) {
    return { ok: false, error: 'AI extraction requires ANTHROPIC_API_KEY — start the Brain server with a key configured.', status: 500 };
  }

  const parseFn = opts.pdfParseFn ?? pdfToText;

  let text: string;
  try {
    const parsed = await parseFn(pdfBuffer);
    text = parsed.text ?? '';
  } catch {
    return { ok: false, error: 'Failed to parse the PDF — the file may be corrupted or password-protected.', status: 422 };
  }

  if (!text.trim()) {
    return { ok: false, error: 'No extractable text found — this may be a scanned/image-only PDF.', status: 422 };
  }

  // Truncate to ~30 K chars (OMs are rarely longer as structured text)
  const body = text.length > 30_000 ? text.slice(0, 30_000) + '\n[truncated]' : text;

  // Egress roster scan: exactly the text that will leave the machine. Fail closed on any error
  // (missing/unparseable roster) — an unverifiable OM is not sent (Invariant 3).
  try {
    const hit = (opts.confidentialScan ?? scanForConfidential)(body);
    if (hit) {
      return {
        ok: false,
        error: 'OM extraction blocked — this document matches a confidential deal on the roster; sending it to the Anthropic API would leak the deal identity externally.',
        status: 403,
      };
    }
  } catch (err) {
    console.error(`[om-extract] roster scan unavailable, OM blocked: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      error: 'Could not verify this OM against the confidential-deal roster (roster unavailable or unreadable) — refusing to send OM text externally until this can be confirmed.',
      status: 403,
    };
  }

  // Re-take the deal verdict at the egress point: the PDF parse above can take seconds, and the
  // text scan cannot see a claim anchored on a deal-record field the OM text does not carry.
  if (typeof opts.dealConfidential === 'function' && isDealConfidential(opts.dealConfidential)) {
    return {
      ok: false,
      error: 'OM extraction is disabled for confidential deals — sending this PDF to the Anthropic API would leak the deal identity externally.',
      status: 403,
    };
  }

  // Deal-name gate, also at the egress point (after the parse): the OM may name a DIFFERENT deal
  // than the one the upload is tied to.
  if (opts.mentionsConfidentialDeal) {
    let named: boolean;
    try {
      named = opts.mentionsConfidentialDeal(body);
    } catch (err) {
      console.error(`[om-extract] deal-name gate unavailable, OM blocked: ${err instanceof Error ? err.message : String(err)}`);
      named = true;
    }
    if (named) {
      return {
        ok: false,
        error: 'OM extraction blocked — this document names a confidential deal (or the deal list could not be checked); sending it to the Anthropic API would leak the deal identity externally.',
        status: 403,
      };
    }
  }

  const fieldManifest = EXTRACTABLE_FIELDS.map((f) => `- ${f.key}: ${f.desc}`).join('\n');
  const userPrompt = `Extract these fields from the OM text:\n${fieldManifest}\n\nOM TEXT:\n${body}`;

  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  // 45s (was 20s): a cold structured-outputs schema compile empirically took ~12s in testing
  // (2026-07-18) with real load-dependent variance — Anthropic caches compiled grammars for
  // 24h from last use, so only a first-of-the-day (or first-ever) request pays this cost.
  const timeout = setTimeout(() => ac.abort(), 45_000);
  let res: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  try {
    res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Haiku: structured extraction from text — no reasoning required, haiku is sufficient and fast.
        model: opts.model ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
        // Structured outputs: constrains the response to this schema, eliminating the
        // markdown-fence / preamble / truncation failures a prompt-only instruction can't prevent.
        output_config: { format: { type: 'json_schema', schema: buildOmExtractSchema() } },
      }),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    if (!timedOut) console.error('[om-extract] network error reaching AI service:', e);
    const msg = timedOut
      ? 'AI service request timed out — try again in a moment.'
      : 'Network error reaching the AI service.';
    return { ok: false, error: msg, status: 503 };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    if (res.status === 503 || res.status === 529) {
      return { ok: false, error: 'AI service temporarily unavailable — try again in a moment.', status: 503 };
    }
    const detail = await res.text().catch(() => '');
    console.error(`[om-extract] AI service ${res.status}:`, detail.slice(0, 200));
    return { ok: false, error: `AI service error (${res.status}).`, status: 502 };
  }

  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = (json.content ?? []).find((b) => b.type === 'text');
  if (!textBlock?.text) {
    return { ok: false, error: 'AI service returned an empty extraction.', status: 422 };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(textBlock.text);
  } catch {
    return { ok: false, error: 'AI returned malformed JSON — try again.', status: 422 };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'AI returned unexpected response format — try again.', status: 422 };
  }

  // Strip unknown keys and non-string values
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (VALID_KEYS.has(k) && typeof v === 'string' && v.trim() !== '') {
      fields[k] = v.trim();
    }
  }

  const fieldCount = Object.keys(fields).length;
  return { ok: true, fields, fieldCount, ...(fieldCount === 0 ? { rawText: body } : {}) };
}
