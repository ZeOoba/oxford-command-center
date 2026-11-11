// scripts/fixtures/build-synthetic-data.ts
//
// Deterministic transformer: reads the REAL local data files listed in
// scripts/fixtures/real-data-manifest.json and writes synthetic stand-ins to
// fixtures/synthetic/<same repo-relative path>. Real firm data is never tracked (ruling 2026-11-10);
// the synthetic copies are what CI, fresh clones and the test suite run against.
//
// This source contains NO real names, addresses or figures. It reads them at run time from the local
// (gitignored) files and replaces them:
//   - tenant / person / company / lender / carrier / vendor / deal / counterparty names, emails,
//     policy numbers and parcel ids become deterministic fakes ("Tenant 017 LLC", "Contact 03",
//     "Lender 02", "contact-03@example.com", ...). Lease, deal, loan, counterparty and observation ids
//     are recomputed from the fake names with the repo's own slug() so every cross-reference
//     (lease -> property, arrears -> lease, counterparty links -> deal/loan, supersedes -> obs_id,
//     notionDealId uniqueness) still holds.
//   - free text (notes, findings, task labels, deal status...) becomes "Synthetic <field> NNN.",
//     keeping only the handful of keywords the code parses (OCR, UNVERIFIED, inferred, confirm).
//   - every currency amount (and every "$1,234" inside kept text) is multiplied by ONE scale factor
//     and rounded to 6 decimals, so sums and ratios (NOI, DSCR, LTV, cap rate, rent per SF) are
//     preserved. SF, counts, dates, rates and percentages are unchanged.
//   - owned-property identities (property names, addresses, ids, property keys) are KEPT: they are
//     already hardcoded across tracked code (server/warehouse/property-master.ts, the property-
//     financials contract and entity registry, the workbook parser), so renaming them in the
//     fixtures would break those joins without making anything less public.
//
// The scale factor is NOT in this file (the repo is public; a committed factor would let anyone
// divide it back out). It comes from SYNTH_SCALE_FACTOR or the gitignored local file
// fixtures/.synthetic-scale-factor.local, and must be a non-round factor with at most 4 decimals.
//
// Usage:
//   npx tsx scripts/fixtures/build-synthetic-data.ts            # regenerate fixtures/synthetic/**
//   npx tsx scripts/fixtures/build-synthetic-data.ts --check    # leak-check fixtures only (no writes)
//   npx tsx scripts/fixtures/build-synthetic-data.ts --check -- <file>...  # leak-check these files instead
//   add --src <dir> to read the real files from <dir> (laid out like the repo) instead of the checkout
//   add --phrases-only to the check to search for whole registered names only (no word tokens)
//   add --tracked to the check to scan every tracked file of the checkout instead of the fixtures
//
// After writing, it always runs the leak check: a term list built at run time from the real files'
// name / address / tenant / company / person / email fields (plus their distinctive word tokens) is
// grepped across every synthetic output; any hit fails the run (exit 1). Hits are reported by
// file:line and term length only, never by the real term.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { slug } from '../../src/contracts/common';
import { canonicalAttribute } from '../../src/analytics/building-specs';
import { rentStepEvents } from '../../src/analytics/property-financials/metrics';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = join(ROOT, 'fixtures', 'synthetic');
const SCALE_FILE = join(ROOT, 'fixtures', '.synthetic-scale-factor.local');

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

// ── manifest ────────────────────────────────────────────────────────────────────────────────────

interface Manifest {
  files: string[];
  dirs: string[];
}

function loadManifest(root: string): Manifest {
  const m = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'real-data-manifest.json'), 'utf8')) as Manifest;
  return { files: m.files, dirs: m.dirs };
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** Every real local file the manifest covers (exact files + everything under the dirs). */
function realFiles(root: string, m: Manifest): string[] {
  const out = m.files.filter((f) => existsSync(join(root, f)));
  for (const d of m.dirs) out.push(...listFiles(join(root, d)).map((p) => relative(root, p).replace(/\\/g, '/')));
  return out;
}

// ── scale ───────────────────────────────────────────────────────────────────────────────────────

