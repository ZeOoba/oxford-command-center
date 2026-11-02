// Merge review finding (independent adversarial review of the origin/main c04bf53b merge): the
// ported extended flattener unboxes boxed primitives and writes a toJSON() result in front of an
// object's own fields, so its text was no longer a superset of main's ORIGINAL extended text, and
// the legacy text (no unboxing) was no longer what the branch tip's raw scan read. A term split
// across a Map / Error / AggregateError and a boxed or toJSON value regressed against BOTH
// parents. scanTexts now also scans main's original extended text and the unboxed legacy text.
// This file pins the reviewer's six rows at the union gates and runs a seeded regression fuzz
// against REFERENCE copies of both parents' scanners (embedded below, not imported from old files):
// anything either parent caught must be caught by the merged gate. SYNTHETIC terms only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForConfidential, type DealTerms } from '../../server/briefing/confidential';
import {
  collectText, collectTextLegacy, formsContain, normalizeForScan, scanTexts, tightForm,
} from '../../server/briefing/confidential-normalize';
import { ScanBudgetError, SCAN_VISIT_BUDGET, unboxPrimitive } from '../../server/briefing/roster-core';
import { edgeConfidentialScan } from '../../functions/api/ai';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { rosterMatch, rosterMatchWithTerms } from '../../server/briefing/roster-match';

const ROSTER: Record<string, DealTerms> = {
  hm: { label: 'HM', active: true, always: ['Heron Moor'] },
  ua: { label: 'UA', active: true, always: ['Unit AB'] },
  z: { label: 'Z', active: true, always: ['Zephyrine Holdings'] },
};

