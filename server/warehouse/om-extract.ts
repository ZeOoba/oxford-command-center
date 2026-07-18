// server/warehouse/om-extract.ts
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
  // Confidentiality egress guard input — the caller (route) resolves the Deal and passes its
  // `confidential` flag down. Undefined (no dealId / blank-deal upload) means nothing to check
  // against, so extraction proceeds. See the block below for why this stays a bare boolean rather
  // than a full Deal import — mirrors server/ai/comps.ts's pre-network confidentiality guard.
  dealConfidential?: boolean;
  // Set true by the caller when a dealId WAS supplied but the Deal record couldn't be resolved
  // (brain snapshot unavailable, or an unknown/stale id) — confidentiality can't be verified in
  // that case. This must fail CLOSED rather than silently proceeding as non-confidential, mirroring
  // server/briefing/confidential.ts's fail-closed doctrine for confidentiality gates. Distinct from
  // omitting dealConfidential entirely (no dealId at all — nothing to check against, safe to proceed).
  dealLookupFailed?: boolean;
}

// Fields loaded from om-extract-fields.json — edit that file to add/tune fields without touching this module.
const EXTRACTABLE_FIELDS = fieldsConfig.fields;

const VALID_KEYS = new Set<string>(EXTRACTABLE_FIELDS.map((f) => f.key));

const SYSTEM =
  `You are a commercial real estate data extractor. Extract field values from the OM text.\n` +
  `Return ONLY a JSON object — no markdown, no explanation, no code fences.\n` +
  `Keys are the exact field names listed. Values are strings.\n` +
  `Rules:\n` +
  `- Include ONLY fields stated explicitly in the document with high confidence.\n` +
  `- Omit any field not clearly present. Do NOT guess or infer.\n` +
  `- Numbers: digits only, no currency symbols, no commas, no units.\n` +
  `- Percentages: 0–100 range (not decimal). Example: "15" not "0.15".\n` +
  `- hasDock / hasDriveIn: output exactly "yes" or "no".\n` +
  `- constructionType: output exactly one of the listed values.\n` +
  `- If a field is absent or ambiguous, omit it.`;

export async function extractOmFields(
  pdfBuffer: Buffer,
  opts: OmExtractOptions,
): Promise<OmExtractResult> {
  // Confidentiality egress guard (mirrors server/ai/comps.ts): a confidential deal's OM text must
  // never reach the Anthropic API. Block before any PDF parse or network call, regardless of
  // API-key state — the caller resolves the Deal and passes `confidential` down BEFORE this call.
  if (opts.dealConfidential) {
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

  const fieldManifest = EXTRACTABLE_FIELDS.map((f) => `- ${f.key}: ${f.desc}`).join('\n');
  const userPrompt = `Extract these fields from the OM text:\n${fieldManifest}\n\nOM TEXT:\n${body}`;

  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 20_000);
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
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError'
      ? 'AI service request timed out — try again in a moment.'
      : `Network error reaching AI service: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, error: msg, status: 503 };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    if (res.status === 503 || res.status === 529) {
      return { ok: false, error: 'AI service temporarily unavailable — try again in a moment.', status: 503 };
    }
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `AI service error (${res.status}): ${detail.slice(0, 200)}`, status: 502 };
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