function loadScale(): number {
  const raw = (process.env.SYNTH_SCALE_FACTOR ?? (existsSync(SCALE_FILE) ? readFileSync(SCALE_FILE, 'utf8') : '')).trim();
  if (!raw) {
    throw new Error(
      'No scale factor: set SYNTH_SCALE_FACTOR or write it to fixtures/.synthetic-scale-factor.local (gitignored). ' +
        'It is deliberately not committed.',
    );
  }
  const f = Number(raw);
  const decimals = (raw.split('.')[1] ?? '').length;
  if (!Number.isFinite(f) || f <= 0.2 || f >= 0.95 || decimals > 4 || Number.isInteger(f * 100)) {
    throw new Error('Scale factor must be in (0.2, 0.95), non-round, with at most 4 decimals.');
  }
  return f;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

// ── aliasing ────────────────────────────────────────────────────────────────────────────────────

type Category =
  | 'company'
  | 'person'
  | 'contact'
  | 'firm'
  | 'lender'
  | 'carrier'
  | 'vendor'
  | 'deal'
  | 'dealShort'
  | 'policy'
  | 'parcel'
  | 'arName'
  | 'note';

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

const FORMAT: Record<Category, (n: number) => string> = {
  company: (n) => `Tenant ${pad(n, 3)} LLC`,
  person: (n) => `Person ${pad(n, 3)}`,
  contact: (n) => `Contact ${pad(n, 2)}`,
  firm: (n) => `Firm ${pad(n, 2)}`,
  lender: (n) => `Lender ${pad(n, 2)}`,
  carrier: (n) => `Carrier ${pad(n, 2)}`,
  vendor: (n) => `Vendor ${pad(n, 2)}`,
  deal: (n) => `Pipeline Deal ${pad(n, 2)}`,
  dealShort: (n) => `PD${pad(n, 2)}`,
  policy: (n) => `POL-${pad(n, 4)}`,
  parcel: (n) => `000-${pad(n, 6)}-00`,
  arName: (n) => `AR Tenant ${pad(n, 3)}`,
  note: (n) => `Note Party ${pad(n, 2)}`,
};

/** Categories whose distinctive word tokens are also replaced wherever they appear (variants). */
const TOKEN_SOURCES: ReadonlySet<Category> = new Set(['company', 'person', 'contact', 'firm', 'lender', 'carrier', 'vendor', 'deal', 'arName', 'note']);

/** Words too generic to identify anyone; never treated as distinctive tokens. Structural English
 *  and business vocabulary only — no names. */
const GENERIC = new Set(
  (
    'the and of for at in on an by to with from via per a as or not no new old llc inc co corp corporation company companies ' +
    'group services service solutions enterprises enterprise holdings holding partners partnership trust llp lp ltd pllc pc dba ' +
    'associates association assoc international national american america usa us bank banking insurance ins life mutual surplus lines ' +
    'specialty management properties property realty real estate assets asset capital investments investment development developers ' +
    'industrial industries supply supplies transport transportation trucking logistics freight construction contractors contracting ' +
    'contractor flooring floors repair repairs auto automotive equipment rental rentals storage center centre plaza park office offices ' +
    'business law legal title consulting consultants consultant engineering engineers environmental church ministries academy school ' +
    'dance fitness health medical dental care family foods food market express systems system tech technologies technology network ' +
    'computing cleaning maintenance delivery pool spa home homes design designs studio studios works shop shops store stores sales ' +
    'distribution distributors wholesale manufacturing products product marine containers closets interiors staged styled garage doors ' +
    'door plumbing electric electrical heating cooling hvac roofing paving concrete landscaping lawn tile tops granite wood specialties ' +
    'mechanical machine machining fabrication welding glass signs printing graphics media marketing advertising billboard outdoor ' +
    'able accessories advisors affiliate agriculture air aircraft area assessment auction baseball bay best blue brands budget build ' +
    'builders casualty chem coast coastline coatings comment complete component components connection counters covering crest crossed ' +
    'department dialysis diesel dig division dog dollar dry earth eastern elite end entrepreneurship equipped exteriors extractions ' +
    'farms fire fully general golden graphic green high hospital ideal imaging impact innovations insite karate laboratory landscape ' +
    'last lawncare leasing letter line link log low masonry mechanic men mile mortgage obedience online performance photo play point ' +
    'pools port pressure priorities pro project proposal protection quote range record recovery research rock roofer safe safety salon ' +
    'segregation security shield shore sky smiles sons spice spirit stairs stone strategies student success threat tire towing trade ' +
    'triple truck unidentified unlimited upgraded ventures virgin visuals walls white woodworking more past non cost costs report ' +
    'reports survey study studies group alarm sprinkler sprinklers roof roofs site sites code codes zoning paint painting electricians ' +
    'delaware illinois maryland missouri florida ohio indiana michigan wisconsin iowa kansas tennessee virginia pennsylvania ' +
    'franklin hamilton jackson kent butler ottawa clay wyandotte warren clermont howard baltimore talbot wicomico prince george ' +
    'georges montgomery anne arundel dorchester worcester mark pca tax taxes comfort quasi refi tenant tenants insured ' +
    'training transit movers moving local united first one two three main street road ave avenue drive lane court highway hwy ' +
    'blvd boulevard route way place circle north south east west northeast northwest southeast southwest suite unit units building ' +
    'buildings portfolio jr sr ii iii iv mr mrs ms dr st rd ln ct pkwy loan loans note notes share borrower lender ' +
    'internal oxford financial finance funding fund funds bancorp savings federal credit union county city state ' +
    'township twp common pleas case foreclosure'
  ).split(/\s+/),
);

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().replace(/\s+/g, ' ');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordTokens(s: string): string[] {
  return (s.match(/[A-Za-z][A-Za-z']*/g) ?? []).map((t) => t.toLowerCase().replace(/'s$/, '').replace(/'/g, ''));
}

class Aliases {
  private counters = new Map<Category, number>();
  private byReal = new Map<string, string>(); // `${cat}|${real}` -> fake
  /** lowercased variant -> replacement (exact, slug and normalized forms). */
  private phrases = new Map<string, string>();
  private tokens = new Map<string, string>();
  private tokenCount = 0;
  /** Real strings registered for replacement — the leak term list. */
  readonly realTerms = new Set<string>();
  readonly protectedTokens = new Set<string>();
  private phraseRe: RegExp | null = null;
  private tokenRe: RegExp | null = null;

  protect(s: string | null | undefined): void {
    if (!s || typeof s !== 'string') return;
    for (const t of wordTokens(s)) this.protectedTokens.add(t);
    for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) if (t) this.protectedTokens.add(t);
  }

  alias(cat: Category, real: string | null | undefined): string | null {
    if (real === null || real === undefined) return null;
    const r = real.trim();
    if (!r) return real;
    const key = `${cat}|${r.toLowerCase()}`;
    let fake = this.byReal.get(key);
    if (fake === undefined) {
      // A real string already aliased under another category keeps its first alias (one fake per real).
      const prior = this.phrases.get(r.toLowerCase());
      if (prior !== undefined) {
        fake = prior;
      } else {
        const n = (this.counters.get(cat) ?? 0) + 1;
        this.counters.set(cat, n);
        fake = FORMAT[cat](n);
      }
      this.byReal.set(key, fake);
      // A name that is nothing but an owned property's words (a closing or refinance recorded as a
      // deal, an LLC named for its building) aliases its own field but is not hunted elsewhere:
      // the property identity it shares is kept everywhere on purpose.
      if (!this.namesOnlyProperty(r)) {
        this.addPhrase(r, fake);
        if (TOKEN_SOURCES.has(cat)) for (const t of wordTokens(r)) this.addToken(t);
      }
    }
    return fake;
  }

  private namesOnlyProperty(r: string): boolean {
    const toks = wordTokens(r).filter((t) => t.length >= 2 && !GENERIC.has(t));
    return toks.length > 0 && toks.every((t) => this.protectedTokens.has(t));
  }

  /** Register an explicit real -> fake mapping (ids recomputed by the caller). */
  map(real: string, fake: string): void {
    if (real === fake) return;
    this.addPhrase(real, fake, false);
  }

  private addPhrase(real: string, fake: string, variants = true): void {
    const add = (k: string, v: string): void => {
      if (k.length < 4 || !/[a-z]/i.test(k) || this.phrases.has(k)) return;
      this.phrases.set(k, v);
      this.phraseRe = null;
    };
    add(real.toLowerCase(), fake);
    this.realTerms.add(real);
    if (!variants) return;
    const s = slug(real);
    if (s && s !== real.toLowerCase()) add(s, slug(fake));
    const n = normKey(real);
    if (n && n !== real.toLowerCase()) add(n, normKey(fake));
  }

  private addToken(t: string): void {
    if (t.length < 3 || GENERIC.has(t) || this.tokens.has(t)) return;
    this.tokenCount += 1;
    this.tokens.set(t, `syn${pad(this.tokenCount, 3)}`);
    this.tokenRe = null;
  }

  /** Distinctive tokens, minus anything that also names an owned property (kept on purpose). */
  distinctiveTokens(): string[] {
    return [...this.tokens.keys()].filter((t) => !this.protectedTokens.has(t));
  }

  private compile(): void {
    if (!this.phraseRe) {
      const keys = [...this.phrases.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
      this.phraseRe = keys.length ? new RegExp(`(?<![A-Za-z0-9])(?:${keys.join('|')})(?![A-Za-z0-9])`, 'gi') : null;
    }
    if (!this.tokenRe) {
      const toks = this.distinctiveTokens().sort((a, b) => b.length - a.length).map(escapeRe);
      // Optional possessive form rides along ("Name's").
      this.tokenRe = toks.length ? new RegExp(`(?<![A-Za-z0-9])(?:${toks.join('|')})(?:'s)?(?![A-Za-z0-9])`, 'gi') : null;
    }
  }

  /** Replace every registered phrase and distinctive token inside a string. */
  apply(s: string): string {
    this.compile();
    let out = s;
    if (this.phraseRe) out = out.replace(this.phraseRe, (m) => this.phrases.get(m.toLowerCase()) ?? m);
    if (this.tokenRe) {
      out = out.replace(this.tokenRe, (m) => {
        const base = m.toLowerCase().replace(/'s$/, '');
        const fake = this.tokens.get(base);
        if (!fake) return m;
        if (m === m.toUpperCase()) return fake.toUpperCase();
        if (m[0] === m[0]!.toUpperCase()) return titleCase(fake);
        return fake;
      });
    }
    return out;
  }
}

// ── transform context ───────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<!\d)(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\d)/g;
/** County parcel-number shape (NNN-NNNNNN-NN). */
const PARCEL_RE = /(?<![0-9-])\d{3}-\d{6}-\d{2}(?![0-9-])/g;
const DOLLAR_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?[KkMm](?![A-Za-z]))?/g;
/** Keywords the code reads out of free-text fields (cost-seg "unverified", building-specs "ocr",
 *  property-financials sf note "inferred"/"confirm"). Kept when a free-text field is replaced. */
const KEEP_KEYWORDS = ['OCR', 'UNVERIFIED', 'inferred', 'confirm'];

class Ctx {
  readonly a = new Aliases();
  private emails = new Map<string, string>();
  private phones = new Map<string, string>();
  private freeCounters = new Map<string, number>();
  constructor(readonly scale: number) {}

  money(v: number): number {
    return round6(v * this.scale);
  }

  email(e: string): string {
    const k = e.toLowerCase();
    let f = this.emails.get(k);
    if (!f) {
      f = `contact-${pad(this.emails.size + 1, 2)}@example.com`;
      this.emails.set(k, f);
      this.a.realTerms.add(e);
    }
    return f;
  }

  private phone(p: string): string {
    let f = this.phones.get(p);
    if (!f) {
      f = `555-01${pad(this.phones.size + 1, 2)}`;
      this.phones.set(p, f);
    }
    return f;
  }

  private dollars(s: string): string {
    return s.replace(DOLLAR_RE, (_m, intPart: string, dec: string | undefined, suffix: string | undefined) => {
      const v = Number(intPart.replace(/,/g, '') + (dec ?? ''));
      const scaled = v * this.scale;
      const sfx = suffix ?? '';
      const decimals = dec ? Math.min(dec.length - 1, 2) : sfx ? 1 : 0;
      const body = intPart.includes(',')
        ? scaled.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        : scaled.toFixed(decimals);
      return `$${body}${sfx}`;
    });
  }

  /** Kept text: names/emails/phones replaced, dollar figures scaled. */
  t(s: string | null | undefined): string | null {
    if (s === null || s === undefined) return null;
    let out = s.replace(EMAIL_RE, (e) => this.email(e)).replace(PHONE_RE, (p) => this.phone(p));
    out = this.a.apply(out).replace(PARCEL_RE, (p) => this.a.alias('parcel', p)!);
    return this.dollars(out);
  }

  private stableMap = new Map<string, string>();

  /** Free text that groups rows (a scope, a repeated value): the same real text always maps to the
   *  same synthetic text, so grouping/equality between rows is preserved. */
  stable(label: string, s: string): string {
    const key = `${label}|${s}`;
    let f = this.stableMap.get(key);
    if (f === undefined) {
      f = s.trim() ? (this.free(label, s) ?? s) : s;
      this.stableMap.set(key, f);
    }
    return f;
  }

  /** Free text: replaced wholesale, keeping only the parsed keywords. */
  free(label: string, s: Json | undefined): string | null {
    if (s === null || s === undefined) return null;
    if (typeof s !== 'string') return null;
    if (!s.trim()) return s;
    const n = (this.freeCounters.get(label) ?? 0) + 1;
    this.freeCounters.set(label, n);
    const kws = KEEP_KEYWORDS.filter((k) => new RegExp(`\\b${k}`, 'i').test(s));
    return `Synthetic ${label} ${pad(n, 3)}.${kws.length ? ` [${kws.join(', ')}]` : ''}`;
  }
}

/**
 * Generic traversal for the parts of a file no explicit rule covers. Numbers under a currency key are
 * scaled; numbers under a known non-currency key are kept; any OTHER numeric key throws, so a new
 * field can never slip through unclassified. Strings go through ctx.t() (or ctx.free() for free-text
 * keys); non-identifier object keys go through ctx.t() too.
 */
function walk(
  ctx: Ctx,
  v: Json,
  key: string,
  money: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  freeKeys: ReadonlySet<string> = new Set(),
): Json {
  if (Array.isArray(v)) return v.map((x) => walk(ctx, x, key, money, keep, freeKeys));
  if (v && typeof v === 'object') {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const generic = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
      // Identifier keys go through t() too: a schema key never carries a registered name, but a
      // hand-written key can (e.g. a reviewer's first name in a JSON key).
      out[ctx.t(k) ?? k] = walk(ctx, x, generic ? `${key}.*` : k, money, keep, freeKeys);
    }
    return out;
  }
  if (typeof v === 'number') {
    if (money.has(key)) return ctx.money(v);
    if (keep.has(key)) return v;
    throw new Error(`unclassified numeric key "${key}" — add it to the money or keep set`);
  }
  if (typeof v === 'string') return freeKeys.has(key) ? ctx.free(key, v) : ctx.t(v);
  return v;
}

const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);
const str = (v: Json | undefined): string | null => (typeof v === 'string' ? v : null);

// ── snapshot (data/snapshots/portfolio.json) ────────────────────────────────────────────────────

const SNAP_MONEY = set(
  'estValue100', 'oxfordValue', 'grossIncome', 'expenses', 'noi', 'noiScenarioAdj', 'debtService', 'netCashFlow', 'loanBalance',
  'valuePerSf', 'rentPerSf', 'equityInvested', 'monthlyRent', 'annualRent', 'currentBalance', 'absBalance', 'monthlyPmt',
  'originalPrincipal', 'annualInterest', 'annualPrincipal', 'totalCash', 'priorBalance', 'deltaDollar', 'avg3', 'minAllTime',
  'maxAllTime', 'bal12moAgo', 'growth12Dollar', 'total', 'balances.*', 'premium', 'tiv', 'deductible', 'coverageLimit', 'estPrice',
  'price', 'pricePerSf', 'd30', 'd60', 'd90', 'd90plus', 'annualIncome', 'annualExpense', 'annualNoi', 'income', 'expense', 'amount',
  'value', 'rent',
);
const SNAP_KEEP = set(
  'revenueFactor', 'vacancyFactor', 'exitCapFactor', 'balloonAlertMonths', 'concentrationYellow', 'concentrationRed', 'index', 'sf',
  'tenantCount', 'occPct', 'oxfordOwnPct', 'capRate', 'cashOnCash', 'holdYrs', 'dscr', 'ltv', 'escalationPct', 'monthsToExpiry', 'rate',
  'monthsToMaturity', 'activeEntities', 'concentrationTopPct', 'deltaPct', 'growth12Pct', 'pctOfPortfolio', 'daysToExpiry', 'buildings',
  'equityMultiple', 'irr', 'cagr',
);

interface Ids {
  lease: Map<string, string>;
  deal: Map<string, string>;
  loan: Map<string, string>;
}

const newIds = (): Ids => ({ lease: new Map(), deal: new Map(), loan: new Map() });

/** Lease id = `${slug(propertyKey)}-${slug(unit)}-${slug(company ?? tenant)}` (server/workbook/parse.ts):
 *  swap the tenant suffix for the fake tenant's slug, keep the property/unit prefix. */
function leaseId(ctx: Ctx, ids: Ids, l: Obj): string {
  const real = String(l['id']);
  const existing = ids.lease.get(real);
  if (existing) return existing;
  const company = str(l['company']);
  const tenant = str(l['tenantName']);
  const tenantReal = company || tenant || '';
  const tenantFake = (company ? ctx.a.alias('company', company) : ctx.a.alias('person', tenant)) ?? '';
  const realSlug = slug(tenantReal);
  let fake: string;
  if (realSlug && real.includes(realSlug)) {
    const at = real.lastIndexOf(realSlug);
    fake = real.slice(0, at) + slug(tenantFake) + real.slice(at + realSlug.length);
  } else {
    fake = ctx.t(real) ?? real;
  }
  ids.lease.set(real, fake);
  ctx.a.map(real, fake);
  return fake;
}

/** Deal ids are either a slug of the deal name or a Notion page id. Both are recomputed. */
function dealId(ctx: Ctx, ids: Ids, real: string): string {
  let fake = ids.deal.get(real);
  if (!fake) {
    const n = ids.deal.size + 1;
    fake = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(real)
      ? `00000000-0000-4000-8000-${pad(n, 12)}`
      : `deal-${pad(n, 2)}`;
    ids.deal.set(real, fake);
    ctx.a.map(real, fake);
  }
  return fake;
}

/** Location of a pipeline deal: a fake street address in the deal's market city. */
function dealLocation(market: string | null, n: number): string {
  const m = /^(.*?)\s+([A-Z]{2})$/.exec(market ?? '');
  return m ? `${100 + n} Example Way, ${m[1]}, ${m[2]}` : `${100 + n} Example Way`;
}

const DEAL_KEPT_STRINGS = new Set(['stage', 'market', 'notionDealId', 'targetCloseDate']);

function transformDeal(ctx: Ctx, ids: Ids, d: Obj): Obj {
  const out: Obj = {};
  const id = dealId(ctx, ids, String(d['id']));
  const n = Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  for (const [k, v] of Object.entries(d)) {
    if (k === 'id') out[k] = id;
    else if (k === 'name') out[k] = ctx.a.alias('deal', str(v));
    else if (k === 'shortName') out[k] = ctx.a.alias('dealShort', str(v));
    else if (k === 'location') out[k] = typeof v === 'string' ? dealLocation(str(d['market']), n) : v;
    else if (k === 'lender') out[k] = ctx.a.alias('lender', str(v));
    else if (k === 'status') out[k] = ctx.free('deal status', v);
    else if (k === 'nextAction') out[k] = ctx.free('next action', v);
    else if (k === 'estPrice') out[k] = typeof v === 'number' ? ctx.money(v) : v;
    else if (typeof v === 'string' && !DEAL_KEPT_STRINGS.has(k)) out[k] = ctx.t(v);
    // sf, buildings, capRate, irr, equityMultiple, holdYrs, notionDealId, confidential, stage,
    // targetCloseDate, estimatedFields, market: kept (shape, ratios and opaque ids).
    else out[k] = v;
  }
  return out;
}

function transformCounterparty(ctx: Ctx, ids: Ids, c: Obj): Obj {
  const kind = String(c['kind']);
  const person = !['lender', 'carrier'].includes(kind);
  const cat: Category = kind === 'carrier' ? 'carrier' : kind === 'lender' ? 'lender' : 'contact';
  const name = ctx.a.alias(cat, str(c['name']))!;
  const firm = person ? (c['firm'] === c['name'] ? name : ctx.a.alias('firm', str(c['firm']))) : ctx.a.alias(cat, str(c['firm']));
  const realId = String(c['id']);
  const id = `cp-${slug(name)}`;
  ctx.a.map(realId, id);
  const links = (c['links'] ?? {}) as Obj;
  const mapList = (xs: Json | undefined, m: Map<string, string>): Json =>
    Array.isArray(xs) ? xs.map((x) => (typeof x === 'string' ? (m.get(x) ?? ctx.t(x)) : x)) : (xs ?? []);
  return {
    ...c,
    id,
    name,
    firm,
    role: c['role'] == null ? null : `Synthetic ${kind} role`,
    email: typeof c['email'] === 'string' ? ctx.email(c['email']) : (c['email'] ?? null),
    phone: typeof c['phone'] === 'string' ? '555-0100' : (c['phone'] ?? null),
    notes: ctx.free('counterparty note', c['notes']),
    links: {
      ...links,
      properties: mapList(links['properties'], new Map()),
      loans: mapList(links['loans'], ids.loan),
      deals: mapList(links['deals'], ids.deal),
      insurance: mapList(links['insurance'], new Map()),
    },
  };
}

function registerSnapshotNames(ctx: Ctx, s: Obj): void {
  const arr = (k: string): Obj[] => ((s[k] as Obj[] | undefined) ?? []);
  // Owned-property identities are protected (kept); see header.
  for (const p of arr('properties')) {
    ctx.a.protect(str(p['name']));
    ctx.a.protect(str(p['address']));
    ctx.a.protect(str(p['id']));
    ctx.a.protect(str(p['market']));
  }
  for (const l of arr('leases')) {
    ctx.a.protect(str(l['propertyKey']));
    ctx.a.protect(str(l['propertyId']));
  }
  for (const l of arr('loans')) {
    if (l['direction'] === 'borrower') ctx.a.protect(str(l['name']));
    ctx.a.protect(str(l['collateralProperty']));
  }
  // An insurance location can name its tenant in parentheses ("<address> (<tenant>/<carrier>)"):
  // only the address part is property identity.
  for (const i of arr('insurance')) ctx.a.protect(str(i['property'])?.replace(/\(.*$/, '') ?? null);
  // Market names (cities/regions) are not identifying and are joined on by market logic.
  for (const d of arr('deals')) ctx.a.protect(str(d['market']));
  // People first so person names inside entity strings ("<name> Family LLC") are replaced.
  for (const c of arr('counterparties')) {
    if (!['lender', 'carrier'].includes(String(c['kind']))) {
      ctx.a.alias('contact', str(c['name']));
      if (c['firm'] !== c['name']) ctx.a.alias('firm', str(c['firm']));
    }
  }
  for (const k of ['leases', 'arBalances']) {
    for (const l of arr(k)) {
      if (l['company']) ctx.a.alias('company', str(l['company']));
      if (l['tenantName']) ctx.a.alias('person', str(l['tenantName']));
    }
  }
  for (const l of arr('loans')) {
    if (l['lender']) ctx.a.alias('lender', str(l['lender']));
    if (l['direction'] === 'borrower') ctx.a.alias('lender', str(l['counterparty']));
    else {
      ctx.a.alias('note', str(l['name']));
      ctx.a.alias('firm', str(l['counterparty']));
    }
  }
  for (const i of arr('insurance')) {
    ctx.a.alias('carrier', str(i['carrier']));
    ctx.a.alias('policy', str(i['policyNo']));
  }
  for (const d of arr('deals')) {
    ctx.a.alias('deal', str(d['name']));
    if (d['lender']) ctx.a.alias('lender', str(d['lender']));
  }
}

/** A cash entity that names no owned property is a family/personal entity and is aliased. */
function isPropertyLike(ctx: Ctx, s: string): boolean {
  if (/^oxford$/i.test(s.trim())) return true;
  return wordTokens(s).some((t) => t.length >= 4 && t !== 'oxford' && ctx.a.protectedTokens.has(t));
}

function transformSnapshot(ctx: Ctx, ids: Ids, s: Obj): Obj {
  const arr = (k: string): Obj[] => ((s[k] as Obj[] | undefined) ?? []);
  const out: Obj = { ...s };
  out['properties'] = arr('properties').map((p) => {
    const q = walk(ctx, p, 'property', SNAP_MONEY, SNAP_KEEP) as Obj;
    for (const k of ['id', 'name', 'address', 'market', 'type', 'acqDate']) if (k in p) q[k] = p[k]!;
    if (typeof p['lender'] === 'string') q['lender'] = ctx.a.alias('lender', p['lender']);
    return q;
  });
  out['leases'] = arr('leases').map((l) => {
    const q = walk(ctx, l, 'lease', SNAP_MONEY, SNAP_KEEP) as Obj;
    q['id'] = leaseId(ctx, ids, l);
    q['tenantName'] = ctx.a.alias('person', str(l['tenantName']));
    q['company'] = l['company'] ? ctx.a.alias('company', str(l['company'])) : (l['company'] ?? null);
    q['propertyKey'] = l['propertyKey'] ?? null;
    q['propertyId'] = l['propertyId'] ?? null;
    return q;
  });
  // Loans: borrower loans are keyed by the owned property and keep their ids; lender/internal loans
  // name a private counterparty, so the name is aliased and the id recomputed from it.
  out['loans'] = arr('loans').map((l) => {
    const q = walk(ctx, l, 'loan', SNAP_MONEY, SNAP_KEEP) as Obj;
    const realId = String(l['id']);
    if (l['direction'] !== 'borrower') {
      const name = ctx.a.alias('note', str(l['name']))!;
      const id = `${String(l['direction'])}-${slug(name)}`;
      ids.loan.set(realId, id);
      ctx.a.map(realId, id);
      q['id'] = id;
      q['name'] = name;
      q['counterparty'] = ctx.a.alias('firm', str(l['counterparty']));
    } else {
      ids.loan.set(realId, realId);
      q['name'] = l['name'] ?? null;
      q['counterparty'] = ctx.a.alias('lender', str(l['counterparty']));
      q['collateralProperty'] = l['collateralProperty'] ?? null;
    }
    q['lender'] = typeof l['lender'] === 'string' ? ctx.a.alias('lender', l['lender']) : (l['lender'] ?? null);
    return q;
  });
  // Cash: personal/family entities are aliased (their ids, history keys and largestEntity follow).
  const cash = s['cash'] as Obj;
  const entityName = (e: string): string => (isPropertyLike(ctx, e) ? ctx.t(e)! : ctx.a.alias('firm', e)!);
  const entities = ((cash['entities'] as Obj[] | undefined) ?? []).map((e) => {
    const q = walk(ctx, e, 'cashEntity', SNAP_MONEY, SNAP_KEEP) as Obj;
    const realName = String(e['entity']);
    q['entity'] = entityName(realName);
    q['id'] = isPropertyLike(ctx, realName) ? String(e['id']) : slug(String(q['entity']));
    return q;
  });
  const history = ((cash['history'] as Obj[] | undefined) ?? []).map((h) => {
    const balances: Obj = {};
    for (const [k, v] of Object.entries((h['balances'] as Obj | undefined) ?? {})) balances[entityName(k)] = typeof v === 'number' ? ctx.money(v) : v;
    return { ...h, total: typeof h['total'] === 'number' ? ctx.money(h['total']) : (h['total'] ?? null), balances };
  });
  const cashOut = walk(ctx, { ...cash, entities: [], history: [] }, 'cash', SNAP_MONEY, SNAP_KEEP) as Obj;
  cashOut['entities'] = entities;
  cashOut['history'] = history;
  cashOut['largestEntity'] = typeof cash['largestEntity'] === 'string' ? entityName(cash['largestEntity']) : (cash['largestEntity'] ?? null);
  out['cash'] = cashOut;

  out['insurance'] = arr('insurance').map((i) => {
    const q = walk(ctx, i, 'insurance', SNAP_MONEY, SNAP_KEEP, set('notes', 'issue')) as Obj;
    q['carrier'] = ctx.a.alias('carrier', str(i['carrier']));
    q['policyNo'] = ctx.a.alias('policy', str(i['policyNo']));
    return q;
  });
  out['deals'] = arr('deals').map((d) => transformDeal(ctx, ids, d));
  out['tasks'] = arr('tasks').map((t) => {
    const q = walk(ctx, t, 'task', SNAP_MONEY, SNAP_KEEP) as Obj;
    q['label'] = t['type'] === 'M365 To-Do' ? ctx.free('task', t['label']) : ctx.t(str(t['label']));
    q['notes'] = ctx.free('task note', t['notes']);
    return q;
  });
  out['counterparties'] = arr('counterparties').map((c) => transformCounterparty(ctx, ids, c));
  const remapKeys = (o: Json | undefined, m: Map<string, string>, valueFn: (v: Json) => Json = (v) => v): Obj => {
    const r: Obj = {};
    for (const [k, v] of Object.entries((o as Obj | undefined) ?? {})) r[m.get(k) ?? ctx.t(k)!] = valueFn(v);
    return r;
  };
  out['renewalStages'] = remapKeys(s['renewalStages'], ids.lease);
  out['tenantNotes'] = remapKeys(s['tenantNotes'], ids.lease, (v) => (typeof v === 'string' ? ctx.free('tenant note', v) : v));
  out['tenantArrears'] = remapKeys(s['tenantArrears'], ids.lease, (v) => walk(ctx, v, 'arrears', SNAP_MONEY, SNAP_KEEP));
  out['arBalances'] = arr('arBalances').map((b) => {
    const q = walk(ctx, b, 'arBalance', SNAP_MONEY, SNAP_KEEP) as Obj;
    q['leaseId'] = ids.lease.get(String(b['leaseId'])) ?? ctx.t(String(b['leaseId']));
    q['tenantName'] = ctx.a.alias('person', str(b['tenantName']));
    q['company'] = b['company'] ? ctx.a.alias('company', str(b['company'])) : (b['company'] ?? null);
    q['propertyKey'] = b['propertyKey'] ?? null;
    q['propertyId'] = b['propertyId'] ?? null;
    return q;
  });
  // Deal comps: keyed by the pipeline deal; comp addresses and source links are replaced.
  let comp = 0;
  const dealComps: Obj = {};
  for (const [k, v] of Object.entries((s['dealComps'] as Obj | undefined) ?? {})) {
    const c = v as Obj;
    const fixComp = (x: Json): Json => {
      const o = walk(ctx, x, 'comp', SNAP_MONEY, SNAP_KEEP) as Obj;
      comp += 1;
      if ('address' in o) o['address'] = `Comp ${pad(comp, 3)}`;
      if (typeof o['source'] === 'string') o['source'] = `https://example.com/comp-source/${pad(comp, 3)}`;
      return o;
    };
    dealComps[ctx.t(k)!] = {
      ...(walk(ctx, { ...c, saleComps: [], rentComps: [], sources: [] }, 'dealComps', SNAP_MONEY, SNAP_KEEP) as Obj),
      saleComps: ((c['saleComps'] as Json[] | undefined) ?? []).map(fixComp),
      rentComps: ((c['rentComps'] as Json[] | undefined) ?? []).map(fixComp),
      sources: ((c['sources'] as Json[] | undefined) ?? []).map((_x, i) => `https://example.com/market-source/${pad(i + 1, 3)}`),
    };
  }
  out['dealComps'] = dealComps;
  const qb = s['quickbooks'] as Obj | null | undefined;
  if (qb !== undefined) out['quickbooks'] = qb ? { ...(walk(ctx, qb, 'quickbooks', SNAP_MONEY, SNAP_KEEP) as Obj), sourceFile: 'synthetic/ora-pl-by-property.csv' } : qb;
  out['dataQuality'] = arr('dataQuality').map((f) => ({ ...f, issue: ctx.free('data-quality issue', f['issue']) }));
  for (const k of ['meta', 'assumptions', 'acquisitionInputs', 'noiBudgets', 'marketRents', 'governors', 'workbookTotals']) {
    if (k in s) out[k] = walk(ctx, s[k]!, k, SNAP_MONEY, SNAP_KEEP);
  }
  return out;
}

// ── seed TS modules ─────────────────────────────────────────────────────────────────────────────

async function importArray(root: string, rel: string, exportName: string): Promise<Obj[]> {
  const mod = (await import(pathToFileURL(join(root, rel)).href)) as Record<string, unknown>;
  const v = mod[exportName];
  if (!Array.isArray(v)) throw new Error(`${rel} does not export an array ${exportName}`);
  return v as Obj[];
}

/** JSON -> TS module (single-quoted strings, bare keys where legal), typed against the contract. */
function tsModule(typeName: string, exportName: string, header: string, rows: Json): string {
  const body = JSON.stringify(rows, null, 2)
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:')
    .replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => `'${inner.replace(/\\"/g, '"').replace(/'/g, "\\'")}'`);
  const doc = header
    .split('\n')
    .map((l) => ` * ${l}`.trimEnd())
    .join('\n');
  return `import type { ${typeName} } from '@contracts/index';\n\n/**\n${doc}\n */\nexport const ${exportName}: ${typeName}[] = ${body};\n`;
}

const SYNTH_HEADER =
  'SYNTHETIC stand-in (fixtures/synthetic), generated by scripts/fixtures/build-synthetic-data.ts.\n' +
  'Contains no real firm data. The real file is local-only and gitignored (ruling 2026-11-10);\n' +
  'scripts/ensure-local-data.ts copies this into src/data/ only when the real file is absent.';

// ── property financials ─────────────────────────────────────────────────────────────────────────

const PF_KEEP = set(
  'pct', 'noi_margin', 'opex_ratio', 'mgmt_fee_pct', 'recovery_ratio', 'n_months', 'yoy_2025', 'yoy_2026', 'sf', 'leased_sf', 'occupancy',
  'n', 'nm', 'conc', 'occ', 'tenants', 'common_area_sf',
);

/** dataset.json: every numeric key not in PF_KEEP (or a *_pct/_ratio/_margin) is a USD amount. */
/** dataset.json: every numeric key not in PF_KEEP (or a *_pct/_ratio/_margin) is a USD amount, except
 *  inside a `yoy` block, whose line values are percents; its `delta` / `opex_by_delta` children are
 *  dollars again. */
function walkPf(ctx: Ctx, v: Json, key: string, inYoy = false): Json {
  if (Array.isArray(v)) return v.map((x) => walkPf(ctx, x, key, inYoy));
  if (v && typeof v === 'object') {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const generic = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
      const childYoy = k === 'yoy' ? true : k === 'delta' || k === 'opex_by_delta' ? false : inYoy;
      out[generic ? ctx.t(k)! : k] = walkPf(ctx, x, generic ? `${key}.*` : k, childYoy);
    }
    return out;
  }
  if (typeof v === 'number') {
    if (inYoy || PF_KEEP.has(key) || /(^|_)(pct|ratio|margin)$/.test(key)) return v;
    return ctx.money(v);
  }
  if (typeof v === 'string') return ctx.t(v);
  return v;
}

function transformDataset(ctx: Ctx, d: Obj): Obj {
  const out = walkPf(ctx, d, '') as Obj;
  // Insight narrative is analyst text about the firm's own properties and accounts: kept, with names
  // replaced and dollar figures scaled (percentages are scale-free, so quoted YoY figures still
  // reproduce from the data). The integer impact stays an integer.
  out['insights'] = ((d['insights'] as Obj[] | undefined) ?? []).map((i) => {
    const q = walkPf(ctx, i, 'insight') as Obj;
    if (typeof i['annual_impact_usd'] === 'number' && Number.isInteger(i['annual_impact_usd'])) q['annual_impact_usd'] = Math.round(i['annual_impact_usd'] * ctx.scale);
    return q;
  });
  out['leases'] = ((d['leases'] as Obj[] | undefined) ?? []).map((l) => {
    const q = walkPf(ctx, l, 'lease') as Obj;
    q['tenant'] = ctx.a.alias('company', str(l['tenant']));
    q['source'] = `Lease -- ${String(q['property'] ?? 'property')} ${String(q['tenant'])}.pdf`;
    return q;
  });
  // Rent-step events carry an absolute $ threshold (RENT_STEP_RULES.minDollars), so scaling the
  // series moves which steps qualify: recompute them from the scaled series with the module's own
  // detector, exactly as the dataset builder does.
  const history = (out['history'] as Obj | undefined) ?? {};
  for (const h of Object.values(history)) {
    const e = h as Obj;
    const months = e['months'] as Obj | undefined;
    if (months && Array.isArray(months['g']) && Array.isArray(months['br']) && Array.isArray(e['ev'])) {
      e['ev'] = rentStepEvents(months['g'] as string[], months['br'] as Array<number | null>) as unknown as Json;
    }
  }
  return out;
}

function transformAnnualCsv(ctx: Ctx, text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const header = lines[0]!;
  const cols = header.split(',');
  const amountIdx = cols.indexOf('amount_usd');
  const out = [header];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    // Fields are simple (no quoted commas) in this export; assert rather than guess.
    const f = line.split(',');
    if (f.length !== cols.length || amountIdx < 0) throw new Error('annual-statements.csv: unexpected field count');
    const scaled = ctx.money(Number(f[amountIdx]));
    f[amountIdx] = Number.isInteger(scaled) ? `${scaled}.0` : String(scaled);
    out.push(f.map((x, i) => (i === amountIdx ? x : (ctx.t(x) ?? x))).join(','));
  }
  return out.join('\n') + '\n';
}

