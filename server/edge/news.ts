// server/edge/news.ts
//
// Read-only loader for the Oxford Edge news overlay (news_overlay.json, beside markets.json). The
// overlay is a dated annotation layer: it never feeds a series, rank or score. Imports exactly one
// fs function, readFileSync (tests/unit/edge-news.test.tsx fails if any other fs call appears here).
// Fail closed like the dataset loader: a missing, unreadable or invalid overlay is reported as such
// and is never presented as current; error text is sanitized (errno code / fixed strings / Zod path + code).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EdgeNewsEntry, type EdgeNewsResponse } from '../../src/contracts/edge';
import { EDGE_STALE_DAYS } from './config';
import { isRealIsoDate } from './freshness';

export const NEWS_FILE = 'news_overlay.json';
const DAY_MS = 86_400_000;

export interface EdgeNewsFsDeps {
  readFile: (path: string) => string;
}
export const NODE_NEWS_FS: EdgeNewsFsDeps = { readFile: (path) => readFileSync(path, 'utf8') };

/** Strict: an upstream key rename or addition fails loudly as `invalid`. */
export const RawEdgeNews = z
  .object({
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    headline: z.string().max(600),
    entries: z.array(EdgeNewsEntry.strict()),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.entries.forEach((e, i) => {
      if (seen.has(e.marketId)) ctx.addIssue({ code: 'custom', path: ['entries', i, 'marketId'], message: 'duplicate marketId' });
      seen.add(e.marketId);
    });
  });

function errCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null;
}

function empty(availability: EdgeNewsResponse['availability'], issues: string[]): EdgeNewsResponse {
  return { availability, asOf: null, ageDays: null, staleAfterDays: EDGE_STALE_DAYS, stale: true, headline: null, entries: [], issues };
}

export function loadEdgeNews(dir: string, now: Date, deps: EdgeNewsFsDeps = NODE_NEWS_FS): EdgeNewsResponse {
  let text: string;
  try {
    text = deps.readFile(join(dir, NEWS_FILE));
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return empty('missing', []);
    return empty('unreadable', [code !== null && /^[A-Z0-9_]{1,20}$/.test(code) ? `read failed (${code})` : 'read failed']);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty('unreadable', [`${NEWS_FILE} is not valid JSON`]);
  }
  const parsed = RawEdgeNews.safeParse(json);
  if (!parsed.success) {
    return empty('invalid', parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`));
  }
  const { asOf, headline, entries } = parsed.data;
  const today = now.toISOString().slice(0, 10);
  const dateOk = isRealIsoDate(asOf);
  const rawAge = dateOk ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS) : NaN;
  const ageDays = Number.isFinite(rawAge) ? Math.max(0, rawAge) : 0;
  return {
    availability: 'ok',
    asOf,
    ageDays,
    staleAfterDays: EDGE_STALE_DAYS,
    // A future or unreal asOf fails closed to stale, the same as the dataset freshness rule.
    stale: !dateOk || !Number.isFinite(rawAge) || rawAge < 0 || ageDays > EDGE_STALE_DAYS,
    headline,
    entries,
    issues: [],
  };
}
