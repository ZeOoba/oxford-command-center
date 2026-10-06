// src/analytics/property-financials/normalize.ts
//
// Raw P&L records -> monthly-long rows (plan T9a, step 2). The raw shape is the parser output kept at
// OneDrive Business/Property Financials/outputs/_raw_monthly_records.json:
//   [entity, period, layout, section | null, group | null, account, amount, isTotal]
// The account -> (line_type, category) mapping is DATA — scripts/property-financials/config/
// account-mapping.v1.json — applied here by first-match keyword/regex rules, each hit recorded by rule
// id for audit. Policy, enforced rather than defaulted:
//   * a record no rule matches FAILS the run (UnmappedAccountsError with a per-account report);
//   * total / subtotal rows are skipped;
//   * an entity matching `excludedEntities` (Northwood) is dropped before classification and reported
//     as an excluded ENTITY, never as unmapped;
//   * zero-amount rows are kept (the cash-flow layouts print a full account grid every month and the
//     committed CSV carries them);
//   * `sign: -1` negates the amount; a resulting -0 is normalised to 0;
//   * rows sharing (entity, period, line_type, category, source_account) are SUMMED into one row at
//     the first occurrence's position — the same account label can sit under two statement groups
//     (Info Lane "Miscellaneous Admin Expense": G&A-recoverable + owner's) and the CSV has no group
//     column, so the committed file carries their sum. `mergedDuplicates` reports how many collapsed.
// Pure TypeScript: no fs — the CLI in scripts/property-financials/ supplies the JSON.
import { LINE_TYPES, MONTHLY_LONG_HEADER, type LineType, type MonthlyLongRow } from './aggregate';
import { pyRepr, pyRound } from './pyfloat';

// -------------------------------------------------------------------------------------------------
// Raw records
// -------------------------------------------------------------------------------------------------

