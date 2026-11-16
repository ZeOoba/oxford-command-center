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
//   - every currency amount (and every "$1,234" inside kept text) is a SEEDED RANDOM draw with no
//     functional link to the real amount (scripts/fixtures/synthetic-money.ts): a public seed plus the
//     value's structural key (its location in the synthetic output), inside a band chosen from the
//     field's meaning and, where the record has one, its square footage. Only the real amount's sign
//     and exact zero are read. The P&L series are drawn with structure (a per-entity, per-line level,
//     flat base rent stepped at the real event months, gentle annual drift, the real zero pattern),
//     not white noise. Derived figures (sums, NOI, per-SF, cap rate, DSCR, LTV, portfolio views, cash
//     totals, curated lever impacts) are recomputed from the drawn parts wherever the identity held in
//     the real file, and joins (loan balance vs loan row, arrears vs AR balances, cash entities vs
//     their history, task payment vs loan, ...) are re-established by copying the canonical record's
//     drawn value into its mirrors wherever the two were equal in the real file. SF, counts, dates
//     and rates (including a lease schedule's escalation rate, rounded to 0.1%) are unchanged.
//   - owned-property identities (property names, addresses, ids, property keys) are KEPT: they are
//     already hardcoded across tracked code (server/warehouse/property-master.ts, the property-
//     financials contract and entity registry, the workbook parser), so renaming them in the
//     fixtures would break those joins without making anything less public.
//
// No secret is involved (the HMAC perturbation and its local secret file were retired 2026-11-11):
// the seed is public, and the output is the same whatever the real amounts are, as long as the
// structure (records, keys, SF, signs, zeros and which identities held) is the same.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { slug } from '../../src/contracts/common';
import { canonicalAttribute } from '../../src/analytics/building-specs';
import { rentStepEvents } from '../../src/analytics/property-financials/metrics';
import { computeLevers } from '../../src/analytics/property-financials/levers';
import {
  DEFAULT_SF,
  SYNTH_SEED,
  UNIT_COST_BANDS,
  bandFor,
  hasBand,
  makeMoneyDrawer,
  roundTo,
  uniform,
  unit,
  type Band,
  type MoneyDrawer,
} from './synthetic-money';
import { GOLDEN_COST, GOLDEN_PF, computeCostGolden, computePfGolden } from '../golden/compute-golden';
import { LeaseTerm } from '../../src/contracts/lease-run';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = join(ROOT, 'fixtures', 'synthetic');

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

/** The firm's own affiliate labels are firm identity, not counterparty data, and code keys on them
 *  (src/analytics/debt-basis.ts AFFILIATE_LENDER_NAMES): an aliased lender / loan-party name keeps them. */
function firmSuffix(real: string): string {
  const parts: string[] = [];
  if (/\(Oxford Capital\)/i.test(real)) parts.push(' (Oxford Capital)');
  else if (/(^|[^a-z])Oxford Capital([^a-z]|$)/i.test(real)) parts.push(' / Oxford Capital');
  if (/Oxford 50% share/i.test(real)) parts.push(' — Oxford 50% share');
  return parts.join('');
}

/** Alias for a vendor short form that two real vendors share (it names neither). */
const AMBIGUOUS_VENDOR = 'Vendor (unspecified)';

class Aliases {
  private counters = new Map<Category, number>();
  private byReal = new Map<string, string>(); // `${cat}|${real}` -> fake
  /** Real string -> [category, fake], for --dump-terms (local scrub lists). */
  readonly registry = new Map<string, [string, string]>();
  /** lowercased variant -> replacement (exact, slug and normalized forms). */
  private phrases = new Map<string, string>();
  /** lowercased phrase -> the category of the alias that added it. */
  private phraseCat = new Map<string, string>();
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
        fake = (/^Oxford \/ /i.test(r) && !/Oxford Capital/i.test(r) ? 'Oxford / ' : '') + FORMAT[cat](n) + firmSuffix(r);
      }
      this.byReal.set(key, fake);
      if (!this.registry.has(r)) this.registry.set(r, [cat, fake]);
      // A name that is nothing but an owned property's words (a closing or refinance recorded as a
      // deal, an LLC named for its building) aliases its own field but is not hunted elsewhere:
      // the property identity it shares is kept everywhere on purpose.
      // Lender, affiliate, loan-party and person names are always hunted as whole phrases (their
      // words may also name a property, so their single tokens are not).
      const propertyWords = this.namesOnlyProperty(r);
      if (!propertyWords || !['deal', 'dealShort'].includes(cat)) this.addPhrase(r, fake, true, cat);
      if (!propertyWords && TOKEN_SOURCES.has(cat)) for (const t of wordTokens(r)) this.addToken(t);
    }
    return fake;
  }

  private namesOnlyProperty(r: string): boolean {
    const toks = wordTokens(r).filter((t) => t.length >= 2 && !GENERIC.has(t));
    return toks.length > 0 && toks.every((t) => this.protectedTokens.has(t));
  }

  /** Register a short form or co-mention of an already-aliased name (a vendor's first word, the name
   *  without its entity suffix): free text often names a counterparty that way (refute round 4 F6).
   *  A form already held by a different alias keeps that alias: whether two VENDORS share a form is
   *  decided up front by finalizeVendors (refute round 7 F3), and a vendor form never relabels a
   *  tenant, lender or other non-vendor alias. */
  variant(real: string, fake: string): void {
    const r = real.trim();
    if (r.length < 3 || r.toLowerCase() === fake.toLowerCase()) return;
    const prior = this.phrases.get(r.toLowerCase());
    if (prior !== undefined && prior !== fake) return;
    if (!this.registry.has(r)) this.registry.set(r, ['vendor', fake]);
    this.addPhrase(r, fake, false, 'vendor');
  }

  /** A form two or more distinct vendors share: free text naming it is attributed to neither (refute
   *  round 5 F2). Never overwrites a phrase that a non-vendor alias holds. */
  ambiguousVendorForm(real: string): void {
    const r = real.trim();
    const k = r.toLowerCase();
    if (r.length < 3) return;
    const cat = this.phraseCat.get(k);
    if (cat !== undefined && cat !== 'vendor') return;
    this.phrases.set(k, AMBIGUOUS_VENDOR);
    this.phraseCat.set(k, 'vendor');
    this.registry.set(r, ['vendor', AMBIGUOUS_VENDOR]);
    this.realTerms.add(r);
    this.phraseRe = null;
  }

  /** Register an explicit real -> fake mapping (ids recomputed by the caller). */
  map(real: string, fake: string): void {
    if (real === fake) return;
    if (!this.registry.has(real)) this.registry.set(real, ['id', fake]);
    this.addPhrase(real, fake, false);
  }

  private addPhrase(real: string, fake: string, variants = true, cat = 'id'): void {
    const add = (k: string, v: string): void => {
      if (k.length < 4 || !/[a-z]/i.test(k) || this.phrases.has(k)) return;
      this.phrases.set(k, v);
      this.phraseCat.set(k, cat);
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
/** A dollar figure with an optional bare upper bound ("$X-Y/SF", "$X - Y", "$X to Y"): the bare bound
 *  is the same kind of real amount and is drawn with it (refute round 7 F2). */
const DOLLAR_RANGE_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?[KkMm](?![A-Za-z]))?(?:(\s?[-–—]\s?|\s+to\s+)\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?[KkMm](?![A-Za-z]))?(?![\d.,]*\d))?/g;
/** Keywords the code reads out of free-text fields (cost-seg "unverified", building-specs "ocr",
 *  property-financials sf note "inferred"/"confirm"). Kept when a free-text field is replaced. */
const KEEP_KEYWORDS = ['OCR', 'UNVERIFIED', 'inferred', 'confirm'];

class Ctx {
  readonly a = new Aliases();
  private emails = new Map<string, string>();
  private phones = new Map<string, string>();
  private freeCounters = new Map<string, number>();
  private readonly m: MoneyDrawer;
  private textDollars = 0;
  constructor() {
    this.m = makeMoneyDrawer();
  }

  /**
   * The synthetic stand-in for one real amount `v` at structural location `key`: a seeded draw inside
   * the band for `field` (scaled by `sf` when the band is per-SF). Only v's sign and exact zero are
   * read; non-finite values and zeros (including -0) pass through.
   */
  money(v: number, key: string, field: string, sf?: number | null): number {
    return this.moneyIn(v, key, bandFor(field), sf);
  }

  moneyIn(v: number, key: string, band: Band, sf?: number | null): number {
    if (!Number.isFinite(v) || v === 0) return v;
    const scale = band.perSf ? (sf && sf > 0 ? sf : DEFAULT_SF) : 1;
    return this.m.draw(key, Math.sign(v), band.lo * scale, band.hi * scale, band.decimals ?? 2);
  }

  /** A model value: a draw within +/- `jitter` (relative) of `center`, with the given sign. */
  around(key: string, sign: number, center: number, jitter: number, decimals = 2): number {
    if (sign === 0) return 0;
    const c = Math.max(Math.abs(center), 0.01);
    return this.m.draw(key, sign, c * (1 - jitter), c * (1 + jitter), decimals);
  }