const DATA_DICTIONARY = `# ORA Property Financials — Data Dictionary (synthetic stand-in)

SYNTHETIC stand-in generated by scripts/fixtures/build-synthetic-data.ts. The real dictionary is
local-only and gitignored (ruling 2026-11-10). Field definitions only.

## JSON top-level keys

| Key | Content |
|---|---|
| meta | title, version, generated, as_of, basis, units, periods (month lists), categories, excluded, noi_definition |
| portfolio.* | Same-store FY, TTM and YTD views: base_rent, reimbursements, revenue, opex, noi, capex, opex_by[category] |
| properties[id] | kind (monthly or annual); periods[period] with revenue, opex, noi, capex and ratios; yoy[comparison] |
| monthly[id][YYYY-MM] | base_rent, reimbursements, other_income, vacancy_waivers, revenue, opex, noi, capex, opex_by{category} |
| account_movers[id] | Account-level changes: category, account, prior, current, delta, pct |
| insights[] | id, severity, type, property, title, finding, action, annual_impact_usd, impact_basis, tags |
| leases[] | tenant, sf, term, rent schedule, escalator, source, confidence |
| data_quality[] | Known gaps and cautions |
| history[entity] | yr / ytd per year, monthly series, rent-step events, account-level drivers |
| sf[entity] | sf, leased_sf, occ, tenants, source, note |

## Definitions

- **Normalized NOI** = revenue (excluding security-deposit receipts and prepaid rent) minus recurring opex.
- **Recovery ratio** = (recoveries + utility reimbursements) / (tax + insurance + utilities + grounds + R&M).
- **Base rent run-rate (Q3)** = average of Jul–Sep base rent × 12.
- n_months below the period length means partial history: mark n/m, never annualize.
`;