export interface RawRecord {
  readonly entity: string;
  readonly period: string;
  readonly layout: string;
  readonly section: string | null;
  readonly group: string | null;
  readonly account: string;
  readonly amount: number;
  readonly isTotal: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse the `{ records: [...] }` JSON into typed records. Throws on any malformed field. */
export function parseRawRecords(json: unknown): RawRecord[] {
  if (!isRecord(json) || !Array.isArray(json.records)) throw new Error('raw records: expected an object with a `records` array');
  return json.records.map((rec, i) => {
    if (!Array.isArray(rec) || rec.length !== 8) throw new Error(`raw record ${i}: expected 8 fields [entity, period, layout, section, group, account, amount, isTotal]`);
    const [entity, period, layout, section, group, account, amount, isTotal] = rec as unknown[];
    const str = (v: unknown, name: string): string => {
      if (typeof v !== 'string' || v.length === 0) throw new Error(`raw record ${i}: ${name} must be a non-empty string`);
      return v;
    };
    const strOrNull = (v: unknown, name: string): string | null => {
      if (v === null) return null;
      if (typeof v !== 'string') throw new Error(`raw record ${i}: ${name} must be a string or null`);
      return v;
    };
    if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error(`raw record ${i}: amount must be a finite number`);
    if (isTotal !== 0 && isTotal !== 1 && isTotal !== true && isTotal !== false) throw new Error(`raw record ${i}: isTotal must be 0/1`);
    return {
      entity: str(entity, 'entity'),
      period: str(period, 'period'),
      layout: str(layout, 'layout'),
      section: strOrNull(section, 'section'),
      group: strOrNull(group, 'group'),
      account: str(account, 'account'),
      amount,
      isTotal: isTotal === 1 || isTotal === true,
    };
  });
}

// -------------------------------------------------------------------------------------------------
// Mapping config
// -------------------------------------------------------------------------------------------------

export interface MappingRuleWhen {
  readonly layout?: string;
  /** `null` matches a null section; absent matches any. */
  readonly section?: string | null;
  /** Regex (case-insensitive) on the group label; `null` matches a null group; absent matches any. */
  readonly group?: string | null;
  /** Regex (case-insensitive) on the account label; absent matches any. */
  readonly account?: string;
}

export type MappingRuleThen = { readonly line_type: LineType; readonly category: string } | { readonly exclude: string };

export interface MappingRule {
  readonly id: string;
  readonly when: MappingRuleWhen;
  readonly then: MappingRuleThen;
  readonly sign: 1 | -1;
  readonly note?: string;
}

export interface AccountMapping {
  readonly version: string;
  readonly categories: {
    readonly revenue: readonly string[];
    readonly opex: readonly string[];
    readonly below_line: Readonly<Record<Exclude<LineType, 'rev' | 'opex'>, string>>;
  };
  readonly excludedEntities: ReadonlyArray<{ readonly pattern: string; readonly reason: string }>;
  readonly rules: readonly MappingRule[];
}

const BELOW_LINE_TYPES = LINE_TYPES.filter((t): t is Exclude<LineType, 'rev' | 'opex'> => t !== 'rev' && t !== 'opex');

/** Validate the mapping JSON: ids present and unique, every mapped category declared, regexes compile. */
export function parseAccountMapping(json: unknown): AccountMapping {
  if (!isRecord(json)) throw new Error('account mapping: expected an object');
  if (typeof json.version !== 'string' || !/^v\d+$/.test(json.version)) throw new Error('account mapping: `version` must look like v1');
  const cats = json.categories;
  if (!isRecord(cats) || !Array.isArray(cats.revenue) || !Array.isArray(cats.opex) || !isRecord(cats.below_line)) {
    throw new Error('account mapping: `categories` must carry revenue[], opex[] and below_line{}');
  }
  const revenue = cats.revenue.map((c) => String(c));
  const opex = cats.opex.map((c) => String(c));
  // Keep the config's own key order: it becomes meta.categories.below_line in the dataset.
  const belowLine = {} as Record<Exclude<LineType, 'rev' | 'opex'>, string>;
  const declared = Object.keys(cats.below_line);
  if (declared.length !== BELOW_LINE_TYPES.length || BELOW_LINE_TYPES.some((t) => !declared.includes(t))) {
    throw new Error(`account mapping: categories.below_line must declare exactly [${BELOW_LINE_TYPES.join(', ')}]`);
  }
  for (const k of declared) {
    const t = k as Exclude<LineType, 'rev' | 'opex'>;
    const label = cats.below_line[t];
    if (typeof label !== 'string' || !label) throw new Error(`account mapping: categories.below_line.${t} must be a label`);
    belowLine[t] = label;
  }
  const excluded = Array.isArray(json.excludedEntities) ? json.excludedEntities : [];
  const excludedEntities = excluded.map((e, i) => {
    if (!isRecord(e) || typeof e.pattern !== 'string' || !e.pattern || typeof e.reason !== 'string') throw new Error(`account mapping: excludedEntities[${i}] needs pattern + reason`);
    new RegExp(e.pattern, 'i');
    return { pattern: e.pattern, reason: e.reason };
  });
  if (!Array.isArray(json.rules) || json.rules.length === 0) throw new Error('account mapping: `rules` must be a non-empty array');
  const seen = new Set<string>();
  const rules: MappingRule[] = json.rules.map((r, i) => {
    if (!isRecord(r)) throw new Error(`account mapping: rules[${i}] must be an object`);
    if (typeof r.id !== 'string' || !r.id) throw new Error(`account mapping: rules[${i}] has no id`);
    if (seen.has(r.id)) throw new Error(`account mapping: duplicate rule id ${r.id}`);
    seen.add(r.id);
    if (!isRecord(r.when)) throw new Error(`account mapping: rule ${r.id} has no \`when\``);
    const when: MappingRuleWhen = {};
    const w = r.when;
    if ('layout' in w) {
      if (typeof w.layout !== 'string') throw new Error(`account mapping: rule ${r.id} when.layout must be a string`);
      (when as { layout?: string }).layout = w.layout;
    }
    if ('section' in w) {
      if (w.section !== null && typeof w.section !== 'string') throw new Error(`account mapping: rule ${r.id} when.section must be a string or null`);
      (when as { section?: string | null }).section = w.section;
    }
    if ('group' in w) {
      if (w.group !== null && typeof w.group !== 'string') throw new Error(`account mapping: rule ${r.id} when.group must be a regex string or null`);
      if (typeof w.group === 'string') new RegExp(w.group, 'i');
      (when as { group?: string | null }).group = w.group;
    }
    if ('account' in w) {
      if (typeof w.account !== 'string') throw new Error(`account mapping: rule ${r.id} when.account must be a regex string`);
      new RegExp(w.account, 'i');
      (when as { account?: string }).account = w.account;
    }
    if (!isRecord(r.then)) throw new Error(`account mapping: rule ${r.id} has no \`then\``);
    let then: MappingRuleThen;
    if (typeof r.then.exclude === 'string') {
      then = { exclude: r.then.exclude };
    } else {
      const lt = r.then.line_type;
      const category = r.then.category;
      if (typeof lt !== 'string' || !(LINE_TYPES as readonly string[]).includes(lt)) throw new Error(`account mapping: rule ${r.id} then.line_type is not a known line type`);
      if (typeof category !== 'string') throw new Error(`account mapping: rule ${r.id} then.category missing`);
      const allowed = lt === 'rev' ? revenue : lt === 'opex' ? opex : [belowLine[lt as Exclude<LineType, 'rev' | 'opex'>]];
      if (!allowed.includes(category)) throw new Error(`account mapping: rule ${r.id} category "${category}" is not a declared ${lt} category`);
      then = { line_type: lt as LineType, category };
    }
    const sign = r.sign === undefined ? 1 : r.sign;
    if (sign !== 1 && sign !== -1) throw new Error(`account mapping: rule ${r.id} sign must be 1 or -1`);
    const rule: MappingRule = { id: r.id, when, then, sign };
    return typeof r.note === 'string' ? { ...rule, note: r.note } : rule;
  });
  return { version: json.version, categories: { revenue, opex, below_line: belowLine }, excludedEntities, rules };
}

// -------------------------------------------------------------------------------------------------
// Classification
// -------------------------------------------------------------------------------------------------

export type Classification =
  | { readonly kind: 'mapped'; readonly line_type: LineType; readonly category: string; readonly ruleId: string; readonly sign: 1 | -1 }
  | { readonly kind: 'excluded'; readonly ruleId: string; readonly reason: string }
  | { readonly kind: 'unmapped' };

const regexCache = new Map<string, RegExp>();
function re(pattern: string): RegExp {
  let r = regexCache.get(pattern);
  if (!r) {
    r = new RegExp(pattern, 'i');
    regexCache.set(pattern, r);
  }
  return r;
}

function ruleMatches(rule: MappingRule, rec: RawRecord): boolean {
  const w = rule.when;
  if (w.layout !== undefined && w.layout !== rec.layout) return false;
  if (w.section !== undefined && w.section !== rec.section) return false;
  if (w.group !== undefined) {
    if (w.group === null) {
      if (rec.group !== null) return false;
    } else if (rec.group === null || !re(w.group).test(rec.group)) return false;
  }
  if (w.account !== undefined && !re(w.account).test(rec.account)) return false;
  return true;
}

/** First matching rule wins. */
export function classifyRecord(rec: RawRecord, mapping: AccountMapping): Classification {
  for (const rule of mapping.rules) {
    if (!ruleMatches(rule, rec)) continue;
    if ('exclude' in rule.then) return { kind: 'excluded', ruleId: rule.id, reason: rule.then.exclude };
    return { kind: 'mapped', line_type: rule.then.line_type, category: rule.then.category, ruleId: rule.id, sign: rule.sign };
  }
  return { kind: 'unmapped' };
}

// -------------------------------------------------------------------------------------------------
// Normalisation
// -------------------------------------------------------------------------------------------------

export type EntityKind = 'monthly' | 'annual';
export type KindRegistry = Readonly<Record<string, EntityKind>>;

export interface UnmappedAccount {
  readonly entity: string;
  readonly layout: string;
  readonly section: string | null;
  readonly group: string | null;
  readonly account: string;
  readonly count: number;
  readonly amount: number;
  readonly periods: readonly string[];
}

export class UnmappedAccountsError extends Error {
  readonly report: readonly UnmappedAccount[];
  constructor(report: readonly UnmappedAccount[]) {
    const lines = report.map((u) => `  ${u.entity} | ${u.layout} | ${u.section ?? '(no section)'} | ${u.group ?? '(no group)'} | ${u.account} | ${u.count} row(s) | ${u.amount.toFixed(2)} | ${u.periods.join(',')}`);
    super(`${report.length} unmapped account(s) — add rules to account-mapping (never default):\n${lines.join('\n')}`);
    this.name = 'UnmappedAccountsError';
    this.report = report;
  }
}

export interface ExcludedEntityReport {
  readonly entity: string;
  readonly pattern: string;
  readonly reason: string;
  readonly rows: number;
}

export interface NormalizeResult {
  /** Mapped rows in INPUT order (sort with sortMonthlyLongRows). */
  readonly rows: MonthlyLongRow[];
  readonly skippedTotals: number;
  /** Raw rows folded into an earlier row with the same (entity, period, line_type, category, account). */
  readonly mergedDuplicates: number;
  readonly ruleCounts: Readonly<Record<string, number>>;
  readonly excludedByRule: Readonly<Record<string, number>>;
  readonly excludedEntities: readonly ExcludedEntityReport[];
  /** Always empty on a successful return — kept on the type so the CLI can print it from the error too. */
  readonly unmapped: Readonly<Record<string, UnmappedAccount>>;
}

/**
 * Apply the mapping to raw records. Throws UnmappedAccountsError when any non-total, non-excluded
 * record has no rule, and a plain Error when a raw entity is absent from `kinds` (an entity must be
 * declared in the registry before its rows can be placed in the CSV).
 */
export function normalizeRecords(records: readonly RawRecord[], mapping: AccountMapping, kinds: KindRegistry): NormalizeResult {
  const excludedPatterns = mapping.excludedEntities.map((e) => ({ ...e, re: re(e.pattern) }));
  const rows: MonthlyLongRow[] = [];
  const rowIndex = new Map<string, number>();
  let mergedDuplicates = 0;
  const ruleCounts: Record<string, number> = {};
  const excludedByRule: Record<string, number> = {};
  const excludedEntities = new Map<string, ExcludedEntityReport>();
  const unmapped = new Map<string, { entity: string; layout: string; section: string | null; group: string | null; account: string; count: number; amount: number; periods: Set<string> }>();
  let skippedTotals = 0;

  for (const rec of records) {
    const hit = excludedPatterns.find((p) => p.re.test(rec.entity));
    if (hit) {
      const prev = excludedEntities.get(rec.entity);
      excludedEntities.set(rec.entity, { entity: rec.entity, pattern: hit.pattern, reason: hit.reason, rows: (prev?.rows ?? 0) + 1 });
      continue;
    }
    if (rec.isTotal) {
      skippedTotals++;
      continue;
    }
    if (!(rec.entity in kinds)) throw new Error(`entity "${rec.entity}" is not in the entity registry (config/entities.json) — declare it before normalising its rows`);
    const c = classifyRecord(rec, mapping);
    if (c.kind === 'unmapped') {
      const key = [rec.entity, rec.layout, rec.section ?? '', rec.group ?? '', rec.account].join('\u0001');
      const u = unmapped.get(key) ?? { entity: rec.entity, layout: rec.layout, section: rec.section, group: rec.group, account: rec.account, count: 0, amount: 0, periods: new Set<string>() };
      u.count++;
      u.amount += rec.amount;
      u.periods.add(rec.period);
      unmapped.set(key, u);
      continue;
    }
    if (c.kind === 'excluded') {
      excludedByRule[c.ruleId] = (excludedByRule[c.ruleId] ?? 0) + 1;
      continue;
    }
    ruleCounts[c.ruleId] = (ruleCounts[c.ruleId] ?? 0) + 1;
    const signed = rec.amount * c.sign;
    const key = [rec.entity, rec.period, c.line_type, c.category, rec.account].join('\u0001');
    const at = rowIndex.get(key);
    if (at !== undefined) {
      const prev = rows[at]!;
      const sum = pyRound(prev.amount_usd + signed, 2); // cents, like the reference (55.95 + 6.99 -> 62.94)
      rows[at] = { ...prev, amount_usd: sum === 0 ? 0 : sum };
      mergedDuplicates++;
      continue;
    }
    rowIndex.set(key, rows.length);
    rows.push({
      entity: rec.entity,
      period: rec.period,
      line_type: c.line_type,
      category: c.category,
      source_account: rec.account,
      amount_usd: signed === 0 ? 0 : signed,
    });
  }

  if (unmapped.size > 0) {
    const report = [...unmapped.values()]
      .map((u) => ({ entity: u.entity, layout: u.layout, section: u.section, group: u.group, account: u.account, count: u.count, amount: u.amount, periods: [...u.periods].sort() }))
      .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity) || a.account.localeCompare(b.account));
    throw new UnmappedAccountsError(report);
  }

  return { rows, skippedTotals, mergedDuplicates, ruleCounts, excludedByRule, excludedEntities: [...excludedEntities.values()], unmapped: {} };
}