  email(e: string): string {
    const k = e.toLowerCase();
    let f = this.emails.get(k);
    if (!f) {
      f = `contact-${pad(this.emails.size + 1, 2)}@example.com`;
      this.emails.set(k, f);
      this.a.realTerms.add(e);
      if (!this.a.registry.has(e)) this.a.registry.set(e, ['email', f]);
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
    // A dollar figure inside kept text: a generic draw keyed by its running position (text order is
    // structure), formatted as plain dollars. A K/M suffix is dropped: it would carry the real
    // amount's order of magnitude.
    let drewDollars = false;
    const draw = (intPart: string, dec: string | undefined, suffix: string | undefined): [number, number] => {
      const v = Number(intPart.replace(/,/g, '') + (dec ?? ''));
      this.textDollars += 1;
      const decimals = dec && !suffix ? Math.min(dec.length - 1, 2) : 0;
      return [this.moneyIn(v === 0 ? 0 : 1, `text$|${this.textDollars}`, { lo: 500, hi: 250_000, decimals }), decimals];
    };
    const fmt = ([v, decimals]: [number, number]): string => v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const out = s.replace(
      DOLLAR_RANGE_RE,
      (_m, intPart: string, dec: string | undefined, suffix: string | undefined, sep: string | undefined, hiInt: string | undefined, hiDec: string | undefined, hiSuffix: string | undefined) => {
        drewDollars = true;
        const lo = draw(intPart, dec, suffix);
        if (sep === undefined || hiInt === undefined) return `$${fmt(lo)}`;
        const hi = draw(hiInt, hiDec, hiSuffix);
        // Both bounds are their own draws; the smaller is written first so the range still reads as one.
        const [a, b] = lo[0] <= hi[0] ? [lo, hi] : [hi, lo];
        return `$${fmt(a)}${sep}${fmt(b)}`;
      },
    );
    // A percentage in the same text as a drawn dollar figure is usually a ratio of those real amounts
    // (a study-vs-proposal delta): it is drawn too, keyed the same way (refute round 5 F1). Only its
    // sign survives. Percentages in text with no dollar figure are rates and are kept.
    if (!drewDollars) return out;
    return out.replace(/([+-]?)(\d+(?:\.\d+)?)%/g, (_m, sign: string, num: string) => {
      this.textDollars += 1;
      const decimals = num.includes('.') ? Math.min(num.split('.')[1]!.length, 2) : 0;
      const drawn = this.moneyIn(1, `text%|${this.textDollars}`, { lo: 0.5, hi: 60, decimals });
      return `${sign}${drawn.toFixed(decimals)}%`;
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
/** The band name for a money key: a generic map key ("balances.*") uses its own last path segment
 *  when that names a band (a cost-seg class "5yr"), else its singular container name. */
function bandField(key: string, path: string): string {
  if (!key.endsWith('.*')) return key;
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (hasBand(last)) return last;
  const base = key.slice(0, -2);
  return base === 'balances' ? 'balance' : base === 'value' ? 'usd_value' : base;
}

function walk(
  ctx: Ctx,
  v: Json,
  key: string,
  money: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  freeKeys: ReadonlySet<string> = new Set(),
  path = '',
  sf: number | null = null,
): Json {
  if (Array.isArray(v)) return v.map((x, i) => walk(ctx, x, key, money, keep, freeKeys, `${path}[${i}]`, sf));
  if (v && typeof v === 'object') {
    const own = num((v as Obj)['sf']);
    const sfHere = own !== null && own > 0 ? own : sf;
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const generic = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
      // Identifier keys go through t() too: a schema key never carries a registered name, but a
      // hand-written key can (e.g. a reviewer's first name in a JSON key).
      const ok = ctx.t(k) ?? k;
      out[ok] = walk(ctx, x, generic ? `${key}.*` : k, money, keep, freeKeys, `${path}/${ok}`, sfHere);
    }
    return out;
  }
  if (typeof v === 'number') {
    if (money.has(key)) return ctx.money(v, path, bandField(key, path), sf);
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
  /** dealComps: real key -> synthetic key, recorded while transforming (identity pairing). */
  comp: Map<string, string>;
}

const newIds = (): Ids => ({ lease: new Map(), deal: new Map(), loan: new Map(), comp: new Map() });

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

/** A lease id referenced without its lease record (an orphan key in arrears, AR or the mapping
 *  cache). Its tenant slug cannot be located without the record, so the whole id is replaced. */
function refLeaseId(ctx: Ctx, ids: Ids, real: string): string {
  const existing = ids.lease.get(real);
  if (existing) return existing;
  const fake = `orphan-lease-${pad(ids.lease.size + 1, 3)}`;
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
    // keyed by the synthetic deal id: the same deal in the seed list and the snapshot draws the same price
    else if (k === 'estPrice') out[k] = typeof v === 'number' ? ctx.money(v, `deal/${id}/estPrice`, 'estPrice', num(d['sf'])) : v;
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

/**
 * Re-derive, from the perturbed parts, every snapshot identity that held in the real record (checked
 * per record): property NOI / net cash flow / cap rate / DSCR / LTV / per-SF / cash-on-cash, lease
 * annual rent and rent per SF, cash deltas, totals and shares, history totals, AR totals, QuickBooks
 * NOI and expense, comp price per SF, and the workbook totals the reconcile check ties to.
 */
function fixSnapshotIdentities(real: Obj, syn: Obj, ids: Ids): void {
  /** Set syn[f] = calc(syn) when real[f] == calc(real) (relative 1e-6 or abs tol). Ratio fields keep
   *  full precision; amounts are rounded to the real field's native precision. */
  const derive = (r: Obj, o: Obj, f: string, calc: (x: Obj) => number | null, ratio = false, tol = 0): void => {
    const rv = num(r[f]);
    const rc = calc(r);
    if (rv === null || rc === null || !Number.isFinite(rc)) return;
    if (Math.abs(rv - rc) > Math.max(tol, 1e-6 * Math.max(1, Math.abs(rv)))) return;
    const sc = calc(o);
    if (sc === null || !Number.isFinite(sc)) return;
    o[f] = ratio ? sc : roundTo(sc, 2);
  };
  const n = (x: Obj, k: string): number | null => num(x[k]);
  const div = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : a / b);
  const pairs = (k: string): Array<[Obj, Obj]> =>
    (((real[k] as Obj[] | undefined) ?? []).map((r, i) => [r, ((syn[k] as Obj[] | undefined) ?? [])[i]!] as [Obj, Obj])).filter(([, o]) => !!o);

  // Leases first: a property's gross income is the sum of its leases' annual rent.
  for (const [r, o] of pairs('leases')) {
    derive(r, o, 'annualRent', (x) => (n(x, 'monthlyRent') ?? NaN) * 12);
    derive(r, o, 'rentPerSf', (x) => div(n(x, 'annualRent'), n(x, 'sf')), true);
  }
  for (const [r, o] of pairs('loans')) derive(r, o, 'absBalance', (x) => Math.abs(n(x, 'currentBalance') ?? NaN));
  // Joins: property <- its leases (gross income) and its borrower loans (balance, debt service),
  // wherever the real property figure was exactly that sum.
  const leasePairs = pairs('leases');
  const loanPairs = pairs('loans').filter(([r]) => r['direction'] === 'borrower');
  for (const [r, o] of pairs('properties')) {
    const ls = leasePairs.filter(([l]) => l['propertyId'] === r['id']);
    const sumL = (side: 0 | 1, f: string): number => ls.reduce((a, p) => a + (n(p[side], f) ?? 0), 0);
    if (ls.length && held(n(r, 'grossIncome'), sumL(0, 'annualRent'), 1)) o['grossIncome'] = roundTo(sumL(1, 'annualRent'), 2);
    const lo = loanPairs.filter(([l]) => l['collateralProperty'] === r['name'] || l['collateralProperty'] === r['id']);
    const sumLo = (side: 0 | 1, f: string, k = 1): number => lo.reduce((a, p) => a + (n(p[side], f) ?? 0) * k, 0);
    if (lo.length && held(n(r, 'loanBalance'), sumLo(0, 'currentBalance'), 1)) o['loanBalance'] = roundTo(sumLo(1, 'currentBalance'), 2);
    if (lo.length && held(n(r, 'debtService'), sumLo(0, 'monthlyPmt', 12), 1)) o['debtService'] = roundTo(sumLo(1, 'monthlyPmt', 12), 2);
  }
  // A task that carries a loan's payment mirrors that loan's drawn payment. The task is joined to its
  // loan by NAME (the loan's name in the task label or notes), never by payment amount (refute round 3
  // F3: two loans with one payment made a first-match join order-dependent). The mirror applies only
  // when exactly one loan matches by name and the real task payment equals that loan's real payment;
  // otherwise it is skipped and logged.
  const allLoans = pairs('loans');
  const normName = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  pairs('tasks').forEach(([r, o], i) => {
    const rp = n(r, 'monthlyPmt');
    if (rp === null || rp === 0) return;
    const text = ` ${normName(r['label'])} ${normName(r['notes'])} `;
    const named = allLoans.filter(([l]) => normName(l['name']) !== '' && text.includes(` ${normName(l['name'])} `));
    if (named.length !== 1) {
      console.log(`[synthetic] task #${i + 1}: ${named.length} loans match by name; payment mirror skipped`);
      return;
    }
    const [[rl, sl]] = named as [[Obj, Obj]];
    if (n(rl, 'monthlyPmt') === rp && n(sl, 'monthlyPmt') !== null) o['monthlyPmt'] = n(sl, 'monthlyPmt');
  });
  // tenantArrears[leaseId] mirrors that lease's AR balance buckets.
  const rTa = (real['tenantArrears'] as Obj | undefined) ?? {};
  const sTa = (syn['tenantArrears'] as Obj | undefined) ?? {};
  const arPairs = pairs('arBalances');
  for (const [lid, rv] of Object.entries(rTa)) {
    const so = sTa[ids.lease.get(lid) ?? ''] as Obj | undefined;
    const hit = arPairs.find(([b]) => b['leaseId'] === lid);
    if (!so || !hit || !rv || typeof rv !== 'object') continue;
    for (const k of ['d30', 'd60', 'd90', 'd90plus']) {
      if (num((rv as Obj)[k]) !== null && num((rv as Obj)[k]) === n(hit[0], k)) so[k] = hit[1][k] ?? null;
    }
  }

  for (const [r, o] of pairs('properties')) {
    derive(r, o, 'oxfordValue', (x) => (n(x, 'estValue100') ?? NaN) * (n(x, 'oxfordOwnPct') ?? NaN));
    derive(r, o, 'noi', (x) => (n(x, 'grossIncome') ?? NaN) - (n(x, 'expenses') ?? NaN));
    derive(r, o, 'noiScenarioAdj', (x) => n(x, 'noi'));
    derive(r, o, 'netCashFlow', (x) => (n(x, 'noi') ?? NaN) - (n(x, 'debtService') ?? NaN));
    derive(r, o, 'capRate', (x) => div(n(x, 'noi'), n(x, 'estValue100')), true);
    derive(r, o, 'dscr', (x) => div(n(x, 'noi'), n(x, 'debtService')), true);
    derive(r, o, 'ltv', (x) => div(n(x, 'loanBalance'), n(x, 'estValue100')), true);
    derive(r, o, 'ltv', (x) => div(n(x, 'loanBalance'), n(x, 'oxfordValue')), true);
    derive(r, o, 'valuePerSf', (x) => div(n(x, 'estValue100'), n(x, 'sf')), true);
    derive(r, o, 'rentPerSf', (x) => div(n(x, 'grossIncome'), n(x, 'sf')), true);
    derive(r, o, 'cashOnCash', (x) => div(n(x, 'netCashFlow'), n(x, 'equityInvested')), true);
  }

  const rc = real['cash'] as Obj | undefined;
  const sc = syn['cash'] as Obj | undefined;
  if (rc && sc) {
    const rE = (rc['entities'] as Obj[] | undefined) ?? [];
    const sE = (sc['entities'] as Obj[] | undefined) ?? [];
    const rHist = (rc['history'] as Obj[] | undefined) ?? [];
    const sHist = (sc['history'] as Obj[] | undefined) ?? [];
    rE.forEach((r, i) => {
      const o = sE[i];
      if (!o) return;
      // An entity's balances mirror its own drawn history series: current / prior / 12-months-ago /
      // extremes copy the history point they equalled in the real file; avg3 and the all-time
      // extremes are re-derived from the series where that held.
      const rs = rHist.map((h) => num(((h['balances'] as Obj | undefined) ?? {})[String(r['entity'])]));
      const ss = sHist.map((h) => num(((h['balances'] as Obj | undefined) ?? {})[String(o['entity'])]));
      for (const f of ['currentBalance', 'priorBalance', 'bal12moAgo', 'maxAllTime', 'minAllTime']) {
        const rv = n(r, f);
        if (rv === null) continue;
        for (let j = rs.length - 1; j >= 0; j--) {
          if (rs[j] !== null && held(rs[j]!, rv, 0.006) && ss[j] !== null) {
            o[f] = ss[j]!;
            break;
          }
        }
      }
      const present = (xs: Array<number | null>): number[] => xs.filter((x): x is number => x !== null);
      const last3 = (xs: Array<number | null>): number => present(xs).slice(-3).reduce((a, x) => a + x, 0) / Math.max(1, present(xs).slice(-3).length);
      if (present(rs).length && present(ss).length) {
        if (held(n(r, 'avg3'), last3(rs), 0.01)) o['avg3'] = roundTo(last3(ss), 2);
        if (held(n(r, 'maxAllTime'), Math.max(...present(rs)), 0.006)) o['maxAllTime'] = Math.max(...present(ss));
        if (held(n(r, 'minAllTime'), Math.min(...present(rs)), 0.006)) o['minAllTime'] = Math.min(...present(ss));
      }
      derive(r, o, 'deltaDollar', (x) => (n(x, 'currentBalance') ?? NaN) - (n(x, 'priorBalance') ?? NaN), false, 0.006);
      derive(r, o, 'deltaPct', (x) => div(n(x, 'deltaDollar'), n(x, 'priorBalance')), true);
      derive(r, o, 'growth12Dollar', (x) => (n(x, 'currentBalance') ?? NaN) - (n(x, 'bal12moAgo') ?? NaN), false, 0.006);
      derive(r, o, 'growth12Pct', (x) => div(n(x, 'growth12Dollar'), n(x, 'bal12moAgo')), true);
      // all-time extremes must still bracket the current balance
      const cur = n(o, 'currentBalance');
      if (cur !== null && n(r, 'maxAllTime') !== null && n(r, 'maxAllTime')! >= n(r, 'currentBalance')!) o['maxAllTime'] = Math.max(n(o, 'maxAllTime')!, cur);
      if (cur !== null && n(r, 'minAllTime') !== null && n(r, 'minAllTime')! <= n(r, 'currentBalance')!) o['minAllTime'] = Math.min(n(o, 'minAllTime')!, cur);
    });
    const sumCur = (es: Obj[]): number => es.reduce((a, e) => a + (n(e, 'currentBalance') ?? 0), 0);
    derive(rc, sc, 'totalCash', () => null);
    if (held(n(rc, 'totalCash'), sumCur(rE), 2)) sc['totalCash'] = roundTo(sumCur(sE), 3);
    const total = n(sc, 'totalCash');
    rE.forEach((r, i) => {
      const o = sE[i];
      if (o && total) derive({ ...r, __t: n(rc, 'totalCash') }, o, 'pctOfPortfolio', (x) => div(n(x, 'currentBalance'), x === o ? total : n(x, '__t')), true);
    });
    if (sE.length && total) {
      const top = sE.reduce((a, e) => ((n(e, 'currentBalance') ?? 0) > (n(a, 'currentBalance') ?? 0) ? e : a), sE[0]!);
      if (held(n(rc, 'concentrationTopPct'), Math.max(...rE.map((e) => (n(e, 'currentBalance') ?? 0) / (n(rc, 'totalCash') ?? 1))), 1e-9)) {
        sc['concentrationTopPct'] = (n(top, 'currentBalance') ?? 0) / total;
        sc['largestEntity'] = top['entity'] ?? null;
      }
    }
    const rH = (rc['history'] as Obj[] | undefined) ?? [];
    const sH = (sc['history'] as Obj[] | undefined) ?? [];
    const sumBal = (h: Obj): number => Object.values((h['balances'] as Obj | undefined) ?? {}).reduce<number>((a, v) => a + (num(v) ?? 0), 0);
    rH.forEach((r, i) => {
      const o = sH[i];
      if (o && held(n(r, 'total'), sumBal(r), 0.01)) o['total'] = roundTo(sumBal(o), 3);
    });
  }
  for (const [r, o] of pairs('arBalances')) derive(r, o, 'total', (x) => ['d30', 'd60', 'd90', 'd90plus'].reduce((a, k) => a + (n(x, k) ?? NaN), 0), false, 0.006);
  const rq = real['quickbooks'] as Obj | null | undefined;
  const sq = syn['quickbooks'] as Obj | null | undefined;
  if (rq && sq) {
    ((rq['properties'] as Obj[] | undefined) ?? []).forEach((r, i) => {
      const o = ((sq['properties'] as Obj[] | undefined) ?? [])[i];
      if (!o) return;
      const gl = (x: Obj): number => ((x['glExpense'] as Obj[] | undefined) ?? []).reduce((a, g) => a + (n(g, 'amount') ?? 0), 0);
      derive(r, o, 'annualExpense', gl, false, 0.006);
      // the monthly rows mirror the annual figures they equalled, then keep noi = income - expense
      const rm = (r['monthly'] as Obj[] | undefined) ?? [];
      const sm = (o['monthly'] as Obj[] | undefined) ?? [];
      const sumM = (xs: Obj[], f: string): number => xs.reduce((a, x) => a + (n(x, f) ?? 0), 0);
      rm.forEach((rr, j) => {
        const oo = sm[j];
        if (!oo) return;
        if (held(n(rr, 'expense'), n(r, 'annualExpense'), 0.006)) oo['expense'] = o['annualExpense'] ?? null;
      });
      derive(r, o, 'annualIncome', (x) => sumM((x['monthly'] as Obj[] | undefined) ?? [], 'income'), false, 0.006);
      rm.forEach((rr, j) => {
        const oo = sm[j];
        if (oo) derive(rr, oo, 'noi', (x) => (n(x, 'income') ?? NaN) - (n(x, 'expense') ?? NaN), false, 0.02);
      });
      derive(r, o, 'annualNoi', (x) => (n(x, 'annualIncome') ?? NaN) - (n(x, 'annualExpense') ?? NaN), false, 0.006);
    });
  }
  // dealComps are paired by identity (real key -> synthetic key, recorded while transforming).
  const rdc = (real['dealComps'] as Obj | undefined) ?? {};
  const sdc = (syn['dealComps'] as Obj | undefined) ?? {};
  Object.keys(rdc).forEach((rk) => {
    const r = rdc[rk] as Obj | undefined;
    const sk = ids.comp.get(rk);
    const o = sk === undefined ? undefined : (sdc[sk] as Obj | undefined);
    if (!r || !o) return;
    for (const kind of ['saleComps', 'rentComps']) {
      ((r[kind] as Obj[] | undefined) ?? []).forEach((rr, j) => {
        const oo = ((o[kind] as Obj[] | undefined) ?? [])[j];
        if (oo) derive(rr, oo, 'pricePerSf', (x) => div(n(x, 'price'), n(x, 'sf')), false, 0.01);
      });
    }
  });
  const rw = real['workbookTotals'] as Obj | null | undefined;
  const sw = syn['workbookTotals'] as Obj | null | undefined;
  if (rw && sw) {
    const sum = (x: Obj, arr: string, f: string): number => ((x[arr] as Obj[] | undefined) ?? []).reduce((a, e) => a + (n(e, f) ?? 0), 0);
    if (held(n(rw, 'noi'), sum(real, 'properties', 'noi'), 1)) sw['noi'] = roundTo(sum(syn, 'properties', 'noi'), 2);
    if (held(n(rw, 'value'), sum(real, 'properties', 'oxfordValue'), 1)) sw['value'] = sum(syn, 'properties', 'oxfordValue');
    if (held(n(rw, 'rent'), sum(real, 'leases', 'annualRent'), 1)) sw['rent'] = roundTo(sum(syn, 'leases', 'annualRent'), 2);
  }
}

function transformSnapshot(ctx: Ctx, ids: Ids, s: Obj): Obj {
  const arr = (k: string): Obj[] => ((s[k] as Obj[] | undefined) ?? []);
  const out: Obj = { ...s };
  /** Snapshot walk: every amount keyed by its location in the synthetic output. */
  const W = (v: Json, key: string, path: string, free: ReadonlySet<string> = new Set()): Json => walk(ctx, v, key, SNAP_MONEY, SNAP_KEEP, free, path);
  out['properties'] = arr('properties').map((p, i) => {
    const q = W(p, 'property', `snap/properties[${i}]`) as Obj;
    for (const k of ['id', 'name', 'address', 'market', 'type', 'acqDate']) if (k in p) q[k] = p[k]!;
    if (typeof p['lender'] === 'string') q['lender'] = ctx.a.alias('lender', p['lender']);
    return q;
  });
  out['leases'] = arr('leases').map((l, i) => {
    const q = W(l, 'lease', `snap/leases[${i}]`) as Obj;
    q['id'] = leaseId(ctx, ids, l);
    q['tenantName'] = ctx.a.alias('person', str(l['tenantName']));
    q['company'] = l['company'] ? ctx.a.alias('company', str(l['company'])) : (l['company'] ?? null);
    q['propertyKey'] = l['propertyKey'] ?? null;
    q['propertyId'] = l['propertyId'] ?? null;
    return q;
  });
  // Loans: borrower loans are keyed by the owned property and keep their ids; lender/internal loans
  // name a private counterparty, so the name is aliased and the id recomputed from it.
  out['loans'] = arr('loans').map((l, i) => {
    const q = W(l, 'loan', `snap/loans[${i}]`) as Obj;
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
    const realName = String(e['entity']);
    const name = entityName(realName);
    const q = W(e, 'cashEntity', `snap/cash/entities/${name}`) as Obj;
    q['entity'] = name;
    q['id'] = isPropertyLike(ctx, realName) ? String(e['id']) : slug(String(q['entity']));
    return q;
  });
  // Each entity's balance history is a drawn random walk around a drawn level (keyed by the
  // synthetic entity name and the row), so its months move like a bank balance, not white noise.
  const walkLevel = (name: string, row: number): number => {
    let x = Math.log(20_000) + (Math.log(2_500_000) - Math.log(20_000)) * unit(`cash|${name}|level`);
    for (let j = 0; j <= row; j++) x += uniform(`cash|${name}|step|${j}`, -0.08, 0.08);
    return Math.exp(x);
  };
  const history = ((cash['history'] as Obj[] | undefined) ?? []).map((h, row) => {
    const balances: Obj = {};
    for (const [k, v] of Object.entries((h['balances'] as Obj | undefined) ?? {})) {
      const name = entityName(k);
      balances[name] = typeof v === 'number' ? ctx.around(`snap/cash/history[${row}]/${name}`, Math.sign(v), walkLevel(name, row), 0.01) : v;
    }
    return { ...h, total: typeof h['total'] === 'number' ? ctx.money(h['total'], `snap/cash/history[${row}]/total`, 'totalCash') : (h['total'] ?? null), balances };
  });
  const cashOut = W({ ...cash, entities: [], history: [] }, 'cash', 'snap/cash') as Obj;
  cashOut['entities'] = entities;
  cashOut['history'] = history;
  cashOut['largestEntity'] = typeof cash['largestEntity'] === 'string' ? entityName(cash['largestEntity']) : (cash['largestEntity'] ?? null);
  out['cash'] = cashOut;

  out['insurance'] = arr('insurance').map((i, j) => {
    const q = W(i, 'insurance', `snap/insurance[${j}]`, set('notes', 'issue')) as Obj;
    q['carrier'] = ctx.a.alias('carrier', str(i['carrier']));
    q['policyNo'] = ctx.a.alias('policy', str(i['policyNo']));
    return q;
  });
  out['deals'] = arr('deals').map((d) => transformDeal(ctx, ids, d));
  out['tasks'] = arr('tasks').map((t, i) => {
    const q = W(t, 'task', `snap/tasks[${i}]`) as Obj;
    q['label'] = t['type'] === 'M365 To-Do' ? ctx.free('task', t['label']) : ctx.t(str(t['label']));
    q['notes'] = ctx.free('task note', t['notes']);
    return q;
  });
  out['counterparties'] = arr('counterparties').map((c) => transformCounterparty(ctx, ids, c));
  const remapKeys = (o: Json | undefined, m: Map<string, string>, valueFn: (v: Json, key: string) => Json = (v) => v): Obj => {
    const r: Obj = {};
    for (const [k, v] of Object.entries((o as Obj | undefined) ?? {})) {
      const nk = m.get(k) ?? refLeaseId(ctx, ids, k);
      r[nk] = valueFn(v, nk);
    }
    return r;
  };
  // AR balances carry their tenant/company, so an orphan lease id there keeps its prefix (leaseId);
  // they are mapped before the bare-keyed maps below so those reuse the same fake id.
  const arBalances = arr('arBalances').map((b, i) => {
    const q = W(b, 'arBalance', `snap/arBalances[${i}]`) as Obj;
    q['leaseId'] = b['leaseId'] == null ? null
      : leaseId(ctx, ids, { id: String(b['leaseId']), company: b['company'] ?? null, tenantName: b['tenantName'] ?? null });
    q['tenantName'] = ctx.a.alias('person', str(b['tenantName']));
    q['company'] = b['company'] ? ctx.a.alias('company', str(b['company'])) : (b['company'] ?? null);
    q['propertyKey'] = b['propertyKey'] ?? null;
    q['propertyId'] = b['propertyId'] ?? null;
    return q;
  });
  out['renewalStages'] = remapKeys(s['renewalStages'], ids.lease);
  out['tenantNotes'] = remapKeys(s['tenantNotes'], ids.lease, (v) => (typeof v === 'string' ? ctx.free('tenant note', v) : v));
  out['tenantArrears'] = remapKeys(s['tenantArrears'], ids.lease, (v, k) => W(v, 'arrears', `snap/tenantArrears/${k}`));
  out['arBalances'] = arBalances;
  // Deal comps: keyed by the pipeline deal; comp addresses and source links are replaced.
  let comp = 0;
  const dealComps: Obj = {};
  const dcEntries = Object.entries((s['dealComps'] as Obj | undefined) ?? {});
  // Draw keys use the ordinal of the deal's synthetic key in sorted order: name-free, independent of
  // how the snapshot producer ordered the deals (refute round 5 F4), and stable when the generator is
  // re-run on its own output (the draw-#0 test).
  const sortedSk = dcEntries.map(([k]) => ctx.t(k)!).sort();
  dcEntries.forEach(([k, v]) => {
    const c = v as Obj;
    const sk = ctx.t(k)!;
    const di = sortedSk.indexOf(sk);
    ids.comp.set(k, sk);
    const fixComp = (kind: string) => (x: Json, j: number): Json => {
      const o = W(x, 'comp', `snap/dealComps#${di}/${kind}[${j}]`) as Obj;
      comp += 1;
      if ('address' in o) o['address'] = `Comp ${pad(comp, 3)}`;
      if (typeof o['source'] === 'string') o['source'] = `https://example.com/comp-source/${pad(comp, 3)}`;
      return o;
    };
    dealComps[sk] = {
      ...(W({ ...c, saleComps: [], rentComps: [], sources: [] }, 'dealComps', `snap/dealComps#${di}`) as Obj),
      saleComps: ((c['saleComps'] as Json[] | undefined) ?? []).map(fixComp('saleComps')),
      rentComps: ((c['rentComps'] as Json[] | undefined) ?? []).map(fixComp('rentComps')),
      sources: ((c['sources'] as Json[] | undefined) ?? []).map((_x, i) => `https://example.com/market-source/${pad(i + 1, 3)}`),
    };
  });
  out['dealComps'] = dealComps;
  const qb = s['quickbooks'] as Obj | null | undefined;
  if (qb !== undefined) out['quickbooks'] = qb ? { ...(W(qb, 'quickbooks', 'snap/quickbooks') as Obj), sourceFile: 'synthetic/ora-pl-by-property.csv' } : qb;
  out['dataQuality'] = arr('dataQuality').map((f) => ({ ...f, issue: ctx.free('data-quality issue', f['issue']) }));
  for (const k of ['meta', 'assumptions', 'acquisitionInputs', 'noiBudgets', 'marketRents', 'governors', 'workbookTotals']) {
    if (k in s) out[k] = W(s[k]!, k, `snap/${k}`);
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

/** A money leaf of a property-financials tree: (synthetic path, field name, real value) -> drawn value. */
type PfLeaf = (path: readonly string[], field: string, v: number) => number;

/** dataset.json: every numeric key not in PF_KEEP (or a *_pct/_ratio/_margin) is a USD amount, except
 *  inside a `yoy` block, whose line values are percents; its `delta` / `opex_by_delta` children are
 *  dollars again. Amounts go to `leaf` with their synthetic path. */
function walkPf(ctx: Ctx, v: Json, key: string, inYoy: boolean, path: readonly string[], leaf: PfLeaf): Json {
  if (Array.isArray(v)) return v.map((x, i) => walkPf(ctx, x, key, inYoy, [...path, String(i)], leaf));
  if (v && typeof v === 'object') {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const generic = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
      const childYoy = k === 'yoy' ? true : k === 'delta' || k === 'opex_by_delta' ? false : inYoy;
      // In a driver row {p, n, d} `n` is the NEW-period amount (elsewhere `n` counts months).
      const driverN = k === 'n' && 'p' in (v as Obj) && 'd' in (v as Obj);
      const ok = generic ? ctx.t(k)! : k;
      out[ok] = walkPf(ctx, x, generic ? `${key}.*` : driverN ? 'n_amount' : k, childYoy, [...path, ok], leaf);
    }
    return out;
  }
  if (typeof v === 'number') {
    if (inYoy || PF_KEEP.has(key) || /(^|_)(pct|ratio|margin)$/.test(key)) return v;
    return leaf(path, key, v);
  }
  if (typeof v === 'string') return ctx.t(v);
  return v;
}

/** History / revenue-category names -> the P&L line they are an amount of. */
const PF_LINE: Readonly<Record<string, string>> = {
  br: 'base_rent',
  'Base rent': 'base_rent',
  rv: 'revenue',
  rev: 'revenue',
  ox: 'opex',
  tx: 'Real estate & property tax',
  'Vacancy / waivers / bad debt': 'vacancy_waivers',
  'Recoveries (CAM/tax/ins)': 'recoveries',
  'Utility reimbursements': 'utility_reimb',
  'Other income': 'other_income',
  'Solar / energy income': 'energy_income',
};
const pfLine = (k: string): string => PF_LINE[k] ?? k;
/** The period field a history `rc` (revenue category) mirrors. */
const RC_FIELD: Readonly<Record<string, string>> = {
  'Base rent': 'base_rent',
  'Vacancy / waivers / bad debt': 'vacancy_waivers',
  'Recoveries (CAM/tax/ins)': 'recoveries',
  'Utility reimbursements': 'utility_reimb',
  'Other income': 'other_income',
  'Solar / energy income': 'energy_income',
};
const PF_OPEX_CATS = [
  'Real estate & property tax', 'Insurance', 'Management fees', 'Utilities', 'Grounds / snow / lot', 'Repairs & maintenance',
  'Turnover / make-ready', 'Professional / admin',
];
const PF_REV_COMPONENTS = ['base_rent', 'reimbursements', 'other_income'];

/** The year a period / history label refers to (FY2025 -> 2025, YTD26 -> 2026, 2024-07 -> 2024). */
function pfYear(label: string): number {
  const four = /(20\d{2})/.exec(label)?.[1];
  if (four) return Number(four);
  const two = /(\d{2})/.exec(label)?.[1];
  return two ? 2000 + Number(two) : 2025;
}

/**
 * The seeded P&L model behind every dataset.json amount. Per entity and line it draws an annual
 * level (the line's $/SF band x the entity's SF), a gentle drawn drift per year, and for base rent a
 * flat series stepped at the entity's REAL rent-event months by a drawn percentage (event DATES are
 * kept; their sizes are not). Each leaf is then a small jitter around the model value, with the real
 * amount's sign and exact zero kept. A line billed in only k months of a year (the real zero pattern)
 * spreads the year's amount over those k months, so lumpy lines (tax, insurance) stay lumpy and a
 * year's total stays plausible. Nothing here reads the magnitude of a real amount.
 */
class PfModel {
  private readonly levels = new Map<string, number>();
  constructor(
    private readonly ctx: Ctx,
    private readonly real: Obj,
  ) {}

  private obj(...keys: string[]): Obj | undefined {
    let v: Json | undefined = this.real;
    for (const k of keys) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj)[k] : undefined;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
  }

  sfOf(id: string): number {
    const a = num(this.obj('sf', id)?.['sf']);
    const b = num(this.obj('properties', id)?.['sf']);
    return a && a > 0 ? a : b && b > 0 ? b : DEFAULT_SF;
  }

  /** Annual level of one line of one entity (totals are the sums of their drawn components). */
  level(id: string, line: string): number {
    const k = `${id}|${line}`;
    const hit = this.levels.get(k);
    if (hit !== undefined) return hit;
    let v: number;
    if (line === 'revenue') v = PF_REV_COMPONENTS.reduce((a, l) => a + this.level(id, l), 0);
    else if (line === 'opex') v = PF_OPEX_CATS.reduce((a, l) => a + this.level(id, l), 0);
    else if (line === 'noi') v = Math.max(this.level(id, 'revenue') - this.level(id, 'opex'), 0.1 * this.level(id, 'revenue'));
    else if (line === 'pool') v = PF_POOL.reduce((a, l) => a + this.level(id, l), 0);
    else if (line.startsWith('acct:')) {
      // an account inside a category: a drawn share of its category's level
      const cat = line.split('|')[1] ?? '';
      v = this.level(id, cat) * uniform(`pf|${id}|${line}|share`, 0.2, 1);
    } else {
      const band = bandFor(line);
      v = uniform(`pf|${id}|${line}|level`, band.lo, band.hi) * (band.perSf ? this.sfOf(id) : 1);
    }
    this.levels.set(k, v);
    return v;
  }

  /** Cumulative drawn drift of a line, 1.0 in 2024. */
  growth(id: string, line: string, year: number): number {
    let f = 1;
    const g = (y: number): number => 1 + uniform(`pf|${id}|${line}|g|${y}`, -0.03, 0.07);
    if (year > 2024) for (let y = 2025; y <= year; y++) f *= g(y);
    else for (let y = year + 1; y <= 2024; y++) f /= g(y);
    return f;
  }

  /** Base-rent step factor at a month: the product of the drawn steps at every real event month <= it. */
  rentFactor(id: string, month: string): number {
    const evs = ((this.obj('history', id)?.['ev'] as Obj[] | undefined) ?? []).map((e) => String(e['m'])).sort();
    let f = 1;
    for (const m of evs) {
      if (m > month) break;
      const up = unit(`pf|${id}|stepsign|${m}`) < 0.8;
      f *= 1 + (up ? 1 : -1) * uniform(`pf|${id}|step|${m}`, 0.06, 0.16);
    }
    return f;
  }

  /** One month's amount of a line (sign / zero from the real value; `active` = billed months that year). */
  monthly(key: string, id: string, line: string, month: string, sign: number, active: number): number {
    if (sign === 0) return 0;
    const year = pfYear(month);
    if (line === 'base_rent') return this.ctx.around(key, sign, (this.level(id, line) / 12) * this.rentFactor(id, month), 0);
    if (line === 'revenue') {
      const rest = this.level(id, 'revenue') - this.level(id, 'base_rent');
      const center = (this.level(id, 'base_rent') / 12) * this.rentFactor(id, month) + (rest / 12) * this.growth(id, 'revenue', year);
      return this.ctx.around(key, sign, center, 0.04);
    }
    const center = (this.level(id, line) * this.growth(id, line, year)) / Math.max(1, Math.min(12, active));
    return this.ctx.around(key, sign, center, 0.2);
  }

  /** An amount of a line over `months` months of a year. */
  annual(key: string, id: string, line: string, year: number, months: number, sign: number, decimals = 2): number {
    if (sign === 0) return 0;
    const share = Math.max(months, 0.5) / 12;
    if (line === 'base_rent') return this.ctx.around(key, sign, this.level(id, line) * this.rentFactor(id, `${year}-06`) * share, 0.02, decimals);
    return this.ctx.around(key, sign, this.level(id, line) * this.growth(id, line, year) * share, 0.08, decimals);
  }

  /** Billed months of a line in a year, from the real zero pattern of a parallel monthly series. */
  private activeIn(values: Array<number | null>, months: string[], year: number): number {
    let k = 0;
    months.forEach((m, i) => {
      if (m.startsWith(`${year}-`) && (values[i] ?? 0) !== 0) k++;
    });
    return k || 12;
  }

  leaf: PfLeaf = (path, field, v) => {
    const sign = Math.sign(v);
    if (!Number.isFinite(v) || v === 0) return v;
    const key = `pf/${path.join('/')}`;
    const [blk, id = ''] = path;
    if (blk === 'monthly') {
      const month = path[2] ?? '';
      const line = path[3] === 'opex_by' ? (path[4] ?? '') : (path[3] ?? field);
      const cube = this.obj('monthly', id) ?? {};
      const months = Object.keys(cube).sort();
      const vals = months.map((m) => {
        const row = cube[m] as Obj | undefined;
        return num(path[3] === 'opex_by' ? ((row?.['opex_by'] as Obj | undefined) ?? {})[line] : row?.[line]);
      });
      return this.monthly(key, id, line, month, sign, this.activeIn(vals, months, pfYear(month)));
    }
    if (blk === 'properties') {
      if (path[2] === 'periods') {
        const per = path[3] ?? '';
        const line = path[4] === 'opex_by' ? (path[5] ?? '') : (path[4] ?? field);
        const n = num(this.obj('properties', id, 'periods', per)?.['n_months']) ?? 12;
        return this.annual(key, id, line, pfYear(per), n, sign);
      }
      if (path[2] === 'base_rent_runrate_q3') return this.annual(key, id, 'base_rent', pfYear(path[3] ?? ''), 12, sign);
      if (path[2] === 'nonop') return this.ctx.money(v, key, path[3] ?? field);
      // yoy deltas and anything else: a small amount on the entity's scale (re-derived where it held)
      return this.ctx.money(v, key, 'capex', this.sfOf(id));
    }
    if (blk === 'history') {
      const sub = path[2];
      if (sub === 'yr' || sub === 'ytd') {
        const y = path[3] ?? '';
        const f = path[4] ?? field;
        const line = f === 'cats' || f === 'rc' ? pfLine(path[5] ?? '') : pfLine(f);
        const n = num(this.obj('history', id, sub, y)?.['n']) ?? 12;
        return this.annual(key, id, line, pfYear(y), n, sign);
      }
      if (sub === 'months') {
        const arr = path[3] ?? '';
        const i = Number(path[4]);
        const series = this.obj('history', id, 'months') ?? {};
        const g = ((series['g'] as Json[] | undefined) ?? []).map(String);
        const vals = ((series[arr] as Json[] | undefined) ?? []).map((x) => num(x));
        const month = g[i] ?? '2025-01';
        return this.monthly(key, id, pfLine(arr), month, sign, this.activeIn(vals, g, pfYear(month)));
      }
      if (sub === 'drv') {
        const y = path[3] ?? '';
        const row = ((this.obj('history', id, 'drv') ?? {})[y] as Obj[] | undefined)?.[Number(path[4])] ?? {};
        const cat = String(row['c'] ?? '');
        const line = `acct:|${pfLine(cat)}|${String(row['a'] ?? '')}`;
        const year = pfYear(y);
        const nm = /^\d{4}$/.test(y) ? 12 : 9;
        if (field === 'p') return this.annual(key, id, line, year - 1, nm, sign, 0);
        return this.annual(key, id, line, year, nm, sign, 0);
      }
      return this.ctx.money(v, key, 'base_rent', this.sfOf(id) / 12);
    }
    if (blk === 'account_movers') {
      const cmp = path[2] ?? '';
      const row = ((this.obj('account_movers', id) ?? {})[cmp] as Obj[] | undefined)?.[Number(path[3])] ?? {};
      const [cur = 'FY2025', prior = 'FY2024'] = cmp.split('_vs_');
      const line = `acct:|${String(row['category'] ?? '')}|${String(row['account'] ?? '')}`;
      const per = field === 'prior' ? prior : cur;
      const n = num(this.obj('properties', id, 'periods', per)?.['n_months']) ?? 12;
      return this.annual(key, id, line, pfYear(per), n, sign);
    }
    if (blk === 'insights') {
      const ins = ((this.real['insights'] as Obj[] | undefined) ?? [])[Number(id)] ?? {};
      const ev = (ins['evidence'] as Obj | undefined) ?? {};
      const prop = String(ins['property'] ?? '');
      if (/^q3_\d{4}$/.test(field)) return this.annual(key, prop, 'base_rent', pfYear(field), 12, sign);
      return this.ctx.money(v, key, field, num(ev['sf']) ?? this.sfOf(prop));
    }
    if (blk === 'leases') {
      const l = ((this.real['leases'] as Obj[] | undefined) ?? [])[Number(id)] ?? {};
      return this.ctx.money(v, key, field, num(l['sf']));
    }
    if (blk === 'portfolio') return this.ctx.money(v, key, field === 'current' || field === 'prior' ? 'base_rent' : field, 150_000);
    return this.ctx.money(v, key, field);
  };
}

/** Per-entity blocks: every amount of one entity shares one keyed multiplier (its own margins, YoY
 *  and month/period/history sums stay consistent); entities are independent of each other. */
const PF_ENTITY_BLOCKS = new Set(['properties', 'monthly', 'history', 'account_movers', 'sf']);

const num = (v: Json | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const held = (a: number | null, b: number | null, tol: number): boolean => a !== null && b !== null && Math.abs(a - b) <= tol;

/** Walk real and synthetic trees in parallel and re-derive the in-record identities that held in the
 *  real file: noi = revenue - opex, reimbursements = recoveries + utility_reimb (period / monthly
 *  rows) and noi = rev - opex (history yr / ytd rows). */
function fixPfIdentities(real: Json, syn: Json): void {
  if (Array.isArray(real) && Array.isArray(syn)) {
    real.forEach((r, i) => fixPfIdentities(r, syn[i] ?? null));
    return;
  }
  if (!real || typeof real !== 'object' || !syn || typeof syn !== 'object' || Array.isArray(syn)) return;
  const r = real as Obj;
  const o = syn as Obj;
  const rule = (target: string, a: string, b: string, sign: 1 | -1): void => {
    const rt = num(r[target]);
    const ra = num(r[a]);
    const rb = num(r[b]);
    if (rt === null || ra === null || rb === null || !held(rt, ra + sign * rb, 0.006)) return;
    const sa = num(o[a]);
    const sb = num(o[b]);
    if (sa === null || sb === null) return;
    o[target] = roundTo(sa + sign * sb, 2);
  };
  rule('reimbursements', 'recoveries', 'utility_reimb', 1);
  rule('noi', 'revenue', 'opex', -1);
  rule('noi', 'rev', 'opex', -1);
  for (const [k, v] of Object.entries(r)) if (v && typeof v === 'object') fixPfIdentities(v, o[k] ?? null);
}

/**
 * Bottom-up re-derivation of the P&L sums after rounding (each amount was rounded to cents on its
 * own, which would otherwise leave totals a few cents off their parts). Applied only where the
 * identity held in the real file:
 *   monthly row:  opex = sum(opex_by), revenue = sum(revenue lines), noi = revenue - opex
 *   period:       every amount = sum of its months (monthly entities), then the same row identities,
 *                 pool = tax + insurance + utilities + grounds + R&M, and the 2-dp ratios
 *   run-rate:     q3_YYYY = 4 x sum(Jul..Sep base rent)
 *   history:      yr[Y] / ytd[Y] lines mirror the FY / YTD period figures
 */
const PF_REV_LINES = ['base_rent', 'vacancy_waivers', 'reimbursements', 'other_income', 'energy_income'];
const PF_POOL = ['Real estate & property tax', 'Insurance', 'Utilities', 'Grounds / snow / lot', 'Repairs & maintenance'];

function fixPfSums(real: Obj, syn: Obj): void {
  const sumKeys = (o: Obj, keys: string[]): number => keys.reduce((a, k) => a + (num(o[k]) ?? 0), 0);
  const obSum = (o: Obj): number => Object.values((o['opex_by'] as Obj | undefined) ?? {}).reduce<number>((a, v) => a + (num(v) ?? 0), 0);
  const poolOf = (o: Obj): number => sumKeys((o['opex_by'] as Obj | undefined) ?? {}, PF_POOL);
  const setIf = (r: Obj, o: Obj, f: string, rv: number, sv: number, tol = 0.006): void => {
    if (held(num(r[f]), rv, tol)) o[f] = roundTo(sv, 2);
  };
  const rowIdentities = (r: Obj, o: Obj, fromMonths = false, signKey: string | null = null): void => {
    if (signKey && held(num(r['noi']), (num(r['revenue']) ?? NaN) - (num(r['opex']) ?? NaN), 0.006)) {
      // a period built from its own lines (annual entity): keep NOI's real sign
      const rev = sumKeys(o, ['base_rent', 'vacancy_waivers', 'other_income', 'energy_income']) +
        (held(num(r['reimbursements']), sumKeys(r, ['recoveries', 'utility_reimb']), 0.006) ? sumKeys(o, ['recoveries', 'utility_reimb']) : (num(o['reimbursements']) ?? 0));
      const ob = o['opex_by'] as Obj | undefined;
      if (ob) opexToSign(ob, rev, num(r['noi']), signKey);
    }
    setIf(r, o, 'opex', obSum(r), obSum(o));
    if (fromMonths) {
      // reimbursements came from the months (which carry no recoveries / utility split): keep the
      // split consistent by deriving the utility part from it
      const rr = num(r['reimbursements']);
      if (held(rr, sumKeys(r, ['recoveries', 'utility_reimb']), 0.006) && num(o['reimbursements']) !== null) o['utility_reimb'] = roundTo(num(o['reimbursements'])! - (num(o['recoveries']) ?? 0), 2);
    } else setIf(r, o, 'reimbursements', sumKeys(r, ['recoveries', 'utility_reimb']), sumKeys(o, ['recoveries', 'utility_reimb']));
    setIf(r, o, 'revenue', sumKeys(r, PF_REV_LINES), sumKeys(o, PF_REV_LINES));
    setIf(r, o, 'noi', (num(r['revenue']) ?? NaN) - (num(r['opex']) ?? NaN), (num(o['revenue']) ?? 0) - (num(o['opex']) ?? 0));
    if ('pool' in r) setIf(r, o, 'pool', poolOf(r), poolOf(o));
    const ratio = (f: string, a: (x: Obj) => number, b: (x: Obj) => number): void => {
      const rv = num(r[f]);
      if (rv === null || !b(r) || !held(rv, roundTo(a(r) / b(r), 2), 0.0001) || !b(o)) return;
      o[f] = roundTo(a(o) / b(o), 2);
    };
    ratio('noi_margin', (x) => num(x['noi']) ?? 0, (x) => num(x['revenue']) ?? 0);
    ratio('opex_ratio', (x) => num(x['opex']) ?? 0, (x) => num(x['revenue']) ?? 0);
    ratio('mgmt_fee_pct', (x) => num(((x['opex_by'] as Obj | undefined) ?? {})['Management fees']) ?? 0, (x) => num(x['revenue']) ?? 0);
    ratio('recovery_ratio', (x) => sumKeys(x, ['recoveries', 'utility_reimb']), (x) => num(x['pool']) ?? 0);
  };
  const periodsMeta = ((real['meta'] as Obj | undefined)?.['periods'] as Obj | undefined) ?? {};
  const rProps = (real['properties'] as Obj | undefined) ?? {};
  const sProps = (syn['properties'] as Obj | undefined) ?? {};
  const rMonthly = (real['monthly'] as Obj | undefined) ?? {};
  const sMonthly = (syn['monthly'] as Obj | undefined) ?? {};
  for (const [id, rpv] of Object.entries(rProps)) {
    const rp = rpv as Obj;
    const sp = sProps[id] as Obj | undefined;
    if (!sp) continue;
    const rm = (rMonthly[id] as Obj | undefined) ?? {};
    const sm = (sMonthly[id] as Obj | undefined) ?? {};
    for (const [mk, rr] of Object.entries(rm)) if (sm[mk]) rowIdentities(rr as Obj, sm[mk] as Obj);
    const rPer = (rp['periods'] as Obj | undefined) ?? {};
    const sPer = (sp['periods'] as Obj | undefined) ?? {};
    for (const [per, rv] of Object.entries(rPer)) {
      const r = rv as Obj;
      const o = sPer[per] as Obj | undefined;
      if (!o) continue;
      const months = (((periodsMeta[per] as Obj | undefined)?.['months'] as Json[] | undefined) ?? []).map(String);
      if (rp['kind'] === 'monthly' && months.length) {
        const sumMonths = (src: Obj, path: string[]): number =>
          months.reduce((a, m) => {
            let v: Json | undefined = src[m];
            for (const k of path) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj)[k] : undefined;
            return a + (num(v) ?? 0);
          }, 0);
        const tol = 0.006 * months.length + 0.001;
        for (const [f, v] of Object.entries(r)) {
          if (typeof v === 'number' && !PF_KEEP.has(f) && !/(pct|ratio|margin)$/.test(f) && f !== 'pool') setIf(r, o, f, sumMonths(rm, [f]), sumMonths(sm, [f]), tol);
          if (f === 'opex_by' && v && typeof v === 'object') {
            for (const cat of Object.keys(v)) {
              const rc = num((v as Obj)[cat]);
              if (held(rc, sumMonths(rm, ['opex_by', cat]), tol)) ((o['opex_by'] as Obj)[cat] = roundTo(sumMonths(sm, ['opex_by', cat]), 2));
            }
          }
        }
        // period-only split (the months carry no recoveries): a drawn share of the period's own
        // drawn reimbursements, so utility_reimb (derived below) keeps its sign
        const sRe = num(o['reimbursements']);
        if ((num(r['recoveries']) ?? 0) > 0 && (num(r['reimbursements']) ?? 0) > 0 && sRe !== null && sRe > 0) {
          o['recoveries'] = roundTo(sRe * uniform(`pf/${id}/${per}/recoveries-share`, 0.6, 0.95), 2);
        }
      }
      const fromMonths = rp['kind'] === 'monthly' && months.length > 0;
      rowIdentities(r, o, fromMonths, fromMonths ? null : `pf/${id}/${per}/noi-sign`);
    }
    const rq = rp['base_rent_runrate_q3'] as Obj | undefined;
    const sq = sp['base_rent_runrate_q3'] as Obj | undefined;
    if (rq && sq) {
      for (const k of Object.keys(rq)) {
        const y = /^q3_(\d{4})$/.exec(k)?.[1];
        if (!y) continue;
        const q = (src: Obj): number => ['07', '08', '09'].reduce((a, mm) => a + (num(((src[`${y}-${mm}`] as Obj | undefined) ?? {})['base_rent']) ?? 0), 0) * 4;
        if (held(num(rq[k]), q(rm), 0.02)) sq[k] = roundTo(q(sm), 2);
      }
      for (const k of Object.keys(rq)) {
        const y = /^yoy_(\d{4})$/.exec(k)?.[1];
        const prev = y ? num(sq[`q3_${Number(y) - 1}`]) : null;
        const cur = y ? num(sq[`q3_${y}`]) : null;
        const rPrev = y ? num(rq[`q3_${Number(y) - 1}`]) : null;
        const rCur = y ? num(rq[`q3_${y}`]) : null;
        if (prev && cur && rPrev && rCur && held(num(rq[k]), roundTo(rCur / rPrev - 1, 2), 0.0001)) sq[k] = roundTo(cur / prev - 1, 2);
      }
    }
  }
  const rH = (real['history'] as Obj | undefined) ?? {};
  const sH = (syn['history'] as Obj | undefined) ?? {};
  // yoy blocks: pct = round2(cur / prior - 1) and delta = cur - prior, from the re-derived periods
  for (const [id, rpv] of Object.entries(rProps)) {
    const ry = ((rpv as Obj)['yoy'] as Obj | undefined) ?? {};
    const sp = sProps[id] as Obj | undefined;
    const sy = (sp?.['yoy'] as Obj | undefined) ?? {};
    const rPer = ((rpv as Obj)['periods'] as Obj | undefined) ?? {};
    const sPer = (sp?.['periods'] as Obj | undefined) ?? {};
    for (const [cmp, rowv] of Object.entries(ry)) {
      const m = /^(\w+?)_vs_(\w+)$/.exec(cmp);
      const r = rowv as Obj | null;
      const o = sy[cmp] as Obj | null;
      if (!m || !r || !o) continue;
      const [, cur, prior] = m as unknown as [string, string, string];
      const rc = rPer[cur] as Obj | undefined;
      const rp = rPer[prior] as Obj | undefined;
      const sc = sPer[cur] as Obj | undefined;
      const spr = sPer[prior] as Obj | undefined;
      if (!rc || !rp || !sc || !spr) continue;
      const fix = (rPct: Json | undefined, a: number | null, b: number | null, sa: number | null, sb: number | null, set: (v: number) => void): void => {
        const rv = num(rPct ?? null);
        if (rv === null || a === null || b === null || b <= 0 || !held(rv, roundTo(a / b - 1, 2), 0.0001) || sa === null || sb === null || sb <= 0) return;
        set(roundTo(sa / sb - 1, 2));
      };
      for (const line of Object.keys(r)) {
        if (line === 'opex_by' || line === 'opex_by_delta' || line === 'delta') continue;
        fix(r[line], num(rc[line]), num(rp[line]), num(sc[line]), num(spr[line]), (v) => (o[line] = v));
      }
      const rob = (r['opex_by'] as Obj | undefined) ?? {};
      const sob = (o['opex_by'] as Obj | undefined) ?? {};
      for (const cat of Object.keys(rob)) {
        const g = (x: Obj, c: string): number | null => num(((x['opex_by'] as Obj | undefined) ?? {})[c]);
        fix(rob[cat], g(rc, cat), g(rp, cat), g(sc, cat), g(spr, cat), (v) => (sob[cat] = v));
      }
      for (const dk of ['delta', 'opex_by_delta']) {
        const rd = (r[dk] as Obj | undefined) ?? {};
        const sd = (o[dk] as Obj | undefined) ?? {};
        for (const k of Object.keys(rd)) {
          const g = (x: Obj): number | null => (dk === 'delta' ? num(x[k]) : num(((x['opex_by'] as Obj | undefined) ?? {})[k]));
          const a = g(rc);
          const b = g(rp);
          if (a !== null && b !== null && held(num(rd[k]), a - b, 0.011) && g(sc) !== null && g(spr) !== null) sd[k] = roundTo(g(sc)! - g(spr)!, 2);
        }
      }
    }
  }
  // history rows: opex = sum(cats) and noi = rev - opex wherever that held (every year, before mirroring)
  for (const [id, hv] of Object.entries(rH)) {
    const sh = sH[id] as Obj | undefined;
    if (!sh) continue;
    for (const block of ['yr', 'ytd']) {
      for (const [yr, rowv] of Object.entries(((hv as Obj)[block] as Obj | undefined) ?? {})) {
        const r = rowv as Obj;
        const o = ((sh[block] as Obj | undefined) ?? {})[yr] as Obj | undefined;
        if (!o) continue;
        const cats = (x: Obj): number => Object.values((x['cats'] as Obj | undefined) ?? {}).reduce<number>((a, v) => a + (num(v) ?? 0), 0);
        const rcs = (x: Obj): number => Object.values((x['rc'] as Obj | undefined) ?? {}).reduce<number>((a, v) => a + (num(v) ?? 0), 0);
        const rcBr = (x: Obj): number | null => num(((x['rc'] as Obj | undefined) ?? {})['Base rent']);
        if (held(num(r['br']), rcBr(r), 0.06) && rcBr(o) !== null) o['br'] = rcBr(o);
        if (held(num(r['rev']), rcs(r), 0.06)) o['rev'] = roundTo(rcs(o), 2);
        // keep the row's real NOI sign (a loss year) where noi = rev - opex and opex = sum(cats) held
        if (o['cats'] && held(num(r['opex']), cats(r), 0.006 * 12) && held(num(r['noi']), (num(r['rev']) ?? NaN) - (num(r['opex']) ?? NaN), 0.012)) {
          opexToSign(o['cats'] as Obj, num(o['rev']) ?? 0, num(r['noi']), `pf/${id}/${block}/${yr}/noi-sign`);
        }
        if (held(num(r['opex']), cats(r), 0.006 * 12)) o['opex'] = roundTo(cats(o), 2);
        if (held(num(r['noi']), (num(r['rev']) ?? NaN) - (num(r['opex']) ?? NaN), 0.012)) o['noi'] = roundTo((num(o['rev']) ?? 0) - (num(o['opex']) ?? 0), 2);
      }
    }
  }
  // history yr / ytd mirror the FY / YTD period figures
  const MIRROR: Array<[string, string]> = [['br', 'base_rent'], ['rev', 'revenue'], ['opex', 'opex'], ['noi', 'noi']];
  for (const [id, hv] of Object.entries(rH)) {
    const sh = sH[id] as Obj | undefined;
    const rPer = ((rProps[id] as Obj | undefined)?.['periods'] as Obj | undefined) ?? {};
    const sPer = ((sProps[id] as Obj | undefined)?.['periods'] as Obj | undefined) ?? {};
    if (!sh) continue;
    for (const [block, prefix] of [['yr', 'FY'], ['ytd', 'YTD']] as const) {
      for (const [yr, rowv] of Object.entries(((hv as Obj)[block] as Obj | undefined) ?? {})) {
        const per = prefix === 'FY' ? `FY${yr}` : `YTD${yr.slice(2)}`;
        const rp = rPer[per] as Obj | undefined;
        const spp = sPer[per] as Obj | undefined;
        const so = ((sh[block] as Obj | undefined) ?? {})[yr] as Obj | undefined;
        if (!rp || !spp || !so) continue;
        const mirror = (rv: number | null, rpv: number | null, spv: Json | undefined): Json | undefined =>
          rv !== null && held(rv, rpv, 0.506) && num(spv ?? null) !== null ? roundTo(num(spv ?? null)!, 2) : undefined;
        for (const [hk, pk] of MIRROR) {
          const m = mirror(num((rowv as Obj)[hk]), num(rp[pk]), spp[pk]);
          if (m !== undefined) so[hk] = m;
        }
        const rc = (rowv as Obj)['cats'] as Obj | undefined;
        const sc = so['cats'] as Obj | undefined;
        if (rc && sc) {
          for (const cat of Object.keys(rc)) {
            const m = mirror(num(rc[cat]), num(((rp['opex_by'] as Obj) ?? {})[cat]), ((spp['opex_by'] as Obj) ?? {})[cat]);
            if (m !== undefined) sc[cat] = m;
          }
        }
        // revenue categories mirror their period revenue line
        const rrc = (rowv as Obj)['rc'] as Obj | undefined;
        const src = so['rc'] as Obj | undefined;
        if (rrc && src) {
          for (const cat of Object.keys(rrc)) {
            const f = RC_FIELD[cat];
            if (!f) continue;
            const m = mirror(num(rrc[cat]), num(rp[f]), spp[f]);
            if (m !== undefined) src[cat] = m;
          }
        }
      }
    }
  }
  // second pass, after mirroring: every history row keeps opex = sum(cats) and noi = rev - opex
  // (a row mirrored from a period keeps the period's noi; any cents of rounding residual between its
  // cats and opex go to its largest category), then a partial current year's yr row equals its ytd row
  const catsOf = (x: Obj): number => Object.values((x['cats'] as Obj | undefined) ?? {}).reduce<number>((acc, v) => acc + (num(v) ?? 0), 0);
  for (const [id, hv] of Object.entries(rH)) {
    const sh = sH[id] as Obj | undefined;
    if (!sh) continue;
    for (const block of ['yr', 'ytd']) {
      for (const [yr, rowv] of Object.entries(((hv as Obj)[block] as Obj | undefined) ?? {})) {
        const r = rowv as Obj;
        const o = ((sh[block] as Obj | undefined) ?? {})[yr] as Obj | undefined;
        if (!o) continue;
        const per = block === 'yr' ? `FY${yr}` : `YTD${yr.slice(2)}`;
        const rPeriod = (((rProps[id] as Obj | undefined)?.['periods'] as Obj | undefined) ?? {})[per] as Obj | undefined;
        const mirrored = !!rPeriod && held(num(r['noi']), num(rPeriod['noi']), 0.506);
        const catsHeld = held(num(r['opex']), catsOf(r), 0.006 * 12);
        const rcOf = (x: Obj): number => Object.values((x['rc'] as Obj | undefined) ?? {}).reduce<number>((acc, v) => acc + (num(v) ?? 0), 0);
        const rcHeld = held(num(r['rev']), rcOf(r), 0.06);
        const brHeld = held(num(r['br']), num(((r['rc'] as Obj | undefined) ?? {})['Base rent']), 0.06);
        if (mirrored) {
          const sc = o['cats'] as Obj | undefined;
          const residual = roundTo((num(o['opex']) ?? 0) - catsOf(o), 2);
          if (catsHeld && sc && residual !== 0) {
            const big = Object.keys(sc).reduce((a, k) => (Math.abs(num(sc[k]) ?? 0) > Math.abs(num(sc[a]) ?? 0) ? k : a), Object.keys(sc)[0]!);
            sc[big] = roundTo((num(sc[big]) ?? 0) + residual, 2);
          }
          // revenue categories: any residual against the mirrored revenue goes to the largest
          // non-base-rent category (base rent stays equal to br)
          const src = o['rc'] as Obj | undefined;
          const rres = roundTo((num(o['rev']) ?? 0) - rcOf(o), 2);
          if (rcHeld && src && rres !== 0) {
            const keys = Object.keys(src).filter((k) => k !== 'Base rent' || Object.keys(src).length === 1);
            if (keys.length) {
              const big = keys.reduce((a, k) => (Math.abs(num(src[k]) ?? 0) > Math.abs(num(src[a]) ?? 0) ? k : a), keys[0]!);
              src[big] = roundTo((num(src[big]) ?? 0) + rres, 2);
            }
          }
          continue;
        }
        if (brHeld && num(((o['rc'] as Obj | undefined) ?? {})['Base rent']) !== null) o['br'] = num((o['rc'] as Obj)['Base rent']);
        if (rcHeld) o['rev'] = roundTo(rcOf(o), 2);
        if (catsHeld) o['opex'] = roundTo(catsOf(o), 2);
        if (held(num(r['noi']), (num(r['rev']) ?? NaN) - (num(r['opex']) ?? NaN), 0.012)) o['noi'] = roundTo((num(o['rev']) ?? 0) - (num(o['opex']) ?? 0), 2);
      }
    }
    const ryr = ((hv as Obj)['yr'] as Obj | undefined) ?? {};
    const rytd = ((hv as Obj)['ytd'] as Obj | undefined) ?? {};
    const syr = (sh['yr'] as Obj | undefined) ?? {};
    const sytd = (sh['ytd'] as Obj | undefined) ?? {};
    for (const [y, rv] of Object.entries(ryr)) {
      const a = rv as Obj;
      const b = rytd[y] as Obj | undefined;
      if (!b || !sytd[y] || !syr[y]) continue;
      const same = ['br', 'rev', 'opex', 'noi'].every((k) => held(num(a[k]), num(b[k]), 0.006));
      if (same) for (const k of ['br', 'rev', 'opex', 'noi', 'cats', 'rc']) if (k in (sytd[y] as Obj)) (syr[y] as Obj)[k] = structuredClone((sytd[y] as Obj)[k] ?? null);
    }
  }
}

/**
 * NOI SIGN is a retained attribute (a loss-making month, year or period means something: lease-up,
 * a vacant year). Drawn revenue and opex lines are independent, so a derived NOI can come out with
 * the wrong sign; these helpers rescale the drawn opex categories of a row (never revenue, never by
 * anything read from a real magnitude) until NOI has the real sign.
 */
function opexToSign(cats: Obj, revenue: number, realNoi: number | null, key: string): void {
  if (realNoi === null || realNoi === 0 || !(revenue > 0)) return;
  const total = Object.values(cats).reduce<number>((a, v) => a + (num(v) ?? 0), 0);
  if (!(total > 0)) return;
  const want = Math.sign(realNoi);
  if (Math.sign(revenue - total) === want) return;
  const target = revenue * (want < 0 ? uniform(`${key}|loss`, 1.1, 1.5) : uniform(`${key}|profit`, 0.35, 0.75));
  const f = target / total;
  for (const c of Object.keys(cats)) if (num(cats[c]) !== null) cats[c] = roundTo(num(cats[c])! * f, 2);
}

/**
 * Monthly entities: a period's NOI is the sum of its months, so its sign is restored at month level.
 * The months whose real NOI was negative (the loss months, a sign) get their drawn opex scaled by one
 * multiplier per entity, searched upward from 1 until every month-derived period NOI has its real
 * sign. Only signs are read from the real file.
 */
function retainMonthlyNoiSigns(real: Obj, syn: Obj): void {
  const periodsMeta = ((real['meta'] as Obj | undefined)?.['periods'] as Obj | undefined) ?? {};
  const REV = ['base_rent', 'vacancy_waivers', 'reimbursements', 'other_income', 'energy_income'];
  for (const [id, pv] of Object.entries((real['properties'] as Obj | undefined) ?? {})) {
    if ((pv as Obj)['kind'] !== 'monthly') continue;
    const rm = (((real['monthly'] as Obj | undefined) ?? {})[id] as Obj | undefined) ?? {};
    const sm = (((syn['monthly'] as Obj | undefined) ?? {})[id] as Obj | undefined) ?? {};
    const loss = new Set(Object.keys(rm).filter((m) => (num((rm[m] as Obj)['noi']) ?? 0) < 0));
    if (!loss.size) continue;
    const rev = (m: string): number => REV.reduce((a, f) => a + (num((sm[m] as Obj | undefined)?.[f]) ?? 0), 0);
    const opex = (m: string): number => Object.values(((sm[m] as Obj | undefined)?.['opex_by'] as Obj | undefined) ?? {}).reduce<number>((a, v) => a + (num(v) ?? 0), 0);
    const checks: Array<{ months: string[]; sign: number }> = [];
    for (const [per, rp] of Object.entries(((pv as Obj)['periods'] as Obj | undefined) ?? {})) {
      const months = (((periodsMeta[per] as Obj | undefined)?.['months'] as Json[] | undefined) ?? []).map(String).filter((m) => m in sm);
      const rn = num((rp as Obj)['noi']);
      const sumReal = months.reduce((a, m) => a + (num((rm[m] as Obj | undefined)?.['noi']) ?? 0), 0);
      if (rn !== null && rn !== 0 && months.length && held(rn, sumReal, 0.006 * months.length + 0.01)) checks.push({ months, sign: Math.sign(rn) });
    }
    const ok = (mult: number): boolean =>
      checks.every(({ months, sign }) => Math.sign(months.reduce((a, m) => a + rev(m) - opex(m) * (loss.has(m) ? mult : 1), 0)) === sign);
    let mult = 1;
    for (let k = 0; k <= 400; k++) {
      if (ok(1 + 0.05 * k)) {
        mult = 1 + 0.05 * k;
        break;
      }
    }
    if (mult === 1) continue;
    for (const m of loss) {
      const ob = ((sm[m] as Obj | undefined)?.['opex_by'] as Obj | undefined) ?? {};
      for (const c of Object.keys(ob)) if (num(ob[c]) !== null) ob[c] = roundTo(num(ob[c])! * mult, 2);
    }
  }
}

/**
 * Account-level detail, re-derived from the drawn figures wherever the identity held in the real file:
 *   history drivers   n / p = the (rounded) history category of that year / the prior year,
 *                     d = n - p, pct = round3(n / p - 1)
 *   account movers    delta = current - prior, pct = round2(current / prior - 1)
 *   insight evidence  q3_YYYY = the property's Q3 run-rate figure
 */
function fixPfDetail(real: Obj, syn: Obj): void {
  const rH = (real['history'] as Obj | undefined) ?? {};
  const sH = (syn['history'] as Obj | undefined) ?? {};
  for (const [id, hv] of Object.entries(rH)) {
    const sh = sH[id] as Obj | undefined;
    if (!sh) continue;
    const rowOf = (h: Obj, y: string): Obj | undefined =>
      (/^\d{4}$/.test(y) ? ((h['yr'] as Obj | undefined) ?? {})[y] : ((h['ytd'] as Obj | undefined) ?? {})[`20${y.slice(3)}`]) as Obj | undefined;
    const prevOf = (y: string): string => (/^\d{4}$/.test(y) ? String(Number(y) - 1) : `YTD${Number(y.slice(3)) - 1}`);
    const catVal = (row: Obj | undefined, lt: Json | undefined, c: string): number | null =>
      row ? num((((lt === 'rev' ? row['rc'] : row['cats']) as Obj | undefined) ?? {})[c]) : null;
    for (const [y, list] of Object.entries(((hv as Obj)['drv'] as Obj | undefined) ?? {})) {
      const sl = (((sh['drv'] as Obj | undefined) ?? {})[y] as Obj[] | undefined) ?? [];
      ((list as Obj[] | undefined) ?? []).forEach((r, i) => {
        const o = sl[i];
        if (!o) return;
        const c = String(r['c'] ?? '');
        const rCur = catVal(rowOf(hv as Obj, y), r['lt'], c);
        const sCur = catVal(rowOf(sh, y), r['lt'], c);
        const rPrev = catVal(rowOf(hv as Obj, prevOf(y)), r['lt'], c);
        const sPrev = catVal(rowOf(sh, prevOf(y)), r['lt'], c);
        if (rCur !== null && sCur !== null && held(num(r['n']), Math.round(rCur), 1.01)) o['n'] = Math.round(sCur);
        if (rPrev !== null && sPrev !== null && held(num(r['p']), Math.round(rPrev), 1.01)) o['p'] = Math.round(sPrev);
        const rp = num(r['p']);
        const rn = num(r['n']);
        const sp = num(o['p']);
        const sn = num(o['n']);
        if (rp !== null && rn !== null && sp !== null && sn !== null) {
          if (held(num(r['d']), rn - rp, 1.01)) o['d'] = sn - sp;
          if (rp !== 0 && sp !== 0 && held(num(r['pct']), Math.round((rn / rp - 1) * 1000) / 1000, 0.0011)) o['pct'] = Math.round((sn / sp - 1) * 1000) / 1000;
        }
      });
    }
  }
  const rM = (real['account_movers'] as Obj | undefined) ?? {};
  const sM = (syn['account_movers'] as Obj | undefined) ?? {};
  for (const [id, per] of Object.entries(rM)) {
    for (const [cmp, list] of Object.entries((per as Obj | undefined) ?? {})) {
      const sl = ((((sM[id] as Obj | undefined) ?? {})[cmp]) as Obj[] | undefined) ?? [];
      ((list as Obj[] | undefined) ?? []).forEach((r, i) => {
        const o = sl[i];
        if (!o) return;
        const [rc, rp, sc, sp] = [num(r['current']), num(r['prior']), num(o['current']), num(o['prior'])];
        if (rc === null || rp === null || sc === null || sp === null) return;
        if (held(num(r['delta']), rc - rp, 0.02)) o['delta'] = roundTo(sc - sp, 2);
        if (rp !== 0 && sp !== 0 && held(num(r['pct']), roundTo(rc / rp - 1, 2), 0.0001)) o['pct'] = roundTo(sc / sp - 1, 2);
      });
    }
  }
  const rI = (real['insights'] as Obj[] | undefined) ?? [];
  const sI = (syn['insights'] as Obj[] | undefined) ?? [];
  rI.forEach((r, i) => {
    const o = sI[i];
    const rev = (r['evidence'] as Obj | undefined) ?? {};
    const sev = (o?.['evidence'] as Obj | undefined) ?? {};
    const prop = String(r['property'] ?? '');
    const rq = (((real['properties'] as Obj | undefined)?.[prop] as Obj | undefined)?.['base_rent_runrate_q3'] as Obj | undefined) ?? {};
    const sq = (((syn['properties'] as Obj | undefined)?.[prop] as Obj | undefined)?.['base_rent_runrate_q3'] as Obj | undefined) ?? {};
    for (const k of Object.keys(rev)) if (/^q3_\d{4}$/.test(k) && held(num(rev[k]), num(rq[k]), 0.01) && num(sq[k]) !== null) sev[k] = sq[k]!;
  });
}

/** Portfolio views are sums of their member entities' period figures: recompute them (and their
 *  rounded pct) from the perturbed members wherever that held in the real file. */
function fixPortfolioViews(real: Obj, syn: Obj): void {
  const rp = (real['portfolio'] as Obj | undefined) ?? {};
  const sp = (syn['portfolio'] as Obj | undefined) ?? {};
  const rprops = (real['properties'] as Obj | undefined) ?? {};
  const sprops = (syn['properties'] as Obj | undefined) ?? {};
  for (const [name, rv] of Object.entries(rp)) {
    const m = /_([A-Za-z]+\d+)_vs_([A-Za-z]+\d+)$/.exec(name);
    const rView = rv as Obj | null;
    const sView = sp[name] as Obj | null;
    if (!m || !rView || !sView || !Array.isArray(rView['members'])) continue;
    const [, cur, prior] = m as unknown as [string, string, string];
    const members = (rView['members'] as Json[]).map(String);
    const sumOf = (props: Obj, per: string, path: string[]): number | null => {
      let total = 0;
      for (const id of members) {
        let v: Json | undefined = ((props[id] as Obj | undefined)?.['periods'] as Obj | undefined)?.[per];
        for (const step of path) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj)[step] : undefined;
        const n = num(v);
        if (n === null) return null;
        total += n;
      }
      return total;
    };
    const fixLine = (rLine: Obj, sLine: Obj, path: string[]): void => {
      const tol = 0.006 * members.length + 0.01;
      const rc = sumOf(rprops, cur, path);
      const rpr = sumOf(rprops, prior, path);
      if (!held(num(rLine['current']), rc, tol) || !held(num(rLine['prior']), rpr, tol)) return;
      const sc = sumOf(sprops, cur, path);
      const spr = sumOf(sprops, prior, path);
      if (sc === null || spr === null) return;
      sLine['current'] = roundTo(sc, 2);
      sLine['prior'] = roundTo(spr, 2);
      const rpct = num(rLine['pct']);
      if (rpct !== null && rpr && held(rpct, roundTo(rc! / rpr - 1, 2), 0.0001) && spr) sLine['pct'] = roundTo(sc / spr - 1, 2);
    };
    const rvv = rView['view'] as Obj | undefined;
    const svv = sView['view'] as Obj | undefined;
    if (!rvv || !svv) continue;
    for (const [line, rl] of Object.entries(rvv)) {
      if (line === 'opex_by') {
        for (const [cat, rc] of Object.entries((rl as Obj) ?? {})) {
          const sc = ((svv['opex_by'] as Obj | undefined) ?? {})[ctx_key(cat)] as Obj | undefined;
          if (rc && sc) fixLine(rc as Obj, sc, ['opex_by', cat]);
        }
      } else if (rl && typeof rl === 'object' && svv[line]) fixLine(rl as Obj, svv[line] as Obj, [line]);
    }
  }
}
/** Category keys are schema (protected), so they pass through t() unchanged. */
const ctx_key = (k: string): string => k;

/** The mechanically-derived curated impacts (tests/unit/property-financials-curated-insights.test.ts):
 *  recomputed from the perturbed dataset wherever the real impact equalled the real recomputation. */
const DERIVED_IMPACTS: ReadonlyArray<{ id: string; f: (d: Obj) => number | null }> = [
  { id: 'EXP-07', f: (d) => leverValue(d, 'mgmtFee') },
  { id: 'EXP-08', f: (d) => pmTax(d) },
  { id: 'EXP-09', f: (d) => leverValue(d, 'grounds') },
  { id: 'EXP-10', f: (d) => leverValue(d, 'insurance') },
];
function leverValue(d: Obj, id: string): number | null {
  try {
    return computeLevers(d as never).find((l) => l.id === id)?.value.value ?? null;
  } catch {
    return null;
  }
}
function pmTax(d: Obj): number {
  let t = 0;
  for (const p of Object.values((d['properties'] as Obj | undefined) ?? {})) {
    const e = p as Obj;
    if (e['kind'] !== 'monthly') continue;
    t += num((((e['periods'] as Obj)['FY2025'] as Obj)['opex_by'] as Obj)['Real estate & property tax']) ?? 0;
  }
  return 0.05 * t;
}

/** A lease rent schedule [[start, end, monthly], ...]: the first step is a draw from the lease's SF
 *  band; every later step applies the schedule's own escalation RATE (a lease term, kept like every
 *  other rate, rounded to 0.1%) to the previous drawn step. A zero step stays zero. */
function pfSchedule(ctx: Ctx, rows: Json, key: string, sf: number | null): Json {
  if (!Array.isArray(rows)) return rows;
  let prevReal: number | null = null;
  let prevSyn: number | null = null;
  return rows.map((row, j) => {
    if (!Array.isArray(row)) return row;
    const amt = num(row[2]);
    if (amt === null) return [...row];
    let syn: number;
    if (amt === 0) syn = amt;
    else if (prevReal && prevSyn) syn = roundTo(prevSyn * (1 + Math.round((amt / prevReal - 1) * 1000) / 1000), 2);
    else syn = ctx.money(amt, `${key}/${j}`, 'monthlyRent', sf);
    prevReal = amt;
    prevSyn = syn;
    return [...row.slice(0, 2), syn, ...row.slice(3)];
  });
}

function transformDataset(ctx: Ctx, d: Obj): Obj {
  const model = new PfModel(ctx, d);
  const leaf = model.leaf;
  const out: Obj = {};
  for (const [k, v] of Object.entries(d)) {
    if (PF_ENTITY_BLOCKS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      const block: Obj = {};
      for (const [id, x] of Object.entries(v)) {
        const sid = ctx.t(id)!;
        block[sid] = walkPf(ctx, x, id, false, [k, sid], leaf);
      }
      out[k] = block;
    } else if (k !== 'insights' && k !== 'leases') {
      out[k] = walkPf(ctx, v, k, false, [k], leaf);
    }
  }
  // Insight narrative is free text (it quotes real figures and cross-entity percentages): replaced.
  out['insights'] = ((d['insights'] as Obj[] | undefined) ?? []).map((i, idx) => {
    const q = walkPf(ctx, i, 'insight', false, ['insights', String(idx)], leaf) as Obj;
    q['title'] = ctx.free('insight title', i['title']);
    q['finding'] = ctx.free('finding', i['finding']);
    q['action'] = ctx.free('action', i['action']);
    if (typeof q['annual_impact_usd'] === 'number') q['annual_impact_usd'] = Math.round(q['annual_impact_usd']);
    return q;
  });
  out['leases'] = ((d['leases'] as Obj[] | undefined) ?? []).map((l, idx) => {
    const q = walkPf(ctx, l, 'lease', false, ['leases', String(idx)], leaf) as Obj;
    if ('rent_schedule_monthly' in l) q['rent_schedule_monthly'] = pfSchedule(ctx, l['rent_schedule_monthly'] ?? null, `pf/leases/${idx}/rent`, num(l['sf']));
    q['tenant'] = ctx.a.alias('company', str(l['tenant']));
    q['source'] = `Lease -- ${String(q['property'] ?? 'property')} ${String(q['tenant'])}.pdf`;
    return q;
  });
  retainMonthlyNoiSigns(d, out);
  fixPfIdentities(d, out);
  fixPfSums(d, out);
  fixPfDetail(d, out);
  fixPortfolioViews(d, out);
  // Rent-step events carry an absolute $ threshold (RENT_STEP_RULES.minDollars): recompute them from
  // the perturbed series with the module's own detector, exactly as the dataset builder does.
  const history = (out['history'] as Obj | undefined) ?? {};
  for (const h of Object.values(history)) {
    const e = h as Obj;
    const months = e['months'] as Obj | undefined;
    if (months && Array.isArray(months['g']) && Array.isArray(months['br']) && Array.isArray(e['ev'])) {
      e['ev'] = rentStepEvents(months['g'] as string[], months['br'] as Array<number | null>) as unknown as Json;
    }
  }
  for (const { id, f } of DERIVED_IMPACTS) {
    const ri = ((d['insights'] as Obj[] | undefined) ?? []).find((x) => x['id'] === id);
    const si = (out['insights'] as Obj[]).find((x) => x['id'] === id);
    // Decided by insight id, never by comparing real values (refute round 5 F7): every curated lever
    // impact in this list is the recomputed synthetic lever.
    if (!ri || !si || typeof ri['annual_impact_usd'] !== 'number') continue;
    const sv = f(out);
    if (sv !== null) si['annual_impact_usd'] = Math.round(sv);
  }
  return out;
}

/** The property-financials reference artifact (a design reference HTML page): its embedded data
 *  block gets the same per-entity treatment as dataset.json; every other line is kept text. */
function transformArtifact(ctx: Ctx, html: string): string {
  const ENTITY = new Set(['props', 'cube', 'movers', 'sf', 'ex', 'properties', 'monthly', 'history', 'account_movers']);
  return html
    .split('\n')
    .map((line) => {
      const m = /^(<script type="application\/json" id="data">)(.*)(<\/script>\s*)$/.exec(line);
      if (!m) return ctx.t(line) ?? line;
      const d = JSON.parse(m[2]!) as Obj;
      const out: Obj = {};
      // A design reference with no consumer in code or tests: every amount is a plain banded draw
      // keyed by its location (no P&L structure needed).
      const leaf: PfLeaf = (path, field, v) => ctx.money(v, `art/${path.join('/')}`, field);
      for (const [k, v] of Object.entries(d)) {
        if (ENTITY.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
          const block: Obj = {};
          for (const [id, x] of Object.entries(v)) {
            const sid = ctx.t(id)!;
            block[sid] = walkPf(ctx, x, id, false, [k, sid], leaf);
          }
          out[k] = block;
        } else if (k === 'insights' && Array.isArray(v)) {
          out[k] = v.map((i, idx) => {
            const q = walkPf(ctx, i, 'insight', false, [k, String(idx)], leaf) as Obj;
            for (const f of ['title', 'finding', 'action']) if (typeof q[f] === 'string') q[f] = ctx.free(`artifact ${f}`, (i as Obj)[f]);
            if (typeof q['annual_impact_usd'] === 'number') q['annual_impact_usd'] = Math.round(q['annual_impact_usd']);
            return q;
          });
        } else if (k === 'leases' && Array.isArray(v)) {
          out[k] = v.map((l, idx) => {
            const q = walkPf(ctx, l, 'lease', false, [k, String(idx)], leaf) as Obj;
            if (typeof (l as Obj)['tenant'] === 'string') q['tenant'] = ctx.a.alias('company', str((l as Obj)['tenant']));
            if (typeof q['source'] === 'string') q['source'] = `Lease -- ${String(q['property'] ?? 'property')} ${String(q['tenant'] ?? '')}.pdf`;
            return q;
          });
        } else {
          out[k] = walkPf(ctx, v, k, false, [k], leaf);
        }
      }
      return `${m[1]}${JSON.stringify(out)}${m[3]}`;
    })
    .join('\n');
}

function transformAnnualCsv(ctx: Ctx, text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const header = lines[0]!;
  const cols = header.split(',');
  const amountIdx = cols.indexOf('amount_usd');
  const catIdx = cols.indexOf('category');
  const out = [header];
  lines.slice(1).forEach((line, row) => {
    if (!line) return;
    // Fields are simple (no quoted commas) in this export; assert rather than guess.
    const f = line.split(',');
    if (f.length !== cols.length || amountIdx < 0) throw new Error('annual-statements.csv: unexpected field count');
    // keyed by row; banded by the row's category (a per-SF opex band at the default SF, or generic)
    const scaled = ctx.money(Number(f[amountIdx]), `csv/annual-statements/${row}`, catIdx >= 0 ? (f[catIdx] ?? '') : '');
    f[amountIdx] = Number.isInteger(scaled) ? `${scaled}.0` : String(scaled);
    out.push(f.map((x, i) => (i === amountIdx ? x : (ctx.t(x) ?? x))).join(','));
  });
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

function walkWithUnit(
  ctx: Ctx,
  v: Json,
  key: string,
  money: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  freeKeys: ReadonlySet<string>,
  stableKeys: ReadonlySet<string> = new Set(),
  path = '',
): Json {
  const recur = (x: Json, k: string, p: string): Json => walkWithUnit(ctx, x, k, money, keep, freeKeys, stableKeys, p);
  if (Array.isArray(v)) return v.map((x, i) => recur(x, key, `${path}[${i}]`));
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
      if (k === 'value' && typeof x === 'number') out[k] = usd ? ctx.money(x, `${path}/value`, 'usd_value') : x;
      else if (k === 'value' && attr && (typeof x === 'string' || Array.isArray(x))) out[k] = textValue(x);
      else if (stableKeys.has(k) && typeof x === 'string') out[k] = ctx.stable(k, x);
      else {
        const ok = generic ? ctx.t(k)! : k;
        out[ok] = recur(x, generic ? `${key}.*` : k, `${path}/${ok}`);
      }
    }
    return out;
  }
  if (typeof v === 'number') {
    if (money.has(key)) return ctx.money(v, path, bandField(key, path));
    if (keep.has(key)) return v;
    throw new Error(`unclassified numeric key "${key}"`);
  }
  if (typeof v === 'string') return freeKeys.has(key) ? ctx.free(key, v) : ctx.t(v);
  return v;
}

/** A vendor-less stand-in ("Unidentified roofer ...", "Unknown vendor") names nobody and is what the
 *  calibration placeholder guard keys on, so it is kept verbatim. */
const PLACEHOLDER_VENDOR = /^\s*(unidentified|unknown vendor\s*$)/i;

/** Phase 1 only collects vendor names; finalizeVendors aliases them all at once. */
function registerVendors(v: Json): void {
  if (Array.isArray(v)) return v.forEach((x) => registerVendors(x));
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'consultant' || k === 'vendor') && typeof x === 'string') {
        if (!PLACEHOLDER_VENDOR.test(x)) PENDING_VENDORS.add(x.trim());
      } else registerVendors(x);
    }
  }
}