// ── cost seg / building specs / calibration / AR / mapping seed ─────────────────────────────────

/** building-specs / cost-seg attributes whose value names a tenant, an official record or a person. */
const IDENTITY_ATTRS =
  /^(?!ownership$).*(tenant|occupant|owner|sdat|apn|parcel|tax_account|_account|transfer|rent_roll|accompanied|engaged_by|client|contact|official|inspector|interview|consultant|prepared_by|management_company|contractor|report_identifier|prior_report|report_provenance|foia|questionnaire|invoice|violation|cost|reserve|price|legal_description|use_restriction|^user$)/;
const PARCEL_ATTRS = /^(parcel_ids?|parcel|parcel_number|apn)$/;

/** The spec attributes the analytics read (src/analytics/building-specs.ts DIFF_ATTRS, by canonical
 *  name). Their text values are kept (names replaced); every other text value is report narrative
 *  (tenant rosters, inspectors, utility contacts, record searches) and is replaced. */
const ANALYTIC_ATTRS = new Set([
  'site|buildings', 'site|building_sf', 'site|year_built', 'site|stories', 'site|site_area', 'roof|install_year', 'roof|type',
  'roof|area_sf', 'roof|eul', 'roof|rul', 'roof|condition', 'paving|type', 'paving|install_year', 'hvac|ownership', 'hvac|type',
  'fire_life_safety|sprinklered',
]);

