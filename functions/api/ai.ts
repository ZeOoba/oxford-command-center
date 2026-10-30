/**
 * Cloudflare Pages Function — the deployed mirror's AI endpoint.
 *
 * Streams the SAME tool-using agent the Brain Server runs (server/ai/agent.ts), so the mirror
 * and local app behave identically. The agent reads the BAKED snapshot via the ASSETS binding,
 * calls Anthropic server-side with a Cloudflare SECRET (`wrangler pages secret put
 * ANTHROPIC_API_KEY`), and emits SSE frames: `tool` / `text` / `done` / `error`.
 *
 * Inherits Cloudflare Access (same hostname). With no key, the agent falls back to the
 * deterministic responder and streams that — never a silent canned stub.
 *
 * Hardening (audit 2026-09-25):
 *  - the request body goes through the SAME sanitizeAgentInput as the Brain Server: forged or
 *    malformed history turns are dropped and every spend-bearing length is capped;
 *  - a per-identity sliding-window rate limit bounds Anthropic spend per Access user (best-effort:
 *    the window lives in this isolate's memory, so it resets on a cold start and is not shared
 *    across colos — a durable limit needs KV/Durable Objects; this closes the trivial-abuse case).
 *    The identity is the VERIFIED Access JWT email (functions/_shared/access-identity.ts, the same
 *    path whoami uses), never the forgeable Cf-Access-Authenticated-User-Email header. With
 *    ACCESS_REQUIRE=1 a request that fails verification is refused (403, or 503 when Access config
 *    or the JWKS is unavailable) before any snapshot read or model call; ACCESS_REQUIRE set to
 *    anything but '1' or '0' is a 503 config error. Inert mode (ACCESS_REQUIRE unset, empty or '0', e.g.
 *    local dev) keys on CF-Connecting-IP instead, IPv6 collapsed to its /64 (rateLimitKeyForIp);
 *  - an edge confidentiality scan (OI-225 counterpart) derived from the baked snapshot's own
 *    `confidential:true` deals runs over the question, the history and every tool result,
 *    mirroring the roster-based guard the Brain Server injects. The mirror has no roster on disk,
 *    so the deal names the snapshot itself carries are the only terms available here — the
 *    tool-layer flag filter remains the first line.
 *
 * Refute round 5, F2 (fail closed when the scan cannot run):
 *  - On the REDACTED mirror the snapshot carries no `confidential:true` deal, so there are no terms
 *    and edgeConfidentialScan returns undefined. runAgent then skips BOTH its question/history scan
 *    and its tool-result scan, so a question naming a confidential deal reached Anthropic unscanned.
 *    onRequestPost now REFUSES any request that would call Anthropic (an API key is configured)
 *    when no scan is available. PRODUCT CONSEQUENCE: with an API key set, the mirror AI endpoint is
 *    disabled on every bake that carries no flagged deal (every redacted bake), because it cannot
 *    scan the question. The deterministic responder (no API key) never egresses and is still served.
 *  - When the scan exists (a FULL, Access-gated bake), it is the shared normalised roster matcher
 *    (server/briefing/roster-core.ts matchRosterTerms: raw + normalised + compact passes, keys and
 *    split sibling leaves), not a raw substring check, so NBSP / hyphen / zero-width variants of a
 *    flagged deal's name or shortName are caught. Residual, unchanged: on the mirror the terms are
 *    the flagged deals' names only, never the roster's address / context terms. Since the merge of
 *    origin/main's normaliser (c04bf53b) the scan is the OR of that matcher and main's normalised
 *    edge scan (see edgeConfidentialScan).
 *  - Rejected alternative: baking a derived roster form into the mirror so the redacted endpoint
 *    could scan. The mirror is an external surface. Raw terms can never go there. An unkeyed hash
 *    of low-entropy terms (street addresses, deal names) is reversible by dictionary attack, so it
 *    is not a safe derived form. A keyed HMAC would need a new secret on both the bake machine and
 *    Cloudflare. Refusing is the safest option that publishes nothing.
 */
import { PortfolioSnapshot } from '../../src/contracts/index';
import { runAgent, sanitizeAgentInput, type AgentEvent } from '../../server/ai/agent';
import { matchRosterTerms } from '../../server/briefing/roster-core';
import type { DealTerms } from '../../server/briefing/confidential';
import { formsContain, normalizeForScan, scanTexts } from '../../server/briefing/confidential-normalize';
import { createAccessIdentityResolver, type AccessEnv, type AccessIdentityDeps } from '../_shared/access-identity';
import { fetchAccessJwks } from '../_shared/access-jwt';