/** Words that never identify a vendor on their own (entity suffixes, trades, fillers). Narrower than
 *  GENERIC on purpose: a vendor's distinctive first word may be an ordinary English word. */
const VENDOR_STOP = new Set(
  ('the and of inc llc co corp corporation company ltd lp pllc pc group services service roofing roof construction ' +
    'contractors contracting contractor mechanical electric electrical plumbing paving engineering engineers consultants ' +
    'consulting consultant associates environmental architects architecture inspections inspection partners solutions').split(' '),
);

/** Words of descriptive "vendor" values (a document or service, not a company): never hunted. */
const DOC_WORDS = new Set(
  ('tax report reports segregation pca cost costs proposal photo photos letter project assessment assessments budget log ' +
    'advisors advisor comment comments study studies draft final quote quotes estimate estimates invoice').split(' '),
);
/** First-word short forms registered for vendor names (hunted by the output self-check). */
const VENDOR_SHORT_FORMS = new Set<string>();
/** Vendor names collected in phase 1, aliased together by finalizeVendors. */
const PENDING_VENDORS = new Set<string>();
/** Vendor identity (see vendorIdentity) -> its one alias. */
const VENDOR_FAKES = new Map<string, string>();

const ENTITY_SUFFIX = /[,.]?\s+(inc|llc|co|corp|corporation|company|ltd|lp|pllc|pc)\.?$/i;