function walkWithUnit(ctx: Ctx, v: Json, key: string, money: ReadonlySet<string>, keep: ReadonlySet<string>, freeKeys: ReadonlySet<string>, stableKeys: ReadonlySet<string> = new Set()): Json {
  const recur = (x: Json, k: string): Json => walkWithUnit(ctx, x, k, money, keep, freeKeys, stableKeys);
  if (Array.isArray(v)) return v.map((x) => recur(x, key));
  if (v && typeof v === 'object') {
    const o = v as Obj;
    const out: Obj = {};
    const usd = typeof o['unit'] === 'string' && /usd|\$/i.test(o['unit']);
    const attr = typeof o['attribute'] === 'string' ? o['attribute'] : '';
    const component = typeof o['component'] === 'string' ? o['component'] : '';
    const analytic = ANALYTIC_ATTRS.has(`${component}|${canonicalAttribute(component, attr)}`);
    const textValue = (x: Json): Json => {
      if (typeof x !== 'string') return Array.isArray(x) ? x.map(textValue) : x;
      if (PARCEL_ATTRS.test(attr)) return ctx.a.alias('parcel', x);
      if (analytic && !IDENTITY_ATTRS.test(attr)) return ctx.t(x);
      return ctx.stable(attr || 'value', x);
    };
    for (const [k, x] of Object.entries(o)) {
      const generic = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
      if (k === 'value' && typeof x === 'number') out[k] = usd ? ctx.money(x) : x;
      else if (k === 'value' && attr && (typeof x === 'string' || Array.isArray(x))) out[k] = textValue(x);
      else if (stableKeys.has(k) && typeof x === 'string') out[k] = ctx.stable(k, x);
      else out[generic ? ctx.t(k)! : k] = recur(x, generic ? `${key}.*` : k);
    }
    return out;
  }
  if (typeof v === 'number') {
    if (money.has(key)) return ctx.money(v);
    if (keep.has(key)) return v;
    throw new Error(`unclassified numeric key "${key}"`);
  }
  if (typeof v === 'string') return freeKeys.has(key) ? ctx.free(key, v) : ctx.t(v);
  return v;
}