interface Env extends AccessEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_EFFORT?: string;
  ASSETS: { fetch: (input: Request | string) => Promise<Response> };
}
interface PagesContext {
  request: Request;
  env: Env;
}

const sseHeaders = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
};

function frame(e: AgentEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** Sliding-window limit per identity: RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS. */
export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const windows = new Map<string, number[]>();

export type AiDeps = AccessIdentityDeps;

const accessIdentity = createAccessIdentityResolver();

/** Test hook: drop the JWKS cache used to verify the caller. */
export function resetAiIdentityCache(): void {
  accessIdentity.reset();
}

const jsonError = (error: string, status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

/** Returns true when the request is within budget (and records it), false when it must be refused. */
export function admit(id: string, now = Date.now()): boolean {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const hits = (windows.get(id) ?? []).filter((t) => t > cutoff);
  if (hits.length >= RATE_LIMIT_MAX) {
    windows.set(id, hits);
    return false;
  }
  hits.push(now);
  windows.set(id, hits);
  // Keep the map bounded: drop identities whose window has fully expired.
  if (windows.size > 1_000) {
    for (const [k, v] of windows) if (!v.some((t) => t > cutoff)) windows.delete(k);
  }
  return true;
}

/** Test seam — clears the in-memory windows. */
export function resetRateLimit(): void {
  windows.clear();
}

/** Expand an IPv6 address (no zone id) to its 8 hextets, or null when it is not valid IPv6. An
 *  IPv4-dotted tail (::ffff:a.b.c.d) counts as two hextets. */
function ipv6Hextets(addr: string): string[] | null {
  let s = addr;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, v4.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const all = [...head, ...tail];
  if (all.some((h) => !/^[0-9a-f]{1,4}$/i.test(h))) return null;
  if (halves.length === 1) return all.length === 8 ? all : null;
  if (all.length > 7) return null;
  return [...head, ...Array<string>(8 - all.length).fill('0'), ...tail];
}

/** Inert-mode rate-limit key for the CF-Connecting-IP (adversarial review 2026-10-30, C5). IPv4 is
 *  keyed as-is. IPv6 collapses to its /64 (`ip6:<first 4 hextets>::/64`, leading zeros dropped,
 *  lowercase): a single subscriber is routinely handed a whole /64, so keying the exact address gave
 *  one caller ~2^64 independent budgets. An IPv4-mapped (::ffff:0:0/96), IPv4-translated
 *  (::ffff:0:0:0/96) or NAT64 well-known-prefix (64:ff9b::/96) address keys as its embedded IPv4. */
export function rateLimitKeyForIp(raw: string | null | undefined): string {
  const ip = (raw ?? '').trim();
  if (!ip) return 'ip:unknown';
  if (!ip.includes(':')) return `ip:${ip}`;
  const hextets = ipv6Hextets(ip.split('%')[0]!);
  if (!hextets) return `ip:${ip.toLowerCase()}`;
  const h = hextets.map((x) => parseInt(x, 16));
  const v4 = () => `ip:${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`;
  // ::ffff:a.b.c.d (IPv4-mapped): the caller is an IPv4 client.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return v4();
  // ::ffff:0:a.b.c.d (RFC 2765 IPv4-translated) and 64:ff9b::a.b.c.d (RFC 6052 NAT64 well-known
  // prefix): the low 32 bits are the client's IPv4. Keying the /64 would put every client behind
  // one translator on a single budget (round 2, 2026-10-30).
  if (h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0) return v4();
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4();
  return `ip6:${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** Roster-free confidential scan built from the snapshot's own flagged deals (see header): the
 *  deal's name AND its shortName (scripts/bake-mirror.ts residue-sweep parity). undefined when the
 *  snapshot flags no deal: the caller must then refuse anything that would egress (F2).
 *
 *  Union of BOTH scanners (reconciliation with origin/main c04bf53b): main's normalised edge scan
 *  (confidential-normalize: NFKD / invisible / bidi-reversed / superscript / digit-group forms over
 *  the legacy AND extended flattenings, so Error / AggregateError / URL values are read) OR the
 *  roster-core matcher (raw + normalised + compact + sibling / stream / concat passes, keys, line-end
 *  hyphens, private-use and unassigned characters). Neither is a superset of the other, so a value
 *  is refused when EITHER hits (fail closed). */
export function edgeConfidentialScan(snapshot: PortfolioSnapshot): ((value: unknown) => { dealLabel: string } | null) | undefined {
  const terms: Record<string, DealTerms> = {};
  snapshot.deals.forEach((d, i) => {
    if (!d.confidential) return;
    const always = [d.name, d.shortName].map((t) => (t ?? '').trim()).filter((t) => t.length >= 3);
    if (always.length > 0) terms[`edge-${i}`] = { label: d.name, active: true, always };
  });
  if (Object.keys(terms).length === 0) return undefined;
  const needles = Object.values(terms).flatMap((d) => (d.always ?? []).map((needle) => ({ label: d.label ?? '', needle })));
  const mainEdgeScan = (value: unknown): { dealLabel: string } | null => {
    // Normalized (zero-width / NBSP / fullwidth / accent-proof) like the server-side scanner, over the
    // same two flattenings; the module is pure, so it is safe on the edge.
    const hays = scanTexts(value).map((t) => normalizeForScan(t));
    for (const t of needles) if (hays.some((h) => formsContain(h, t.needle))) return { dealLabel: t.label };
    return null;
  };
  return (value: unknown) => mainEdgeScan(value) ?? matchRosterTerms(value, terms);
}

/** The refusal streamed when the scan is unavailable and the request would reach Anthropic (F2).
 *  Names no deal and no term. */
export const MIRROR_SCAN_UNAVAILABLE_MESSAGE =
  'Refusing to send: this mirror cannot run the confidential-deal check on questions (its snapshot ' +
  'carries no confidential-deal terms), so the AI assistant is disabled here. The request was ' +
  'stopped before reaching the API.';

export function onRequestPost(context: PagesContext): Promise<Response> {
  return handleAiPost(context, {
    fetchJwks: fetchAccessJwks,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  });
}

export async function handleAiPost(context: PagesContext, deps: AiDeps): Promise<Response> {
  const { request, env } = context;
  // Identity first: an unverified caller is refused before the body, the snapshot or the model.
  const who = await accessIdentity.resolve(request, env, deps);
  if (who.kind === 'denied') {
    console.warn('[ai] denied:', who.reason);
    return jsonError(who.status === 503 ? 'unavailable' : 'forbidden', who.status);
  }
  // Verified email when Access is enforced; otherwise (inert / local dev) the connecting IP. The
  // plain email header is never a key: it is forgeable off the Access path.
  const rateKey = who.kind === 'verified' ? `user:${who.email.toLowerCase()}` : rateLimitKeyForIp(request.headers.get('cf-connecting-ip'));

  const body: unknown = await request.json().catch(() => ({}));
  const input = sanitizeAgentInput(body);
  if (!input.ok) {
    return new Response(JSON.stringify({ error: input.error }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (!admit(rateKey)) {
    return jsonError('Too many requests — try again in a few minutes.', 429, { 'retry-after': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) });
  }
  const { question, history } = input;

  // Read + validate the baked snapshot (internal ASSETS binding — no Access round-trip).
  let snapshot: PortfolioSnapshot | null = null;
  try {
    const res = await env.ASSETS.fetch(new URL('/snapshot.json', request.url).toString());
    if (res.ok) snapshot = PortfolioSnapshot.parse(await res.json());
  } catch {
    /* fall through */
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(frame(e)));
      if (!snapshot) {
        emit({ type: 'error', message: 'The portfolio snapshot is unavailable on the mirror right now.' });
        controller.close();
        return;
      }
      const confidentialScan = edgeConfidentialScan(snapshot);
      // F2: fail closed. With a key, runAgent sends the question to Anthropic, and with no scan it
      // would skip every confidentiality check. Without a key it runs the local responder only.
      if (!confidentialScan && env.ANTHROPIC_API_KEY) {
        emit({ type: 'error', message: MIRROR_SCAN_UNAVAILABLE_MESSAGE });
        controller.close();
        return;
      }
      await runAgent({
        question,
        history,
        snapshot,
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
        effort: env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high' | 'max' | undefined,
        confidentialScan,
        emit,
      });
      controller.close();
    },
  });

  return new Response(stream, { headers: sseHeaders });
}