/** One vendor however it is written: entity suffixes stripped ("Acme" and "Acme Corp" are one vendor),
 *  case and punctuation folded. */
function vendorIdentity(name: string): string {
  let s = name.trim();
  while (ENTITY_SUFFIX.test(s)) s = s.replace(ENTITY_SUFFIX, '').trim();
  return s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
}

/** The free-text forms of a vendor name: the name without its entity suffix ("Acme Roofing" for "Acme
 *  Roofing LLC") and, for a company-shaped name, its first distinctive word ("Acme"). A name written
 *  "A/B" yields each part's forms too. */
function vendorForms(name: string): string[] {
  const out: string[] = [name];
  for (const part of name.includes('/') ? [name, ...name.split('/')] : [name]) {
    const bare = part.replace(ENTITY_SUFFIX, '').trim();
    if (bare && bare !== name) out.push(bare);
    const words = bare.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'&.-]*$/.test(w));
    const first = words[0]?.replace(/[.,]+$/, '') ?? '';
    // The first word alone is a short form only for a company-shaped name (it ends in a trade or entity
    // word): "<Name> Roofing" is written "<Name>" in notes; "Real Estate Tax" is not a company.
    const last = (words[words.length - 1] ?? '').toLowerCase().replace(/[.,]+$/, '');
    const fw = first.toLowerCase();
    if (words.length > 1 && first.length >= 3 && VENDOR_STOP.has(last) && !VENDOR_STOP.has(fw) && !DOC_WORDS.has(fw)) {
      out.push(first);
      VENDOR_SHORT_FORMS.add(fw);
    }
  }
  return out;
}