/** A vendor-less stand-in ("Unidentified roofer ...", "Unknown vendor") names nobody and is what the
 *  calibration placeholder guard keys on, so it is kept verbatim. */
const PLACEHOLDER_VENDOR = /^\s*(unidentified|unknown vendor\s*$)/i;

function registerVendors(ctx: Ctx, v: Json): void {
  if (Array.isArray(v)) return v.forEach((x) => registerVendors(ctx, x));
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'consultant' || k === 'vendor') && typeof x === 'string') {
        if (!PLACEHOLDER_VENDOR.test(x)) ctx.a.alias('vendor', x);
      } else registerVendors(ctx, x);
    }
  }
}

function aliasVendors(ctx: Ctx, v: Json): Json {
  if (Array.isArray(v)) return v.map((x) => aliasVendors(ctx, x));
  if (v && typeof v === 'object') {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const vendorField = (k === 'consultant' || k === 'vendor') && typeof x === 'string';
      out[k] = vendorField ? (PLACEHOLDER_VENDOR.test(x) ? x : ctx.a.alias('vendor', x)) : aliasVendors(ctx, x);
    }
    return out;
  }
  return v;
}

const COSTSEG_MONEY = set(
  'alloc.*', 'total', 'alloc_sum', 'fee', 'structure', 'hvac', 'plumbing', 'electrical', 'elevator', 'fire_alarm', 'personal_5yr',
  'land_improvements', 'public_space_5yr', 'fire', 'pp5', 'pp9', 'computed', 'expected', 'value.*',
);
const COSTSEG_KEEP = set('source_page', 'A', 'B', 'C');