// -------------------------------------------------------------------------------------------------
// Sorting + rendering
// -------------------------------------------------------------------------------------------------

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0; // code-point order, like Python's default str sort
}

/**
 * The committed CSV order: all monthly-kind entities first, then annual-kind; within a block by
 * (entity, period, line_type, category, source_account) in code-point order; ties keep input order.
 */
export function sortMonthlyLongRows(rows: readonly MonthlyLongRow[], kinds: KindRegistry): MonthlyLongRow[] {
  const block = (r: MonthlyLongRow): number => {
    const k = kinds[r.entity];
    if (k === undefined) throw new Error(`entity "${r.entity}" is not in the entity registry`);
    return k === 'monthly' ? 0 : 1;
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort(
      (x, y) =>
        block(x.r) - block(y.r) ||
        cmpStr(x.r.entity, y.r.entity) ||
        cmpStr(x.r.period, y.r.period) ||
        cmpStr(x.r.line_type, y.r.line_type) ||
        cmpStr(x.r.category, y.r.category) ||
        cmpStr(x.r.source_account, y.r.source_account) ||
        x.i - y.i,
    )
    .map((x) => x.r);
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render rows as the committed CSV format: documented header, CRLF, Python float repr amounts. */
export function renderMonthlyLongCsv(rows: readonly MonthlyLongRow[]): string {
  const out: string[] = [MONTHLY_LONG_HEADER.join(',')];
  for (const r of rows) {
    out.push([csvField(r.entity), csvField(r.period), r.line_type, csvField(r.category), csvField(r.source_account), pyRepr(r.amount_usd)].join(','));
  }
  return `${out.join('\r\n')}\r\n`;
}