/**
 * Alias every collected vendor at once, independent of the order rows arrive in (refute round 7 F3):
 * names that are one vendor (vendorIdentity) share one alias, numbered in sorted identity order; a
 * free-text form is that vendor's when only one vendor identity has it, and ambiguous (attributed to
 * neither) when two or more distinct vendors share it.
 */
function finalizeVendors(ctx: Ctx): void {
  const byId = new Map<string, string[]>();
  for (const n of PENDING_VENDORS) {
    const id = vendorIdentity(n);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(n);
    byId.set(id, list);
  }
  const owners = new Map<string, Set<string>>(); // lowercased form -> vendor identities
  const text = new Map<string, string>(); // lowercased form -> first spelling (sorted)
  for (const id of [...byId.keys()].sort()) {
    const names = byId.get(id)!.sort();
    VENDOR_FAKES.set(id, ctx.a.alias('vendor', names[0])!);
    for (const n of names)
      for (const f of vendorForms(n)) {
        const k = f.toLowerCase();
        owners.set(k, (owners.get(k) ?? new Set()).add(id));
        if (!text.has(k)) text.set(k, f);
      }
  }
  for (const k of [...owners.keys()].sort()) {
    const ids = owners.get(k)!;
    if (ids.size >= 2) ctx.a.ambiguousVendorForm(text.get(k)!);
    else ctx.a.variant(text.get(k)!, VENDOR_FAKES.get([...ids][0]!)!);
  }
  PENDING_VENDORS.clear();
}