function transformCostSeg(ctx: Ctx, d: Json): Json {
  // Cost-seg notes/issues are engineering text the analytics and tests read ("no quantities",
  // "rent roll is the record", "unverified", correction dates): kept with names replaced and dollar
  // figures scaled. Value strings that are not analytic attributes (tenant rosters etc.) are replaced.
  return walkWithUnit(ctx, aliasVendors(ctx, d), '', COSTSEG_MONEY, COSTSEG_KEEP, set('other_sources', 'description'), set('scope'));
}

const SPECS_MONEY = set('estimate_usd');
const SPECS_KEEP = set('pages_total', 'pages_without_text', 'pages_read', 'source_page', 'qty');

function transformSpecs(ctx: Ctx, d: Json): Json {
  return walkWithUnit(ctx, aliasVendors(ctx, d), '', SPECS_MONEY, SPECS_KEEP, set('notes', 'note', 'description'), set('scope'));
}

const CAL_MONEY = set('pca_unit_cost', 'contractor_unit_cost');
const CAL_KEEP = set('qty');

/** obs_id = `<property>:<component>:<vendor>:<date>`: the vendor segment becomes the fake vendor's slug. */
function registerObsIds(ctx: Ctx, rows: Json, obsIds: Map<string, string>): void {
  if (!Array.isArray(rows)) return;
  for (const r of rows as Obj[]) {
    const id = String(r['obs_id']);
    if (obsIds.has(id)) continue;
    const segs = id.split(':');
    const vendor = (r['contractor_source'] as Obj | null | undefined)?.['vendor'];
    // Only a segment that IS the vendor's slug (or its prefix, e.g. a dropped "-inc") is swapped;
    // hand-written segments ("quote-low") and placeholder vendors are kept.
    const vs = typeof vendor === 'string' && !PLACEHOLDER_VENDOR.test(vendor) ? slug(vendor) : '';
    if (segs.length >= 4 && vs && segs[2] && (vs === segs[2] || vs.startsWith(`${segs[2]}-`))) segs[2] = slug(ctx.a.alias('vendor', String(vendor))!);
    obsIds.set(id, segs.map((x, i) => (i === 2 ? x : (ctx.t(x) ?? x))).join(':'));
  }
}

function transformCalibration(ctx: Ctx, rows: Json, obsIds: Map<string, string>): Json {
  if (!Array.isArray(rows)) return rows;
  const fix = (id: string): string => obsIds.get(id) ?? id;
  return (rows as Obj[]).map((r) => {
    const q = walk(ctx, aliasVendors(ctx, r), '', CAL_MONEY, CAL_KEEP, set('scope_note')) as Obj;
    q['obs_id'] = fix(String(r['obs_id']));
    if (Array.isArray(r['supersedes'])) q['supersedes'] = (r['supersedes'] as Json[]).map((x) => (typeof x === 'string' ? fix(x) : x));
    return q;
  });
}

function transformArCache(ctx: Ctx, ids: Ids, c: Obj): Obj {
  const entries: Obj = {};
  for (const [k, v] of Object.entries((c['entries'] as Obj | undefined) ?? {})) {
    entries[normKey(ctx.a.alias('arName', k)!)] = v === 'SKIP' ? 'SKIP' : (ids.lease.get(String(v)) ?? ctx.t(String(v)));
  }
  return { ...c, entries };
}

function transformReviewQueue(ctx: Ctx, ids: Ids, rows: Json): Json {
  if (!Array.isArray(rows)) return rows;
  return (rows as Obj[]).map((r) => {
    const q = walk(ctx, r, 'review', SNAP_MONEY, SNAP_KEEP, set('reason')) as Obj;
    if (typeof r['proposedLeaseId'] === 'string') q['proposedLeaseId'] = ids.lease.get(r['proposedLeaseId']) ?? ctx.t(r['proposedLeaseId']);
    return q;
  });
}

// ── leak check ──────────────────────────────────────────────────────────────────────────────────

interface LeakHit {
  file: string;
  line: number;
  term: string;
}

/** Real terms to search for: every registered real phrase plus distinctive tokens (>= 4 chars). */
function leakTerms(ctx: Ctx, tokens = true): string[] {
  const out = new Set<string>();
  for (const t of ctx.a.realTerms) if (t.trim().length >= 4) out.add(t.trim());
  if (tokens) for (const t of ctx.a.distinctiveTokens()) if (t.length >= 4) out.add(t);
  return [...out];
}

function scanForLeaks(files: string[], terms: string[]): LeakHit[] {
  const hits: LeakHit[] = [];
  if (!terms.length) return hits;
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${[...terms].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi');
  for (const f of files) {
    const abs = resolve(ROOT, f);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        for (const m of l.matchAll(re)) hits.push({ file: relative(ROOT, abs).replace(/\\/g, '/'), line: i + 1, term: m[0] });
      });
  }
  return hits;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

const readJson = (root: string, rel: string): Json => JSON.parse(readFileSync(join(root, rel), 'utf8')) as Json;
const json = (v: Json): string => JSON.stringify(v, null, 2) + '\n';