let dir: string;
const saved = process.env.CONFIDENTIAL_TERMS_PATH;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-boxed-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  if (saved === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class C {
  a: unknown;
  constructor(a: unknown) {
    this.a = a;
  }
  toJSON(): string {
    return 'q';
  }
}

/** A toJSON with a side effect: it blanks the object's own field (second review, G2). */
class D {
  a: unknown;
  constructor(a: unknown) {
    this.a = a;
  }
  toJSON(): string {
    this.a = '';
    return 'q';
  }
}
/** A Map whose default iterator yields nothing; entries() still yields the stored pairs (G1). */
class MIter extends Map<unknown, unknown> {
  override *[Symbol.iterator](): MapIterator<[unknown, unknown]> {
    /* yields nothing */
  }
}
/** A Map with no stored pairs whose entries() yields `pairs` (G1, the other direction). */
class MEntries extends Map<unknown, unknown> {
  // A private field, so the pairs are reachable ONLY through entries() (not as an own value).
  #pairs: Array<[unknown, unknown]>;
  constructor(pairs: Array<[unknown, unknown]>) {
    super();
    this.#pairs = pairs;
  }
  override entries(): MapIterator<[unknown, unknown]> {
    return this.#pairs[Symbol.iterator]() as unknown as MapIterator<[unknown, unknown]>;
  }
}
const mIter = (pairs: Array<[unknown, unknown]>): MIter => {
  const m = new MIter();
  for (const [k, v] of pairs) m.set(k, v);
  return m;
};

// ---------------------------------------------------------------------------------------------
// Reference: origin/main's recursive flatteners and scanForConfidential (c04bf53b), verbatim logic.
function mainCollectText(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  try {
    const rec = (v: unknown): string => mainCollectText(v, seen);
    let extra = '';
    if (value instanceof Date) {
      extra = Number.isNaN(value.getTime()) ? '' : value.toISOString();
    } else if (value instanceof URL) {
      const decoded = value.href.replace(/(%[0-9a-f]{2})+/gi, (m) => {
        try {
          return decodeURIComponent(m);
        } catch {
          return m;
        }
      });
      const ascii = value.href.replace(/%([0-7][0-9a-f])/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
      extra = value.href + ' ' + decoded + ' ' + ascii;
    } else if (value instanceof Error) {
      const errors = (value as { errors?: unknown }).errors;
      extra = [value.name, value.message, rec((value as { cause?: unknown }).cause), Array.isArray(errors) ? errors.map(rec).join(' ') : ''].join(' ');
    } else if (value instanceof Map) {
      extra = [...value.entries()].map(([k, v]) => rec(k) + ' ' + rec(v)).join(' ');
    } else if (value instanceof Set) {
      extra = [...value].map(rec).join(' ');
    }
    const own = Object.values(value).map(rec).join(' ');
    return extra ? extra + ' ' + own : own;
  } finally {
    seen.delete(value);
  }
}
function mainCollectTextLegacy(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  try {
    const rec = (v: unknown): string => mainCollectTextLegacy(v, seen);
    if (Array.isArray(value)) return value.map(rec).join(' ');
    return Object.values(value).map(rec).join(' ');
  } finally {
    seen.delete(value);
  }
}
function mainScan(value: unknown, terms: Record<string, DealTerms>): boolean {
  const hays = [...new Set([mainCollectTextLegacy(value), mainCollectText(value)])]
    .filter((t) => t.length > 0)
    .map((t) => normalizeForScan(t))
    .filter((h) => h.text.some((x) => x));
  if (hays.length === 0) return false;
  const found = (t: string) => hays.some((h) => formsContain(h, t));
  for (const deal of Object.values(terms)) {
    if (deal.active === false) continue;
    if ((deal.always ?? []).some((t) => t && found(t))) return true;
    const anchors = deal.context_requires_any ?? [];
    const unanchored = anchors.length > 0 && anchors.some((a) => !a || !tightForm(a));
    if (anchors.length > 0 && (unanchored || anchors.some((a) => a && found(a)))) {
      if ((deal.context ?? []).some((t) => t && found(t))) return true;
    }
  }
  return false;
}

// Reference: the branch tip 484ad726's raw scanForConfidential (lowercase substring over its
// unboxing flatten: arrays / Object.values only, a boxed primitive read as its value).
function branchCollectText(value: unknown, path: Set<object> = new Set()): string {
  const v = unboxPrimitive(value);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || typeof v !== 'object' || path.has(v)) return '';
  path.add(v);
  try {
    const children: unknown[] = Array.isArray(v) ? v : Object.values(v);
    const parts: string[] = [];
    for (let i = 0; i < children.length; i++) parts.push(branchCollectText(children[i], path));
    return parts.join(' ');
  } finally {
    path.delete(v);
  }
}
function branchRawScan(value: unknown, terms: Record<string, DealTerms>): boolean {
  const low = branchCollectText(value).toLowerCase();
  if (!low) return false;
  for (const deal of Object.values(terms)) {
    if (deal.active === false) continue;
    if ((deal.always ?? []).some((t) => t && low.includes(t.toLowerCase()))) return true;
    const anchors = (deal.context_requires_any ?? []).map((r) => r.toLowerCase());
    if (anchors.length > 0 && anchors.some((a) => low.includes(a))) {
      if ((deal.context ?? []).some((t) => t && low.includes(t.toLowerCase()))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
const withProp = <T extends object>(o: T, k: string, v: unknown): T => {
  (o as Record<string, unknown>)[k] = v;
  return o;
};

/** The reviewer's six rows: [name, value, which parent caught it]. */
const ROWS: Array<[string, () => unknown, 'main' | 'branch']> = [
  ["'Heron Moor' vs Map(['Heron', toJSON object with own 'Moor'])", () => new Map([['Heron', new C('Moor')]]), 'main'],
  ["'Heron Moor' vs Error('Heron', {cause: toJSON object})", () => new Error('Heron', { cause: new C('Moor') }), 'main'],
  ["'Heron Moor' vs AggregateError(['Heron', Number obj, 'Moor'])", () => new AggregateError(['Heron', new Number(5), 'Moor'], 'x'), 'main'],
  ["'Heron Moor' vs {e: Error('Heron', {cause: Number obj}), z: 'Moor'}", () => ({ e: new Error('Heron', { cause: new Number(7) }), z: 'Moor' }), 'main'],
  ["'Unit AB' vs ['Unit', toJSON object wrapping a String obj]", () => ['Unit', new C(new String('AB'))], 'branch'],
  ["'Unit AB' vs ['Unit', Date with own String obj]", () => ['Unit', withProp(new Date(0), 'a', new String('AB'))], 'branch'],
];

describe('review finding: boxed / toJSON values next to Map / Error / Date text', () => {
  it.each(ROWS)('premise (%s): the claimed parent caught it', (_n, make, parent) => {
    expect(parent === 'main' ? mainScan(make(), ROSTER) : branchRawScan(make(), ROSTER)).toBe(true);
  });
  it.each(ROWS)('%s: HIT at scanForConfidential, rosterMatchWithTerms and rosterMatch', (_n, make) => {
    expect(scanForConfidential(make(), ROSTER)).not.toBeNull();
    expect(rosterMatchWithTerms(make(), ROSTER)).not.toBeNull();
    expect(rosterMatch(make())).not.toBeNull();
  });
  it('scanTexts carries main\'s original extended text and the unboxed legacy text', () => {
    const texts = scanTexts(new Map([['Heron', new C('Moor')]]));
    expect(texts).toContain(mainCollectText(new Map([['Heron', new C('Moor')]])));
    const v = ['Unit', new C(new String('AB'))];
    expect(scanTexts(v)).toContain(branchCollectText(v));
  });
  // CHANGED (2026-11-02, CI determinism): "quickly" was a < 10 s wall-clock budget, which took
  // 11.6-13.9 s on the loaded self-hosted runner. It is now COUNTED: every leaf carries user code (a
  // counted valueOf on the boxed Number; a counted accessor and toJSON on the toJSON object), and
  // the total invocations per call must stay within SCAN_VISIT_BUDGET. Unbudgeted, the 2^22 copies
  // of the leaf pair across the walks would run ~29M invocations; each one is adjacent to a charged
  // visit, so a call that stops at the cap cannot exceed it. The 30 s timeout is only an outer hang
  // guard. That the four walks share the cap (rather than four caps) is pinned by L1 below.
  it('the four walks share ONE budget: a DAG carrying boxed / toJSON leaves still throws quickly', () => {
    let calls = 0;
    const n = new Number(1);
    n.valueOf = () => {
      calls++;
      return 1;
    };
    class Counted {
      constructor() {
        Object.defineProperty(this, 'a', {
          enumerable: true,
          get: () => {
            calls++;
            return 'x';
          },
        });
      }
      toJSON(): string {
        calls++;
        return 'q';
      }
    }
    let v: unknown = [n, new Counted()];
    for (let i = 0; i < 22; i++) v = [v, v];
    expect(() => scanTexts(v)).toThrow(/budget/);
    expect(() => rosterMatchWithTerms(v, ROSTER)).toThrow(/budget/);
    // CHANGED (2026-11-02, CI moved to GitHub-hosted ubuntu-latest): this test was an absolute 10s
    // wall-clock bound on the two calls above, which the slower hosted runner missed at 11.75s. That
    // bound never pinned the sharing either: at depth 22 the FIRST walk already exceeds its own cap
    // and throws, so per-walk budgets cost the same (verified by mutation). Sharing is now pinned
    // deterministically at depth 19, where each walk alone fits under the cap (a direct collectText /
    // collectTextLegacy call has its own budget and completes) but the four walks of one scanTexts
    // call together exceed it. Per-walk budgets would let scanTexts complete here.
    let w: unknown = [new Number(1), new C('x')];
    for (let i = 0; i < 19; i++) w = [w, w];
    expect(() => collectText(w)).not.toThrow();
    expect(() => collectTextLegacy(w)).not.toThrow();
    expect(() => scanTexts(w)).toThrow(/budget/);
  }, 120_000);
    for (const f of [() => scanTexts(v), () => rosterMatchWithTerms(v, ROSTER)]) {
      calls = 0;
      expect(f).toThrow(ScanBudgetError);
      expect(calls).toBeGreaterThan(0); // positive control: the walk reached the leaves
      expect(calls).toBeLessThanOrEqual(SCAN_VISIT_BUDGET);
    }
  }, 30_000);
  it('ordinary input still yields only the two original texts (the hardened walks add no text)', () => {
    const v = { a: ['x', { b: 'y' }], m: new Map([['k', 'v']]), d: new Date(0) };
    expect(scanTexts(v)).toEqual([...new Set([mainCollectTextLegacy(v), mainCollectText(v)])].filter(Boolean));
  });
});

// Second review: G1 (a Map read via entries(), as main reads it, not via its iterator) and G2 (the
// walk that reproduces main's view must run BEFORE any toJSON is called, so a side-effecting
// toJSON cannot blank what main would have read).
const ROWS2: Array<[string, () => unknown]> = [
  ['G1: Map subclass whose iterator yields nothing (entries() has the pair)', () => mIter([['Heron', 'Moor']])],
  ['G1: Map subclass whose entries() yields a pair the iterator does not', () => new MEntries([['Heron', 'Moor']])],
  ['G2: toJSON blanking its own field, as a Map value', () => new Map([['Heron', new D('Moor')]])],
  ['G2: toJSON blanking its own field, as an Error cause', () => new Error('Heron', { cause: new D('Moor') })],
  ['G2: toJSON blanking a sibling object visited later', () => {
    const sib = { a: 'Moor' };
    return new Map<unknown, unknown>([['t', { toJSON: () => { sib.a = ''; return 'q'; } }], ['Heron', sib]]);
  }],
];
describe('second review: Map entries() vs iterator, side-effecting toJSON', () => {
  it.each(ROWS2)('premise (%s): origin/main caught it', (_n, make) => {
    expect(mainScan(make(), ROSTER)).toBe(true);
  });
  it.each(ROWS2)('%s: HIT at scanForConfidential, rosterMatchWithTerms and rosterMatch', (_n, make) => {
    expect(scanForConfidential(make(), ROSTER)).not.toBeNull();
    expect(rosterMatchWithTerms(make(), ROSTER)).not.toBeNull();
    expect(rosterMatch(make())).not.toBeNull();
  });

  // ACCEPTED LIMIT (second review, G3): the merged scan reads a value's properties MORE often than
  // main did (up to four flattenings instead of two, plus roster-core's walk), so a getter whose
  // result depends on how often it is read can show different text to each. No scanner can make a
  // read-count-dependent getter safe (the egress JSON.stringify reads it yet again, with its own
  // count); pinned so the behaviour is visible, not because it is desirable.
  it('G3 accepted limit: a read-count-dependent getter is read more times than on main (pinned)', () => {
    let mainReads = 0;
    let mergedReads = 0;
    const make = (count: () => void) => {
      const o = { get x() { count(); return 'Moor'; } };
      return { a: 'Heron', o, m: new Map<unknown, unknown>([['k', [new Number(1), o]]]) };
    };
    mainScan(make(() => mainReads++), ROSTER);
    scanTexts(make(() => mergedReads++));
    // main: legacy reads o.x once (top level; legacy does not read Map entries), extended twice.
    expect(mainReads).toBe(3);
    // merged scanTexts: legacy once, main's extended view twice, the unboxed legacy walk once and
    // the hardened extended walk twice. Refute wf_fb340eb2 (P1): main's views no longer DETECT a
    // boxed primitive or a toJSON (every detection can run a Proxy trap or a getter), so both
    // hardened walks always run (it was 5 when the unboxed legacy walk was skipped for a value whose
    // legacy view met no boxed primitive). roster-core's walk at the gate reads it again on top.
    expect(mergedReads).toBe(6);
  });
});

// Final refute (wf_d48ce062-0cd). R1: the unboxing walk ran user valueOf / toString /
// Symbol.toPrimitive BEFORE the walk reproducing main's extended view, so a side-effecting boxed
// primitive could blank a Map / Set / Error / URL only that view reads. R2: the iterative extended
// walk read an object's own values BEFORE walking its Map / Set / Error children; main read them
// AFTER (it built `extra` first), so a descendant's user code that mutates the parent was missed.
const EDGE = edgeConfidentialScan({
  meta: { asOf: '2026-10-01', scenario: 'base' },
  deals: [{ id: 'd', name: 'Zephyrine Holdings', shortName: null, confidential: true }],
} as unknown as PortfolioSnapshot)!;
const R_ROWS: Array<[string, () => unknown]> = [
  ['R1: a boxed Number whose valueOf clears a Map', () => {
    const m = new Map([['k', 'Zephyrine Holdings']]);
    const n = new Number(1);
    n.valueOf = () => { m.clear(); return 1; };
    return [n, m];
  }],
  ['R1: a boxed String whose toString rewrites an Error.message', () => {
    const e = new Error('Zephyrine Holdings');
    const str = new String('x');
    str.toString = () => { e.message = 'gone'; return 'x'; };
    return [str, e];
  }],
  ['R1: Symbol.toPrimitive clearing a Set', () => {
    const st = new Set(['Zephyrine Holdings']);
    const n = new Number(2);
    (n as unknown as Record<symbol, unknown>)[Symbol.toPrimitive] = () => { st.clear(); return 2; };
    return [n, st];
  }],
  ['R1: valueOf replacing a URL whose path carries the percent-encoded name', () => {
    const holder: { u: URL } = { u: new URL('https://x.test/Zephyrine%20Holdings') };
    const n = new Number(3);
    n.valueOf = () => { holder.u = new URL('https://x.test/clean'); return 3; };
    return [n, holder];
  }],
  ['R2: a Set subclass iterator (a Map child) that writes an own field of the parent Map', () => {
    const m2 = new Map<string, unknown>() as Map<string, unknown> & { note?: string };
    m2.note = 'clean';
    class S2 extends Set<unknown> {
      override *[Symbol.iterator](): SetIterator<unknown> {
        m2.note = 'Zephyrine Holdings';
        yield 'a';
      }
    }
    m2.set('k', new S2(['a']));
    return m2;
  }],
];
describe('final refute: R1 (unboxing side effects) and R2 (own values read after children)', () => {
  it.each(R_ROWS)('premise (%s): origin/main caught it', (_n, make) => {
    expect(mainScan(make(), ROSTER)).toBe(true);
  });
  it.each(R_ROWS)('%s: HIT at scanForConfidential, rosterMatchWithTerms, rosterMatch and the edge scan', (_n, make) => {
    expect(scanForConfidential(make(), ROSTER)).not.toBeNull();
    expect(rosterMatchWithTerms(make(), ROSTER)).not.toBeNull();
    expect(rosterMatch(make())).not.toBeNull();
    expect(EDGE(make())).not.toBeNull();
  });
});

// Refute wf_fb340eb2 (P1): main's two views must run NO user code before they read an object's own
// values. The merged walks ran `instanceof` (a Proxy getPrototypeOf trap), Object.prototype.toString
// (a Symbol.toStringTag getter) and, in the extended walk, read `o.toJSON` (a get trap / accessor)
// first, so an object that mutates itself on THOSE operations showed benign text to every walk of
// the union while main (and the egress JSON.stringify) read the name. And the Error branch read
// AggregateError.errors.length before walking the cause; main read it after.
const P1_ROWS: Array<[string, () => unknown]> = [
  ['P1: Proxy whose getPrototypeOf trap blanks and whose toJSON get trap restores the name', () => {
    const t: { name: string } = { name: 'Zephyrine Holdings' };
    const p = new Proxy(t, {
      getPrototypeOf(x) {
        x.name = 'benign';
        return Object.prototype;
      },
      get(x, k, r) {
        if (k === 'toJSON') x.name = 'Zephyrine Holdings';
        return Reflect.get(x, k, r) as unknown;
      },
    });
    return { data: p };
  }],
  ['P1: object whose Symbol.toStringTag getter blanks its own field', () => ({
    data: {
      name: 'Zephyrine Holdings',
      get [Symbol.toStringTag](): string {
        this.name = 'benign';
        return 'X';
      },
    },
  })],
  ['P1: Proxy whose toJSON get trap blanks a field only main\'s extended view joins to an Error', () => {
    const t: { a: string } = { a: 'Holdings' };
    const p = new Proxy(t, {
      get(x, k, r) {
        if (k === 'toJSON') x.a = '';
        return Reflect.get(x, k, r) as unknown;
      },
    });
    return [new Error('Zephyrine'), p];
  }],
  ['P1: walking the Error cause pushes onto the live AggregateError.errors array', () => {
    const agg = new AggregateError([], 'x');
    // The cause's own getter runs when the cause is WALKED (main: rec(cause) before errors.map).
    const cause = {
      get x(): string {
        (agg.errors as unknown[]).push('Zephyrine Holdings');
        return 'c';
      },
    };
    Object.defineProperty(agg, 'cause', { value: cause });
    return agg;
  }],
];
describe('refute wf_fb340eb2 P1: main\'s views run no user code before own values (Proxy / getter)', () => {
  it.each(P1_ROWS)('premise (%s): origin/main\'s reference scanner caught it', (_n, make) => {
    expect(mainScan(make(), ROSTER)).toBe(true);
  });
  it.each(P1_ROWS)('%s: HIT at scanForConfidential, rosterMatchWithTerms, rosterMatch and the edge scan', (_n, make) => {
    expect(scanForConfidential(make(), ROSTER)).not.toBeNull();
    expect(rosterMatchWithTerms(make(), ROSTER)).not.toBeNull();
    expect(rosterMatch(make())).not.toBeNull();
    expect(EDGE(make())).not.toBeNull();
  });
  // Refute wf_373225a7 (TEST INTEGRITY): the gate rows above cannot isolate the deferred `errs` read
  // (an Error's errors array read only AFTER its cause is walked): with the read made eager again,
  // the later hardened extended walk reads the array once the cause getter has populated it, so the
  // union still hits. A gate-level difference would need a read-count-dependent getter (the accepted
  // G3 limit). So this pins the ORDER on the view itself: the walk that reproduces main's extended
  // view must yield exactly main's collectText of the value, byte for byte. The getter numbers its
  // reads (c1, c2, ...) so a LATER walk's text (which reads it again) cannot stand in for main's view.
  it('P1 (errors read after the cause): main\'s extended view is reproduced byte for byte, and the gates HIT', () => {
    const make = (): AggregateError => {
      const agg = new AggregateError(['first member'], 'x');
      let reads = 0;
      const cause = {
        get x(): string {
          reads++;
          (agg.errors as unknown[]).push(`Zephyrine Holdings ${reads}`);
          return `c${reads}`;
        },
      };
      Object.defineProperty(agg, 'cause', { value: cause });
      return agg;
    };
    const mainText = mainCollectText(make());
    expect(mainText).toContain('Zephyrine Holdings'); // premise: main read the member the cause pushed
    expect(mainScan(make(), ROSTER)).toBe(true);
    expect(scanTexts(make())).toContain(mainText);
    expect(scanForConfidential(make(), ROSTER)).not.toBeNull();
    expect(rosterMatchWithTerms(make(), ROSTER)).not.toBeNull();
    expect(rosterMatch(make())).not.toBeNull();
    expect(EDGE(make())).not.toBeNull();
  });
  it('the egress string of the first Proxy row carries the name (the differential is a real leak)', () => {
    expect(JSON.stringify(P1_ROWS[0]![1]())).toContain('Zephyrine Holdings');
  });
  it('a boxed primitive is still detected (and unboxed) by its internal slot alone', () => {
    const v = ['Unit', withProp(new Date(0), 'a', new String('AB'))];
    expect(scanTexts(v)).toContain(branchCollectText(v));
    // A wrapper moved to another prototype keeps its slot: unboxed as JSON.stringify unboxes it.
    const s = new String('Zephyrine Holdings');
    Object.setPrototypeOf(s, String.prototype);
    expect(unboxPrimitive(s)).toBe('Zephyrine Holdings');
    expect(unboxPrimitive(Object(5n))).toBe(5n);
    // A Proxy around a wrapper has no internal slot: JSON.stringify does not unbox it either.
    const px = new Proxy(new Number(7), {});
    expect(unboxPrimitive(px)).toBe(px);
  });
});

describe('L1: the scan budget is SHARED by every walk of one scanTexts call', () => {
  it('four walks that together exceed the visit cap throw, though each alone fits', () => {
    // ~0.3 x the cap per walk: one or two walks fit, four (forced by a boxed Number and a toJSON
    // object, which make both hardened walks run) do not.
    const n = Math.floor(SCAN_VISIT_BUDGET * 0.3);
    const v: unknown[] = new Array(n).fill('x');
    v.push(new Number(1), { toJSON: () => 'q' });
    expect(() => collectTextLegacy(v)).not.toThrow();
    expect(() => collectText(v)).not.toThrow();
    expect(() => scanTexts(v)).toThrow(ScanBudgetError);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Seeded regression fuzz: random splits of a roster term across random Map / Set / Error /
// AggregateError / Date / boxed / toJSON shapes. Whatever either parent caught, the merged gate
// must catch.
describe('regression fuzz vs both parents (seeded)', () => {
  it('every value origin/main or the branch tip caught is caught by the merged gate', () => {
    let seed = 20261015;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const TERMS = ['Heron Moor', 'Unit AB', 'Zephyrine Holdings'];
    const terms: Record<string, DealTerms> = Object.fromEntries(TERMS.map((t, i) => [`t${i}`, { label: `T${i}`, active: true, always: [t] }]));
    const wrapLeaf = (s: string): unknown => {
      const r = rnd();
      if (r < 0.35) return s;
      if (r < 0.5) return new String(s);
      if (r < 0.6) return new C(s);
      if (r < 0.7) return new C(new String(s));
      if (r < 0.76) return { toJSON: () => s };
      if (r < 0.84) return new D(s);
      if (r < 0.92) return withProp(new Date(0), 'n', s);
      return [s];
    };
    const wrapGroup = (kids: unknown[]): unknown => {
      const r = rnd();
      if (r < 0.2) return kids;
      if (r < 0.32) return Object.fromEntries(kids.map((k, i) => [`k${i}`, k]));
      if (r < 0.44) return new Map(kids.map((k, i) => [i % 2 ? k : `m${i}`, i % 2 ? `v${i}` : k] as [unknown, unknown]));
      if (r < 0.52) return new Map(kids.length >= 2 ? [[kids[0], kids[1]] as [unknown, unknown], ...kids.slice(2).map((k, i) => [`x${i}`, k] as [unknown, unknown])] : kids.map((k) => [k, ''] as [unknown, unknown]));
      if (r < 0.6) return new Set(kids);
      if (r < 0.7) return new Error(typeof kids[0] === 'string' ? kids[0] : 'e', { cause: kids.length > 1 ? (kids.length > 2 ? kids.slice(1) : kids[1]) : new Number(1) });
      if (r < 0.8) return new AggregateError(kids, 'agg');
      if (r < 0.88) return withProp(new Error('e'), 'n', kids);
      if (r < 0.91) return new C(kids);
      if (r < 0.93) return mIter(kids.map((k, i) => [i % 2 ? k : `m${i}`, i % 2 ? '' : k] as [unknown, unknown]));
      if (r < 0.95) return new MEntries(kids.map((k, i) => [i === 0 ? k : `e${i}`, i === 0 ? '' : k] as [unknown, unknown]));
      if (r < 0.96) {
        const sib = { a: kids };
        return { t: { toJSON: () => { sib.a = []; return 'q'; } }, sib };
      }
      if (r < 0.975) {
        // R1: a boxed Number whose valueOf blanks a Map that only main's extended view reads.
        const m = new Map(kids.map((k, i) => [`r${i}`, k] as [unknown, unknown]));
        const nb = new Number(1);
        nb.valueOf = () => { m.clear(); return 1; };
        return [nb, m];
      }
      if (r < 0.99) {
        // R2: a child's iterator writes the parent's own field after the parent was visited.
        const parent = new Map<unknown, unknown>() as Map<unknown, unknown> & { note?: unknown };
        parent.note = 'clean';
        class SW extends Set<unknown> {
          override *[Symbol.iterator](): SetIterator<unknown> {
            parent.note = kids;
            yield 'a';
          }
        }
        parent.set('k', new SW(['a']));
        return parent;
      }
      return [pick(['noise', new Number(3), null]), ...kids];
    };
    let caughtByParent = 0;
    const misses: string[] = [];
    const build = (): { term: string; v: unknown } => {
      const term = pick(TERMS);
      // Split on the space (and sometimes inside a word) into 2-3 pieces.
      const pieces = term.split(' ');
      if (rnd() < 0.3 && pieces[0]!.length > 2) {
        const p0 = pieces[0]!;
        const at = 1 + Math.floor(rnd() * (p0.length - 1));
        pieces.splice(0, 1, p0.slice(0, at), p0.slice(at));
      }
      const leaves = pieces.map(wrapLeaf);
      const v = rnd() < 0.5 ? wrapGroup(leaves) : wrapGroup([leaves[0], wrapGroup(leaves.slice(1))]);
      return { term, v };
    };
    for (let i = 0; i < 4000; i++) {
      // Every scanner gets a FRESH copy of the case (a side-effecting toJSON mutates what it visits).
      const s0 = seed;
      const fresh = () => {
        seed = s0;
        return build();
      };
      const { term, v } = fresh();
      const s1 = seed;
      const parent = mainScan(v, terms) || branchRawScan(fresh().v, terms);
      const merged = rosterMatchWithTerms(fresh().v, terms);
      seed = s1;
      if (!parent) continue;
      caughtByParent++;
      if (!merged) misses.push(`#${i} ${term}`);
    }
    expect(caughtByParent).toBeGreaterThan(500);
    expect(misses).toEqual([]);
  }, 60_000);
});
