// server/warehouse/om-extract.ts
// pdf-parse ships no type declarations; the lib/ path avoids its debug-on-import index.
// @ts-expect-error -- pdf-parse has no type declarations
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export type OmExtractResult =
  | { ok: true; fields: Record<string, string>; fieldCount: number }
  | { ok: false; error: string };

export interface OmExtractOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  // Injectable for tests — avoids needing to vi.mock the pdf-parse module
  pdfParseFn?: (buffer: Buffer) => Promise<{ text: string }>;
}

// Fields Claude can reliably extract from a standard OM. Key = FormState key (string format).
const EXTRACTABLE_FIELDS = [
  { key: 'price',           desc: 'Asking/offering price in dollars. Number only, no $ or commas. OM synonyms: asking price, list price, offering price.' },
  { key: 'totalSf',         desc: 'Total gross building area in square feet. Number only. OM synonyms: GBA, gross building area, building size, total SF.' },
  { key: 'maxBuildingSf',   desc: 'Largest single building SF. If single building use same value as totalSf. OM synonyms: largest building, max building SF.' },
  { key: 'yearBuilt',       desc: 'Year the building was constructed (4-digit integer). OM synonyms: year built, constructed, vintage.' },
  { key: 'clearHeightFt',   desc: 'Interior clear ceiling height in feet. Number only. OM synonyms: clear height, clear ceiling height.' },
  { key: 'officePct',       desc: 'Office percentage of total building area, 0–100 (NOT decimal). OM synonyms: office percentage, office buildout, office ratio.' },
  { key: 'constructionType',desc: 'Output exactly one of: block-tilt-brick (masonry/tilt-up/block/brick), mixed, pemb (all-metal/pre-engineered), unknown.' },
  { key: 'hasDock',         desc: 'Whether the property has dock-high loading doors. Output: yes or no.' },
  { key: 'dockCount',       desc: 'Number of dock doors (integer). OM synonyms: dock doors, loading docks.' },
  { key: 'hasDriveIn',      desc: 'Whether the property has grade-level drive-in doors. Output: yes or no. OM synonyms: drive-in doors, grade-level doors.' },
  { key: 'driveInCount',    desc: 'Number of drive-in doors (integer). OM synonyms: grade-level door count.' },
  { key: 'truckCourtFt',    desc: 'Truck court depth in feet. Number only. OM synonyms: truck court depth, maneuvering depth.' },
  { key: 'inPlaceRentPsf',  desc: 'Current in-place rent in $/SF/year (NNN). Number only. OM synonyms: current rent, in-place rent, contract rent.' },
  { key: 'marketRentPsf',   desc: 'Market rent in $/SF/year (NNN). Number only. OM synonyms: market rent, asking rent.' },
  { key: 'waltYears',       desc: 'Weighted average lease term remaining in years (decimal ok). OM synonyms: WALT, weighted average lease term, remaining lease term.' },
] as const;

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
  if (!opts.apiKey) {
    return { ok: false, error: 'AI extraction requires ANTHROPIC_API_KEY — start the Brain server with a key configured.' };
  }

  const parseFn = opts.pdfParseFn ?? ((buf: Buffer) => (pdfParse(buf) as Promise<{ text: string }>));

  let text: string;
  try {
    const parsed = await parseFn(pdfBuffer);
    text = parsed.text ?? '';
  } catch {
    return { ok: false, error: 'Failed to parse the PDF — the file may be corrupted or password-protected.' };
  }

  if (!text.trim()) {
    return { ok: false, error: 'No extractable text found — this may be a scanned/image-only PDF.' };
  }

  // Truncate to ~30 K chars (OMs are rarely longer as structured text)
  const body = text.length > 30_000 ? text.slice(0, 30_000) + '\n[truncated]' : text;

  const fieldManifest = EXTRACTABLE_FIELDS.map((f) => `- ${f.key}: ${f.desc}`).join('\n');
  const userPrompt = `Extract these fields from the OM text:\n${fieldManifest}\n\nOM TEXT:\n${body}`;

  const f = opts.fetchImpl ?? fetch;
  let res: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  try {
    res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
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
    return { ok: false, error: `Network error reaching AI service: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) {
    if (res.status === 503 || res.status === 529) {
      return { ok: false, error: 'AI service temporarily unavailable — try again in a moment.' };
    }
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `AI service error (${res.status}): ${detail.slice(0, 200)}` };
  }

  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = (json.content ?? []).find((b) => b.type === 'text');
  if (!textBlock?.text) {
    return { ok: false, error: 'AI service returned an empty extraction.' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(textBlock.text);
  } catch {
    return { ok: false, error: 'AI returned malformed JSON — try again.' };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'AI returned unexpected response format — try again.' };
  }

  // Strip unknown keys and non-string values
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (VALID_KEYS.has(k) && typeof v === 'string' && v.trim() !== '') {
      fields[k] = v.trim();
    }
  }

  return { ok: true, fields, fieldCount: Object.keys(fields).length };
}