async function build(root: string, write: boolean): Promise<{ ctx: Ctx; outputs: string[] }> {
  const manifest = loadManifest(ROOT);
  const ctx = new Ctx(write ? loadScale() : 0.5);
  const ids = newIds();
  const have = (rel: string): boolean => existsSync(join(root, rel));
  const outputs: Array<[string, () => string]> = [];
  const all = realFiles(root, manifest);
  if (all.length === 0) throw new Error('no real manifest files found locally — nothing to transform (run from a checkout that has them)');

  // Phase 1: register every name so ids and phrases are stable before any output is produced.
  const snapshot = have('data/snapshots/portfolio.json') ? (readJson(root, 'data/snapshots/portfolio.json') as Obj) : null;
  const seedDeals = have('src/data/seed-deals.ts') ? await importArray(root, 'src/data/seed-deals.ts', 'SEED_DEALS') : [];
  const seedPeople = have('src/data/seed-counterparties.ts') ? await importArray(root, 'src/data/seed-counterparties.ts', 'SEED_PEOPLE') : [];
  // The entity registry is tracked config (not real-data manifest), so it is read from the checkout.
  if (existsSync(join(ROOT, 'scripts/property-financials/config/entities.json'))) {
    for (const e of ((readJson(ROOT, 'scripts/property-financials/config/entities.json') as Obj)['entities'] as Obj[]) ?? []) {
      ctx.a.protect(str(e['id']));
      ctx.a.protect(str(e['label']));
      ctx.a.protect(str(e['canonicalId']));
    }
  }
  const specFiles = all.filter((f) => f.startsWith('data/building-specs/'));
  const calFiles = all.filter((f) => f.startsWith('data/calibration/'));
  const protectProps = (v: Json): void => {
    if (Array.isArray(v)) v.forEach(protectProps);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (/^(property|property_key|property_label)$/.test(k) && typeof x === 'string') ctx.a.protect(x);
        else protectProps(x);
      }
  };
  // Building-specs and calibration name their properties by key/label; cost-seg's free-form
  // `property` notes can carry a vendor name, so its property tokens come from the snapshot only.
  for (const f of [...specFiles, ...calFiles, 'data/cost-seg/cost-seg.json'].filter(have)) {
    const d = readJson(root, f);
    if (!f.startsWith('data/cost-seg/')) protectProps(d);
    registerVendors(ctx, d);
  }
  const dataset = have('data/property-financials/dataset.json') ? (readJson(root, 'data/property-financials/dataset.json') as Obj) : null;
  if (dataset) {
    for (const k of Object.keys((dataset['properties'] as Obj | undefined) ?? {})) ctx.a.protect(k);
    // Category vocabulary is schema (validated against contract enums), never a name.
    const cats = ((dataset['meta'] as Obj | undefined)?.['categories'] as Obj | undefined) ?? {};
    for (const list of Object.values(cats)) if (Array.isArray(list)) for (const c of list) ctx.a.protect(str(c));
  }
  // Every protection is in place before the first alias (see Aliases.namesOnlyProperty).
  if (snapshot) registerSnapshotNames(ctx, snapshot);
  for (const p of seedPeople) {
    ctx.a.alias('contact', str(p['name']));
    if (p['firm'] !== p['name']) ctx.a.alias('firm', str(p['firm']));
  }
  for (const d of seedDeals) {
    ctx.a.alias('deal', str(d['name']));
    if (typeof d['lender'] === 'string') ctx.a.alias('lender', d['lender']);
  }
  if (dataset) for (const l of (dataset['leases'] as Obj[] | undefined) ?? []) ctx.a.alias('company', str(l['tenant']));
  const arCache = have('data/ar-mapping-cache.json') ? (readJson(root, 'data/ar-mapping-cache.json') as Obj) : null;
  if (arCache) for (const k of Object.keys((arCache['entries'] as Obj | undefined) ?? {})) ctx.a.alias('arName', k);

  // Phase 2: transform. Deal and lease ids first (counterparty links, arrears, AR cache use them).
  for (const d of seedDeals) dealId(ctx, ids, String(d['id']));
  if (snapshot) {
    for (const d of (snapshot['deals'] as Obj[] | undefined) ?? []) dealId(ctx, ids, String(d['id']));
    for (const l of (snapshot['leases'] as Obj[] | undefined) ?? []) leaseId(ctx, ids, l);
    for (const l of (snapshot['loans'] as Obj[] | undefined) ?? []) {
      if (l['direction'] !== 'borrower') {
        const id = `${String(l['direction'])}-${slug(ctx.a.alias('note', str(l['name']))!)}`;
        ids.loan.set(String(l['id']), id);
        ctx.a.map(String(l['id']), id);
      }
    }
    const synthSnap = transformSnapshot(ctx, ids, snapshot);
    outputs.push(['data/snapshots/portfolio.json', () => json(synthSnap)]);
  }
  if (have('src/data/seed-deals.ts')) {
    const rows = seedDeals.map((d) => transformDeal(ctx, ids, d));
    outputs.push(['src/data/seed-deals.ts', () => tsModule('Deal', 'SEED_DEALS', SYNTH_HEADER, rows as Json)]);
  }
  if (have('src/data/seed-counterparties.ts')) {
    const rows = seedPeople.map((c) => transformCounterparty(ctx, ids, c));
    outputs.push(['src/data/seed-counterparties.ts', () => tsModule('Counterparty', 'SEED_PEOPLE', SYNTH_HEADER, rows as Json)]);
  }
  if (dataset) {
    const d = transformDataset(ctx, dataset);
    outputs.push(['data/property-financials/dataset.json', () => json(d)]);
    // The curated inputs are carried verbatim into dataset.json by the builder, so their synthetic
    // copies ARE the synthetic dataset's blocks (keeping the two consistent, as the builder would).
    for (const block of ['insights', 'leases', 'data_quality', 'sf']) {
      const rel = `scripts/property-financials/config/curated/${block}.json`;
      if (!have(rel)) continue;
      const realCurated = readJson(root, rel) as Obj;
      const note = typeof realCurated['$note'] === 'string' ? ctx.t(realCurated['$note']) : null;
      outputs.push([rel, () => json({ ...(note === null ? {} : { $note: note }), [block]: d[block] ?? null })]);
    }
  }
  if (have('data/property-financials/data-dictionary.md')) outputs.push(['data/property-financials/data-dictionary.md', () => DATA_DICTIONARY]);
  if (have('scripts/property-financials/config/annual-statements.csv')) {
    const csv = transformAnnualCsv(ctx, readFileSync(join(root, 'scripts/property-financials/config/annual-statements.csv'), 'utf8'));
    outputs.push(['scripts/property-financials/config/annual-statements.csv', () => csv]);
  }
  if (arCache) {
    const c = transformArCache(ctx, ids, arCache);
    outputs.push(['data/ar-mapping-cache.json', () => json(c)]);
  }
  if (have('data/ar/review-queue.json')) {
    const q = transformReviewQueue(ctx, ids, readJson(root, 'data/ar/review-queue.json'));
    outputs.push(['data/ar/review-queue.json', () => json(q)]);
  }
  if (have('data/cost-seg/cost-seg.json')) {
    const c = transformCostSeg(ctx, readJson(root, 'data/cost-seg/cost-seg.json'));
    outputs.push(['data/cost-seg/cost-seg.json', () => json(c)]);
  }
  for (const f of specFiles) {
    const s = transformSpecs(ctx, readJson(root, f));
    outputs.push([f, () => json(s)]);
  }
  const obsIds = new Map<string, string>();
  for (const f of calFiles) registerObsIds(ctx, readJson(root, f), obsIds);
  for (const f of calFiles) {
    const c = transformCalibration(ctx, readJson(root, f), obsIds);
    outputs.push([f, () => json(c)]);
  }
  const seedRel = 'docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json';
  if (have(seedRel)) {
    const m = walk(ctx, readJson(root, seedRel), '', set(), set('corrections_applied', 'open_rulings'));
    outputs.push([seedRel, () => json(m)]);
  }

  const covered = new Set(outputs.map(([rel]) => rel));
  const missing = all.filter((f) => !covered.has(f));
  if (missing.length) throw new Error(`no transformer for manifest file(s): ${missing.join(', ')}`);

  if (write) {
    for (const [rel, content] of outputs) {
      const abs = join(OUT_ROOT, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content());
      console.log(`[synthetic] wrote fixtures/synthetic/${rel}`);
    }
  }
  return { ctx, outputs: outputs.map(([rel]) => `fixtures/synthetic/${rel}`) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const phrasesOnly = argv.includes('--phrases-only');
  const sep = argv.indexOf('--');
  const extra = sep >= 0 ? argv.slice(sep + 1) : [];
  const srcAt = argv.indexOf('--src');
  // --src <dir>: read the real files from a directory laid out like the repo (e.g. a copy kept
  // outside the checkout) instead of from the checkout itself.
  const srcRoot = srcAt >= 0 && argv[srcAt + 1] ? resolve(argv[srcAt + 1]!) : ROOT;
  const { ctx, outputs } = await build(srcRoot, !checkOnly);
  const terms = leakTerms(ctx, !phrasesOnly);
  const fixtureFiles = checkOnly ? listFiles(OUT_ROOT).map((p) => relative(ROOT, p).replace(/\\/g, '/')) : outputs;
  // --tracked: scan every tracked text file of the checkout instead (real-data manifest paths are
  // untracked, so a hit here is real data in a tracked file).
  const tracked = argv.includes('--tracked')
    ? execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter((f) => f && !/\.(png|jpe?g|gif|ico|woff2?|ttf|otf|pdf|xlsx?|xlsm|sqlite|zip|gz)$/i.test(f))
    : [];
  const targets = extra.length ? extra : tracked.length ? tracked : fixtureFiles;
  const hits = scanForLeaks(targets, terms);
  console.log(`[synthetic] leak check (${phrasesOnly ? 'phrases' : 'phrases + tokens'}): ${terms.length} real terms x ${targets.length} file(s) -> ${hits.length} hit(s)`);
  if (hits.length) {
    // Report location and term length only — never echo the real term itself.
    for (const h of hits) console.error(`  LEAK ${h.file}:${h.line} (term length ${h.term.length})`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/fixtures/build-synthetic-data.ts')) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