/** The alias of a vendor / consultant name. A name not collected in phase 1 is aliased on its own. */
function registerVendorName(ctx: Ctx, name: string): string {
  const id = vendorIdentity(name);
  const known = VENDOR_FAKES.get(id);
  if (known !== undefined) return known;
  const fake = ctx.a.alias('vendor', name)!;
  if (id) VENDOR_FAKES.set(id, fake);
  for (const f of vendorForms(name)) ctx.a.variant(f, fake);
  return fake;
}

/** Every word (3+ letters, not generic) of a registered vendor / consultant name, for the self-check. */
function vendorWords(ctx: Ctx): Set<string> {
  const out = new Set<string>();
  for (const [real, [cat]] of ctx.a.registry) {
    if (cat !== 'vendor') continue;
    for (const w of real.toLowerCase().split(/[^a-z]+/)) if (w.length >= 3 && !VENDOR_STOP.has(w) && !GENERIC.has(w) && !DOC_WORDS.has(w)) out.add(w);
  }
  for (const w of VENDOR_SHORT_FORMS) out.add(w);
  return out;
}

function aliasVendors(ctx: Ctx, v: Json): Json {
  if (Array.isArray(v)) return v.map((x) => aliasVendors(ctx, x));
  if (v && typeof v === 'object') {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const vendorField = (k === 'consultant' || k === 'vendor') && typeof x === 'string';
      out[k] = vendorField ? (PLACEHOLDER_VENDOR.test(x) ? x : registerVendorName(ctx, x)) : aliasVendors(ctx, x);
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
  // Every amount is a banded draw keyed by its location (study id, class, fact index); the study
  // totals, allocation sums and QC re-sums are re-derived from the drawn classes below.
  const src = aliasVendors(ctx, d) as Obj;
  const walkCs = (v: Json, path: string): Json => walkWithUnit(ctx, v, '', COSTSEG_MONEY, COSTSEG_KEEP, set('other_sources', 'description'), set('scope'), path);
  const studyOf = (check: string): string => (/^CS-/.test(check) ? check : `CS-${check.split(/\s+/)[0]}`);
  const out: Obj = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'studies' && v && typeof v === 'object' && !Array.isArray(v)) {
      const st: Obj = {};
      for (const [id, x] of Object.entries(v)) st[id] = walkCs(x, `cs/studies/${id}`);
      out[k] = st;
    } else out[k] = walkCs(v, `cs/${k}`);
  }
  const rs = ((d as Obj)['studies'] as Obj | undefined) ?? {};
  const ss = (out['studies'] as Obj | undefined) ?? {};
  const allocSum = (x: Obj): number => Object.values((x['alloc'] as Obj | undefined) ?? {}).reduce<number>((a, v) => a + (num(v) ?? 0), 0);
  for (const [id, rv] of Object.entries(rs)) {
    const r = rv as Obj;
    const o = ss[id] as Obj | undefined;
    if (!o) continue;
    if (held(num(r['alloc_sum']), allocSum(r), 0.006)) o['alloc_sum'] = roundTo(allocSum(o), 2);
    if (held(num(r['total']), allocSum(r), 0.006)) o['total'] = roundTo(allocSum(o), 2);
  }
  const rq = (((d as Obj)['qc'] as Obj[] | undefined) ?? []);
  const sq = ((out['qc'] as Obj[] | undefined) ?? []);
  rq.forEach((r, i) => {
    const o = sq[i];
    if (!o) return;
    const id = studyOf(String(r['check'] ?? ''));
    const rStudy = rs[id] as Obj | undefined;
    const sStudy = ss[id] as Obj | undefined;
    if (!rStudy || !sStudy) return;
    if (r['check'] === id) {
      if (held(num(r['computed']), allocSum(rStudy), 0.006)) o['computed'] = roundTo(allocSum(sStudy), 2);
      if (held(num(r['expected']), num(rStudy['total']), 0.006)) o['expected'] = sStudy['total'] ?? null;
      return;
    }
    // a line-item re-sum check ("<study> 5yr detail"): pinned to the class it re-sums
    const cls = /\b(\d+yr)\b/.exec(String(r['check'] ?? ''))?.[1];
    const rClass = cls ? num(((rStudy['alloc'] as Obj | undefined) ?? {})[cls]) : null;
    const sClass = cls ? num(((sStudy['alloc'] as Obj | undefined) ?? {})[cls]) : null;
    if (sClass !== null && held(num(r['expected']), rClass, 0.006) && held(num(r['computed']), rClass, 0.006)) {
      o['expected'] = sClass;
      o['computed'] = sClass;
    }
  });
  return out;
}

const SPECS_MONEY = set('estimate_usd');
const SPECS_KEEP = set('pages_total', 'pages_without_text', 'pages_read', 'source_page', 'qty');

function transformSpecs(ctx: Ctx, d: Json, rel: string): Json {
  return walkWithUnit(ctx, aliasVendors(ctx, d), '', SPECS_MONEY, SPECS_KEEP, set('notes', 'note', 'description'), set('scope'), `specs/${rel}`);
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

function transformCalibration(ctx: Ctx, rows: Json, obsIds: Map<string, string>, rel: string): Json {
  if (!Array.isArray(rows)) return rows;
  const fix = (id: string): string => obsIds.get(id) ?? id;
  return (rows as Obj[]).map((r, i) => {
    const q = walk(ctx, aliasVendors(ctx, r), '', CAL_MONEY, CAL_KEEP, set('scope_note'), `cal/${rel}[${i}]`) as Obj;
    // unit costs: banded by the observation's unit (SF / LF / EA ...), a structural field
    const band = UNIT_COST_BANDS[String(r['unit'] ?? '')];
    if (band) {
      for (const f of ['pca_unit_cost', 'contractor_unit_cost']) {
        const v = num(r[f]);
        if (v !== null) q[f] = ctx.moneyIn(v, `cal/${rel}[${i}]/${f}`, band);
      }
    }
    q['obs_id'] = fix(String(r['obs_id']));
    if (Array.isArray(r['supersedes'])) q['supersedes'] = (r['supersedes'] as Json[]).map((x) => (typeof x === 'string' ? fix(x) : x));
    return q;
  });
}

function transformArCache(ctx: Ctx, ids: Ids, c: Obj): Obj {
  const entries: Obj = {};
  for (const [k, v] of Object.entries((c['entries'] as Obj | undefined) ?? {})) {
    entries[normKey(ctx.a.alias('arName', k)!)] = v === 'SKIP' ? 'SKIP' : (refLeaseId(ctx, ids, String(v)));
  }
  return { ...c, entries };
}

function transformReviewQueue(ctx: Ctx, ids: Ids, rows: Json): Json {
  if (!Array.isArray(rows)) return rows;
  return (rows as Obj[]).map((r, i) => {
    const q = walk(ctx, r, 'review', SNAP_MONEY, SNAP_KEEP, set('reason'), `ar-review[${i}]`) as Obj;
    if (typeof r['proposedLeaseId'] === 'string') q['proposedLeaseId'] = refLeaseId(ctx, ids, r['proposedLeaseId']);
    return q;
  });
}

// ── money classification (for tests) ────────────────────────────────────────────────────────────

/** The manifest files whose amounts the tests address: snapshot, property-financials dataset, cost seg. */
export type MoneyFileKind = 'snapshot' | 'dataset' | 'costSeg';

/**
 * Visit every number the generator treats as a real AMOUNT in one parsed real file (the same
 * classification as walk / walkPf / walkWithUnit), with its positional path (object keys by their
 * index, so a real file and its synthetic copy, whose ids are aliased, line up), and return a copy
 * with each visited number replaced by `visit`'s result. Used by the money tests: to scale a file's
 * amounts (independence test) and to pair real and synthetic amounts (attack tests).
 */
export function mapMoney(kind: MoneyFileKind, v: Json, visit: (path: string, x: number, key: string) => number): Json {
  const rec = (x: Json, key: string, path: string, inYoy: boolean): Json => {
    if (Array.isArray(x)) return x.map((y, i) => rec(y, key, `${path}[${i}]`, inYoy));
    if (x && typeof x === 'object') {
      const o = x as Obj;
      const out: Obj = {};
      const usd = typeof o['unit'] === 'string' && /usd|\$/i.test(o['unit']);
      Object.entries(o).forEach(([k, y], i) => {
        const generic = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
        const childYoy = kind === 'dataset' && (k === 'yoy' ? true : k === 'delta' || k === 'opex_by_delta' ? false : inYoy);
        const driverN = kind === 'dataset' && k === 'n' && 'p' in o && 'd' in o;
        const ck = generic ? `${key}.*` : driverN ? 'n_amount' : k;
        // cash history balances are amounts whatever the entity key looks like
        const childKey = kind === 'snapshot' && key === 'balances' ? 'balances.*' : ck;
        out[k] = rec(y, k === 'value' && kind === 'costSeg' && usd ? '__usd_value' : childKey, `${path}/${i}`, childYoy);
      });
      return out;
    }
    if (typeof x !== 'number' || !Number.isFinite(x)) return x;
    let isMoney: boolean;
    if (kind === 'snapshot') isMoney = SNAP_MONEY.has(key);
    else if (kind === 'dataset') isMoney = !(inYoy || PF_KEEP.has(key) || /(^|_)(pct|ratio|margin)$/.test(key));
    else isMoney = key === '__usd_value' || COSTSEG_MONEY.has(key);
    return isMoney ? visit(path, x, key) : x;
  };
  return rec(v, '', '', false);
}

/** Every amount of a parsed file as [positional path, value, field key]. */
export function moneyLeaves(kind: MoneyFileKind, v: Json): Array<[string, number, string]> {
  const out: Array<[string, number, string]> = [];
  mapMoney(kind, v, (p, x, k) => {
    out.push([p, x, k]);
    return x;
  });
  return out;
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

/**
 * Transform the real manifest files under `root` into their synthetic stand-ins. Returns the outputs
 * (repo-relative path -> content) without touching disk unless `write`. Exported for the money-
 * independence test, which runs it on two inputs that differ only in their amounts.
 *
 * No real amount influences any draw: every money value is draw #0 for its structural key. On `write`,
 * the outputs are first scanned for the real-amount fingerprints; a collision FAILS the build (bump
 * SYNTH_SEED in synthetic-money.ts), it is never fixed by redrawing one value (refute round 4 F3: a
 * per-value redraw revealed which draws were real amounts).
 */
export async function build(
  root: string,
  write: boolean,
): Promise<{ ctx: Ctx; outputs: string[]; contents: Map<string, string> }> {
  const manifest = loadManifest(ROOT);
  // A drawn amount must never equal a distinctive real amount (it would trip the fingerprint check).
  // module-level state: one build's vendor names, aliases and short forms never leak into the next
  VENDOR_SHORT_FORMS.clear();
  PENDING_VENDORS.clear();
  VENDOR_FAKES.clear();
  const ctx = new Ctx();
  const ids = newIds();
  const have = (rel: string): boolean => existsSync(join(root, rel));
  const outputs: Array<[string, () => string]> = [];
  const synth: { dataset?: Obj; costSeg?: Obj; observations?: Json } = {};
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
    registerVendors(d);
  }
  // Counterparties named only in free text (an inspector named in a cost-seg note) are listed in a
  // local, untracked file beside the real data (never committed: it holds real names).
  const EXTRA_NAMES = 'config/local/generator-extra-names.local.json';
  if (have(EXTRA_NAMES)) for (const n of readJson(root, EXTRA_NAMES) as string[]) PENDING_VENDORS.add(n.trim());
  finalizeVendors(ctx);
  // Tenant names that appear only in report narrative (rent-roll attributes of the PCA extractions,
  // cost-seg tenant lists): registered so they are hunted in kept text and land on the scrub list.
  const registerTenants = (v: Json): void => {
    if (Array.isArray(v)) v.forEach(registerTenants);
    else if (v && typeof v === 'object') {
      const o = v as Obj;
      const attr = typeof o['attribute'] === 'string' ? o['attribute'] : '';
      if (/^(tenant|tenants|tenant_space|tenant_roster_per_rent_roll)$/.test(attr)) {
        const vals = Array.isArray(o['value']) ? (o['value'] as Json[]) : [o['value']];
        for (const x of vals) {
          if (typeof x !== 'string') continue;
          const name = x.replace(/\s*\(.*$/, '').replace(/^[A-Z]?\d[\w-]*\s+/, '').replace(/[.,;]+$/, '').trim();
          if (name.length >= 4 && /[A-Za-z]{3}/.test(name) && !/^(vacant|available|landlord|owner|office|storage|common|n\/a|none|unknown)\b/i.test(name)) ctx.a.alias('company', name);
        }
      }
      Object.values(o).forEach(registerTenants);
    }
  };
  for (const f of [...specFiles, 'data/cost-seg/cost-seg.json'].filter(have)) registerTenants(readJson(root, f));
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
    fixSnapshotIdentities(snapshot, synthSnap, ids);
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
    synth.dataset = d;
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
  const artifactRel = 'tests/fixtures/property-financials/reference-artifact.html';
  if (have(artifactRel)) {
    const a = transformArtifact(ctx, readFileSync(join(root, artifactRel), 'utf8'));
    outputs.push([artifactRel, () => a]);
  }
  const premRel = 'scripts/data/2026-08-22-insurance-premium-history.json';
  if (have(premRel)) {
    const prem = readJson(root, premRel) as Obj;
    const policies = ((prem['policies'] as Obj[] | undefined) ?? []).map((x, i) => {
      const q = walk(ctx, x, 'premiumPolicy', set('premiumAnnual', 'coverageTiv'), set(), new Set(), `prem/policies[${i}]`) as Obj;
      q['insurer'] = ctx.a.alias('carrier', str(x['insurer']));
      q['policyNumber'] = ctx.a.alias('policy', str(x['policyNumber']));
      q['propertyId'] = x['propertyId'] ?? null;
      return q;
    });
    const p2 = { ...(walk(ctx, { ...prem, policies: [] }, 'premiumHistory', set('premiumAnnual', 'coverageTiv'), set(), new Set(), 'prem') as Obj), policies };
    outputs.push([premRel, () => json(p2)]);
  }
  // Local operator tables moved out of tracked code (config/local/, gitignored).
  const arSeedRel = 'config/local/ar-seed-mappings.json';
  if (have(arSeedRel)) {
    const t = readJson(root, arSeedRel) as Obj;
    const confirmed = ((t['confirmed'] as Obj[] | undefined) ?? []).map((c) => ({
      name: ctx.a.alias('arName', str(c['name'])),
      leaseId: refLeaseId(ctx, ids, String(c['leaseId'])),
      why: ctx.free('ar seed reason', c['why']),
    }));
    outputs.push([arSeedRel, () => json({ confirmed } as unknown as Json)]);
  }
  const docGoldenRel = 'config/local/doc-search-golden.json';
  if (have(docGoldenRel)) {
    const g = (readJson(root, docGoldenRel) as Obj[]).map((q, i) => ({
      query: `Synthetic document question ${pad(i + 1, 2)}`,
      expect: `Synthetic document ${pad(i + 1, 2)}`,
      ...(q['note'] ? { note: ctx.free('doc golden note', q['note']) } : {}),
    }));
    outputs.push([docGoldenRel, () => json(g as unknown as Json)]);
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
    synth.costSeg = c as Obj;
    outputs.push(['data/cost-seg/cost-seg.json', () => json(c)]);
  }
  for (const f of specFiles) {
    let s = transformSpecs(ctx, readJson(root, f), f);
    // resolutions.json is a hand-edited list that is usually empty ([]). An empty stand-in could be
    // byte-identical to a real file saved with a trailing newline and so read as synthetic (refute
    // round 3 F2/F6); the stand-in carries one sentinel row that matches no finding.
    if (f === 'data/building-specs/resolutions.json' && Array.isArray(s)) {
      s = [...s, { finding_id: 'SYNTHETIC-SENTINEL-NO-SUCH-FINDING', resolved_since: '2026-01-01', note: 'synthetic stand-in sentinel; matches no finding' }];
    }
    outputs.push([f, () => json(s)]);
  }
  const obsIds = new Map<string, string>();
  for (const f of calFiles) registerObsIds(ctx, readJson(root, f), obsIds);
  for (const f of calFiles) {
    const c = transformCalibration(ctx, readJson(root, f), obsIds, f);
    if (f.endsWith('/observations.json')) synth.observations = c;
    outputs.push([f, () => json(c)]);
  }
  const seedRel = 'docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json';
  if (have(seedRel)) {
    const m = walk(ctx, readJson(root, seedRel), '', set(), set('corrections_applied', 'open_rulings'));
    outputs.push([seedRel, () => json(m)]);
  }

  // The value locks (scripts/golden/compute-golden.ts): the synthetic copies are computed from the
  // synthetic data, so CI asserts exact values against them exactly as the live machine does against
  // its ratified real ones.
  // Hand-written static stand-ins (no transform of the real file): the lease-term roster and the PCA
  // overlay tables. Their committed fixtures are emitted unchanged; the real roster's tenant labels are
  // registered so the leak check hunts them in every fixture.
  // Hand-written stand-ins, emitted unchanged. The RCT stand-in's figures are invented (never derived from the real
  // table: docs/ops/rct-runtime-config.md), so there is nothing to transform.
  const STATIC_STANDINS = ['config/local/lease-term-seeds.json', 'config/local/pca-overlay.json', 'config/replacement-cost.v3.json'];
  for (const rel of STATIC_STANDINS) {
    if (!have(rel)) continue;
    const fixed = readFileSync(join(OUT_ROOT, rel), 'utf8');
    outputs.push([rel, () => fixed]);
  }
  if (have('config/local/lease-term-seeds.json')) {
    for (const t of readJson(root, 'config/local/lease-term-seeds.json') as Obj[]) ctx.a.alias('company', str(t['tenant']));
  }
  const syntheticLeaseSeeds = (JSON.parse(readFileSync(join(OUT_ROOT, 'config/local/lease-term-seeds.json'), 'utf8')) as unknown[]).map((r) =>
    LeaseTerm.parse(r),
  );
  if (synth.dataset) {
    const g = computePfGolden(synth.dataset, syntheticLeaseSeeds);
    outputs.push([GOLDEN_PF, () => json(g as unknown as Json)]);
  }
  if (synth.costSeg) {
    const g = computeCostGolden(synth.costSeg, synth.observations);
    outputs.push([GOLDEN_COST, () => json(g as unknown as Json)]);
  }
  const covered = new Set(outputs.map(([rel]) => rel));
  const missing = all.filter((f) => !covered.has(f));
  if (missing.length) throw new Error(`no transformer for manifest file(s): ${missing.join(', ')}`);

  const contents = new Map(outputs.map(([rel, content]) => [rel, content()] as [string, string]));
  if (write) {
    // Self-check: no word of a registered real vendor / consultant name may survive anywhere in the
    // synthetic output, free text included (refute round 4 F6). Fails closed; reports a count only.
    const words = vendorWords(ctx);
    words.delete('vendor');
    const wordRe = words.size ? new RegExp(`(?<![A-Za-z])(?:${[...words].map(escapeRe).join('|')})(?![A-Za-z])`, 'gi') : null;
    const survivors = wordRe ? [...contents.values()].reduce((a, c) => a + (c.match(wordRe)?.length ?? 0), 0) : 0;
    if (survivors) throw new Error(`synthetic output still carries ${survivors} word(s) of real vendor / consultant names; register the missing short forms`);
    // Fail closed BEFORE writing when any output carries a real-amount fingerprint: the outputs are
    // staged in a temp dir and scanned there. The cure is a global seed bump, never a per-value redraw.
    const stage = mkdtempSync(join(tmpdir(), 'occ-synthetic-stage-'));
    for (const [rel, content] of contents) {
      mkdirSync(dirname(join(stage, rel)), { recursive: true });
      writeFileSync(join(stage, rel), content);
    }
    const collisions = scanForNumbers([...contents.keys()].map((rel) => join(stage, rel)), realNumberFingerprints(root));
    if (collisions.length) {
      throw new Error(
        `synthetic money collides with ${collisions.length} real-amount fingerprint(s) under SYNTH_SEED '${SYNTH_SEED}'. ` +
          'Bump SYNTH_SEED (scripts/fixtures/synthetic-money.ts) and regenerate; never redraw a single value.',
      );
    }
    for (const [rel, content] of contents) {
      const abs = join(OUT_ROOT, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      console.log(`[synthetic] wrote fixtures/synthetic/${rel}`);
    }
    console.log(`[synthetic] money: seeded draws (seed ${SYNTH_SEED}), no redraws; 0 real-amount fingerprint collisions`);
  }
  return { ctx, outputs: outputs.map(([rel]) => `fixtures/synthetic/${rel}`), contents };
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
  // --dump-terms <file>: write the registered real names (term, category, synthetic replacement) as
  // JSON to a LOCAL file of the operator's choosing (never inside the checkout). For building scrub /
  // history replace-text lists; the file holds real names, so keep it out of every repo.
  const dumpAt = argv.indexOf('--dump-terms');
  if (dumpAt >= 0 && argv[dumpAt + 1]) {
    const target = resolve(argv[dumpAt + 1]!);
    if (!relative(ROOT, target).startsWith('..')) throw new Error('--dump-terms must point outside the checkout');
    writeFileSync(target, JSON.stringify([...ctx.a.registry].map(([term, [category, fake]]) => ({ term, category, fake })), null, 1));
    console.log(`[synthetic] wrote ${ctx.a.registry.size} registered terms to ${target}`);
  }
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
  // Numeric fingerprints: a distinctive real amount (6+ significant digits, not a round thousand)
  // must not appear verbatim in any scanned file.
  const realNums = realNumberFingerprints(srcRoot);
  const numHits = scanForNumbers(targets, realNums);
  console.log(`[synthetic] numeric fingerprint check: ${realNums.size} real amounts x ${targets.length} file(s) -> ${numHits.length} hit(s)`);
  for (const h of numHits) console.error(`  NUMBER ${h.file}:${h.line} (digits ${h.term.replace(/\D/g, '').length})`);
  if (hits.length) {
    // Report location and term length only — never echo the real term itself.
    for (const h of hits) console.error(`  LEAK ${h.file}:${h.line} (term length ${h.term.length})`);
  }
  if (hits.length || numHits.length) process.exit(1);
}

/** Distinctive real amounts from the real manifest files: 6+ significant digits, not a multiple of
 *  1,000, not a calendar year. */
function realNumberFingerprints(root: string): Set<string> {
  const out = new Set<string>();
  const add = (v: number, key = '*'): void => {
    if (!Number.isFinite(v) || Math.abs(v) < 1000 || Number.isInteger(v / 1000)) return;
    const str = String(Math.abs(v));
    if (/e/i.test(str) || str.replace(/\D/g, '').replace(/^0+/, '').length < 6) return;
    out.add(str);
    out.add(`${key}|${str}`);
  };
  // Kept-by-design quantities (SF, counts, pages, quantities) are not amounts.
  const KEPT = /^(sf|leased_sf|common_area_sf|qty|n|nm|n_months|index|tenants|tenantCount|pages_total|pages_without_text|pages_read|source_page|buildings)$/;
  const walkNums = (v: Json, key = '', parent: Obj | null = null): void => {
    if (Array.isArray(v)) v.forEach((x) => walkNums(x, key, parent));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkNums(x, k, v as Obj);
    else if (typeof v === 'number') {
      if (KEPT.test(key) && !(key === 'n' && parent && 'p' in parent && 'd' in parent)) return;
      if (key === 'value' && !(parent && typeof parent['unit'] === 'string' && /usd|\$/i.test(parent['unit']))) return;
      add(v, key);
    }
  };
  for (const f of realFiles(root, loadManifest(ROOT))) {
    const text = readFileSync(join(root, f), 'utf8');
    if (f.endsWith('.json')) walkNums(JSON.parse(text) as Json);
    else if (f.endsWith('.html')) {
      const data = /<script type="application\/json" id="data">(.*)<\/script>/.exec(text)?.[1];
      if (data) walkNums(JSON.parse(data) as Json);
    } else if (f.endsWith('.csv')) for (const m of text.matchAll(/,(-?\d+(?:\.\d+)?)\s*$/gm)) add(Number(m[1]));
  }
  return out;
}

/** JSON (and the artifact's embedded JSON) is compared field-aware: a hit is a real amount under the
 *  same field name, so an unrelated coincidence elsewhere is not reported. Other text: any position. */
function scanForNumbers(files: string[], nums: Set<string>): LeakHit[] {
  const hits: LeakHit[] = [];
  if (!nums.size) return hits;
  for (const f of files) {
    const abs = resolve(ROOT, f);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    const text = readFileSync(abs, 'utf8');
    const embedded = f.endsWith('.html') ? /<script type="application\/json" id="data">(.*)<\/script>/.exec(text)?.[1] : undefined;
    const jsonText = f.endsWith('.json') ? text : embedded;
    if (jsonText !== undefined) {
      let parsed: Json = null;
      try {
        parsed = JSON.parse(jsonText) as Json;
      } catch {
        parsed = null;
      }
      if (parsed !== null) {
        const walkJ = (v: Json, key: string): void => {
          if (Array.isArray(v)) v.forEach((x) => walkJ(x, key));
          else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkJ(x, k);
          else if (typeof v === 'number' && nums.has(`${key}|${String(Math.abs(v))}`)) hits.push({ file: rel, line: 0, term: String(v) });
        };
        walkJ(parsed, '');
        if (f.endsWith('.json')) continue;
      }
    }
    text
      .split('\n')
      .forEach((l, i) => {
        if (embedded !== undefined && l.includes('id="data"')) return; // checked field-aware above
        for (const m of l.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g)) if (nums.has(m[0])) hits.push({ file: rel, line: i + 1, term: m[0] });
      });
  }
  return hits;
}

/**
 * Test seam (tests/unit/synthetic-aliases.test.ts): a fresh build context that collects `vendorNames` in
 * the given order, aliases them as phase 1 does, then returns each name's field alias and each text as
 * kept free text renders it. Synthetic inputs only.
 */
export function aliasProbe(vendorNames: string[], texts: string[], other: Array<[Category, string]> = []): { fields: string[]; texts: string[] } {
  VENDOR_SHORT_FORMS.clear();
  PENDING_VENDORS.clear();
  VENDOR_FAKES.clear();
  const ctx = new Ctx();
  for (const [cat, real] of other) ctx.a.alias(cat, real);
  for (const n of vendorNames) PENDING_VENDORS.add(n.trim());
  finalizeVendors(ctx);
  return { fields: vendorNames.map((n) => registerVendorName(ctx, n)), texts: texts.map((t) => ctx.t(t)!) };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/fixtures/build-synthetic-data.ts')) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
