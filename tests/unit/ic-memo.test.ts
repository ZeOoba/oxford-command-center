// @vitest-environment node
//
// tests/unit/ic-memo.test.ts
//
// Direction 2 — IC Memo HTML export unit tests.
// Updated for PortfolioAllocation schema (CapitalAllocationReport removed in PR #117).
// buildIcMemoHtml(portfolio, entries?) is PURE: PortfolioAllocation → self-contained HTML doc.
// M6: entries (CapitalAllocationEntry[]) are passed as optional second arg to source leasingRisk
// for the verdict table (D3 join path — NOT through AllocationVerdict.inputs).
import { describe, expect, it } from 'vitest';
import { buildIcMemoHtml, icMemoFilename } from '../../server/warehouse/ic-memo';
import { PortfolioAllocation, AllocationVerdict } from '../../src/contracts/capital';
import type { CapitalAllocationEntry } from '../../src/contracts/capital-allocation';

// ── Fixture builders ──────────────────────────────────────────────────────────

function verdict(over: Partial<AllocationVerdict> = {}): AllocationVerdict {
  return AllocationVerdict.parse({
    propertyId: 'p-1',
    propertyName: 'Reynolds Industrial Park',
    period: '2026',
    action: 'improve',
    expectedReturnPct: 0.12,
    returnAboveHurdle: true,
    riskBand: 'moderate',
    timelineMonths: 36,
    horizonPeriods: 3,
    confidence01: 0.75,
    confidenceTier: 'estimated',
    advisoryOnly: false,
    reasons: ['Below-market in-place rents', 'Two near-term expiries'],
    inputs: {
      healthBand: 'watch',
      attentionBand: 'yellow',
      capitalAction: 'invest',
      debtSignal: 'hold',
      debtScoreBand: 'adequate',
      dscr: 1.42,
      dscrHeadroom: 0.17,
      ltv: 0.35,
      noiPerSf: 8.54,
      forecastPresent: false,
      bookTrust: 'trusted', // round 19d - fixture models a healthy book
    },
    ...over,
  });
}

function portfolio(over: Partial<PortfolioAllocation> = {}): PortfolioAllocation {
  const base = {
    asOf: '2026-06-22',
    hurdleRatePct: 0.08,
    advisoryOnly: false,
    verdicts: [
      verdict({ propertyId: 'p-1', propertyName: 'Reynolds Industrial Park', action: 'improve', confidence01: 0.75 }),
      verdict({ propertyId: 'p-2', propertyName: 'Maple Commerce Center', action: 'hold', confidence01: 0.62 }),
      verdict({ propertyId: 'p-3', propertyName: 'Westport Flex', action: 'sell', confidence01: 0.48, returnAboveHurdle: false }),
    ],
    actionCounts: { buy: 0, hold: 1, sell: 1, refinance: 0, improve: 1 },
    pipeline: [],
  };
  return PortfolioAllocation.parse({ ...base, ...over });
}

// ── Document shell ────────────────────────────────────────────────────────────

describe('buildIcMemoHtml — document shell', () => {
  it('emits a complete HTML5 document', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
    expect(html).toContain('<meta charset="utf-8"');
  });

  it('embeds the ORA palette (Navy / Gold / Parchment) inline — no external CSS', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).toContain('#1B2A4A'); // Navy
    expect(html).toContain('#C9A96E'); // Gold
    expect(html).toContain('#F5F3EF'); // Parchment
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('http://');
    expect(html).not.toMatch(/src=["']https?:/);
  });

  it('is print-optimized (page rules + page-break avoidance)', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).toContain('@media print');
    expect(html).toContain('@page');
    expect(html).toMatch(/page-break-inside\s*:\s*avoid/);
  });

  it('contains no rasterized/base64 image payloads (extractable text only)', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('<img');
  });

  it('escapes HTML-special characters in property names', () => {
    const html = buildIcMemoHtml(
      portfolio({
        verdicts: [verdict({ propertyName: 'Smith & Sons <Flex>' })],
        actionCounts: { buy: 0, hold: 0, sell: 0, refinance: 0, improve: 1 },
      }),
    );
    expect(html).toContain('Smith &amp; Sons &lt;Flex&gt;');
    expect(html).not.toContain('Smith & Sons <Flex>');
  });
});

// ── Cover + executive summary ─────────────────────────────────────────────────

describe('buildIcMemoHtml — cover & summary', () => {
  it('renders the ORA cover title and as-of date', () => {
    const html = buildIcMemoHtml(portfolio({ asOf: '2026-06-22' }));
    expect(html).toContain('Oxford Realty Advisors');
    expect(html).toContain('Capital Allocation Review');
    expect(html).toContain('2026-06-22');
  });

  it('renders property count from verdicts', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).toContain('3'); // 3 verdicts
  });

  it('renders hurdle rate on the cover', () => {
    const html = buildIcMemoHtml(portfolio({ hurdleRatePct: 0.08 }));
    expect(html).toContain('8.0%');
  });

  it('renders advisory-only banner when advisoryOnly is true', () => {
    const html = buildIcMemoHtml(portfolio({ advisoryOnly: true }));
    expect(html.toLowerCase()).toContain('advisory');
  });

  it('does not render advisory banner element when advisoryOnly is false', () => {
    const html = buildIcMemoHtml(portfolio({ advisoryOnly: false }));
    expect(html).not.toContain('class="ic-advisory-banner"');
  });
});

// ── Verdict table ─────────────────────────────────────────────────────────────

describe('buildIcMemoHtml — verdict table', () => {
  it('renders one table row per verdict', () => {
    const html = buildIcMemoHtml(portfolio());
    const bodyRows = (html.match(/<tr[^>]*class="ic-row"/g) ?? []).length;
    expect(bodyRows).toBe(3);
  });

  it('includes every property name', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).toContain('Reynolds Industrial Park');
    expect(html).toContain('Maple Commerce Center');
    expect(html).toContain('Westport Flex');
  });

  // Ruling 2026-11-13 (audit #7/#12): a verdict resting on an unratified constant (BUY floor,
  // capex proxy) is advisoryOnly even when the portfolio-level hurdle is ratified — the printed
  // memo must not present it as decision-grade.
  it('marks a per-verdict advisory row (BUY / improve) even when the portfolio is not advisory', () => {
    const html = buildIcMemoHtml(portfolio({
      advisoryOnly: false,
      verdicts: [
        verdict({ propertyId: 'pipeline:c1', propertyName: 'Fixture Pipeline Bldg', action: 'buy', advisoryOnly: true, confidence01: 0.9 }),
        verdict({ propertyId: 'p-hold', propertyName: 'Fixture Hold Bldg', action: 'hold', advisoryOnly: false, confidence01: 0.5 }),
      ],
    }));
    // slice(1): chunk 0 is everything before the first row (the exec summary names the property too).
    const rowOf = (name: string) => html.split('<tr class="ic-row">').slice(1).find((r) => r.includes(name))?.split('</tr>')[0] ?? '';
    expect(rowOf('Fixture Pipeline Bldg')).toMatch(/Advisory/);
    expect(rowOf('Fixture Hold Bldg')).not.toMatch(/Advisory/);
    // The exec-summary headline must not cite an advisory verdict as a plain recommendation.
    expect(html).toMatch(/Highest-confidence verdict: <strong>Fixture Pipeline Bldg<\/strong> — <strong>[^<]+<\/strong> \(advisory/);
  });

  it('qualifies the hurdle-clearance count and column when the projection rests on unratified assumptions (refute wf_c69b93c5-c15)', () => {
    const flag = { entity: 'p1', field: 'returnAboveHurdle', issue: 'advisory projection', severity: 'info' as const };
    const html = buildIcMemoHtml(portfolio({
      advisoryOnly: false,
      verdicts: [verdict({ propertyId: 'p1', propertyName: 'Fixture Projected Bldg', expectedReturnPct: 0.1, returnAboveHurdle: true, dataQuality: [flag] })],
    }));
    expect(html).toMatch(/clear the 8\.0% hurdle rate \(projected on unratified assumptions\)/);
    const row = html.split('<tr class="ic-row">').slice(1).find((r) => r.includes('Fixture Projected Bldg'))!.split('</tr>')[0]!;
    expect(row).toMatch(/&#10003;\*/);
  });

  it('labels pipeline BUY eligibility advisory while the composite floor is unratified (refute wf_62322d75-6f9)', () => {
    const floorFlag = { entity: 'portfolio', field: 'buyCompositeFloor', issue: 'floor unratified', severity: 'info' as const };
    const cand = { candidateId: 'c1', address: 'Fixture Cand Bldg', market: null, tier: 'T1', composite: 72, verdict: 'PURSUE', buyEligible: true,
      unleveredIrr10yr: null, basisDiscountPct: null, openItems: [] };
    const html = buildIcMemoHtml(portfolio({ advisoryOnly: false, pipeline: [cand, { ...cand, candidateId: 'c2', address: 'Fixture Cand Two', buyEligible: false }] as never, dataQuality: [floorFlag] }));
    expect(html).toMatch(/Eligible \(advisory: composite floor unratified\)/);
    expect(html).toMatch(/Not eligible \(advisory: composite floor unratified\)/);
    const plain = buildIcMemoHtml(portfolio({ advisoryOnly: false, pipeline: [cand] as never, dataQuality: [] }));
    expect(plain).not.toMatch(/composite floor unratified/);
  });

  it('explains "*" and the Advisory badge in the table legend, and claims unratified projections only when flagged (refute wf_8522c228-850)', () => {
    const flag = { entity: 'p1', field: 'returnAboveHurdle', issue: 'advisory projection', severity: 'info' as const };
    const flagged = buildIcMemoHtml(portfolio({
      advisoryOnly: false,
      verdicts: [verdict({ propertyId: 'p1', action: 'improve', advisoryOnly: true, expectedReturnPct: 0.1, returnAboveHurdle: true, dataQuality: [flag] })],
    }));
    expect(flagged).toMatch(/\* = projected on unratified assumptions/);
    expect(flagged).toMatch(/Advisory = rests on an unratified constant/);
    expect(flagged).toMatch(/the IRR projection assumptions are not/);
    const plain = buildIcMemoHtml(portfolio({ advisoryOnly: false, verdicts: [verdict({ propertyId: 'p2', expectedReturnPct: 0.1, returnAboveHurdle: true, dataQuality: [] })] }));
    expect(plain).not.toMatch(/projection assumptions are not/);
    expect(plain).not.toMatch(/\* = projected/);
  });

  it('counts advisory verdicts in the Action Breakdown group header (refute wf_62322d75-6f9)', () => {
    const html = buildIcMemoHtml(portfolio({
      advisoryOnly: false,
      verdicts: [
        verdict({ propertyId: 'a', propertyName: 'Fixture A', action: 'improve', advisoryOnly: true }),
        verdict({ propertyId: 'b', propertyName: 'Fixture B', action: 'improve', advisoryOnly: false }),
      ],
    }));
    expect(html).toMatch(/<span class="ic-count">\(2, 1 advisory\)<\/span>/);
  });

  it('keeps confidence ties in engine emission order, so the headline never changes from main (independent review 2026-11-13)', () => {
    const html = buildIcMemoHtml(portfolio({
      verdicts: [
        verdict({ propertyId: 'z-prop', propertyName: 'Fixture First Emitted', confidence01: 0.65 }),
        verdict({ propertyId: 'a-prop', propertyName: 'Fixture Second Emitted', confidence01: 0.65 }),
        verdict({ propertyId: 'pipeline:c1', propertyName: 'Fixture Pipeline', action: 'buy', advisoryOnly: true, confidence01: 0.65 }),
      ],
    }));
    expect(html).toMatch(/Highest-confidence verdict: <strong>Fixture First Emitted<\/strong>/);
    expect(html.indexOf('Fixture First Emitted')).toBeLessThan(html.indexOf('Fixture Second Emitted'));
  });

  it('renders null / unavailable diagnostic fields as an em-dash, never as "null" or NaN', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).toContain('—'); // em-dash appears in table note / methodology
    expect(html).not.toContain('>null<');
    expect(html).not.toContain('NaN');
  });
});

// ── Action breakdown ──────────────────────────────────────────────────────────

describe('buildIcMemoHtml — action breakdown', () => {
  it('renders a section per non-empty 5-way action bucket', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).toContain('Improve');
    expect(html).toContain('Hold');
    expect(html).toContain('Sell');
  });
});

// ── Advisory mode ─────────────────────────────────────────────────────────────

describe('buildIcMemoHtml — advisory mode', () => {
  it('flags advisory mode and pending ratification in exec summary', () => {
    const html = buildIcMemoHtml(portfolio({ advisoryOnly: true }));
    expect(html.toLowerCase()).toContain('advisory');
    expect(html.toLowerCase()).toContain('pending');
  });
});

// ── Graceful degradation ──────────────────────────────────────────────────────

describe('buildIcMemoHtml — graceful degradation', () => {
  it('degrades gracefully with an empty portfolio', () => {
    const html = buildIcMemoHtml(
      portfolio({
        verdicts: [],
        actionCounts: { buy: 0, hold: 0, sell: 0, refinance: 0, improve: 0 },
      }),
    );
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  it('degrades gracefully when expectedReturnPct and returnAboveHurdle are null', () => {
    const html = buildIcMemoHtml(
      portfolio({
        verdicts: [verdict({ expectedReturnPct: null, returnAboveHurdle: null })],
        actionCounts: { buy: 0, hold: 0, sell: 0, refinance: 0, improve: 1 },
      }),
    );
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('>null<');
  });
});

// ── Filename helper ───────────────────────────────────────────────────────────

describe('icMemoFilename', () => {
  it('produces ORA_IC_Memo_<asOf>.html', () => {
    expect(icMemoFilename(portfolio({ asOf: '2026-06-22' }))).toBe('ORA_IC_Memo_2026-06-22.html');
  });

  it('sanitizes a malformed asOf into a header-safe token', () => {
    const name = icMemoFilename(portfolio({ asOf: '2026/06/22 12:00' }));
    expect(name).toMatch(/^ORA_IC_Memo_[A-Za-z0-9_-]+\.html$/);
    expect(name).not.toContain('/');
    expect(name).not.toContain(' ');
  });
});

// ── M6: Leasing Risk column in verdict table ──────────────────────────────────
//
// D1: leasingRisk scale is 0–100 (integer/float). The engine computes
//     min(100, (nearTermExpiryRent/noi)*100 + atRiskCount*10).
//     pct0(35) → "35%". DO NOT divide or multiply by 100.
//
// D3: leasingRisk is sourced from CapitalAllocationEntry (join by propertyId),
//     NOT from AllocationVerdict.inputs (which has no leasingRisk field).
//     Tests pass entries as the optional second arg to buildIcMemoHtml.

/** Minimal CapitalAllocationEntry fixture — only fields needed for M6 tests. */
function makeEntry(propertyId: string, leasingRisk: number): CapitalAllocationEntry {
  return {
    propertyId,
    propertyName: null,
    market: null,
    sf: 5000,
    capitalAction: 'invest',
    priorityScore: 50,
    healthScore: null,
    attentionScore: null,
    nearTermExpiryRent: 0,
    atRiskLikelihoodCount: 0,
    debtScore: null,
    balloonMonths: null,
    dscr: null,
    rationale: [],
    noi: 100000,
    noiPerSf: 20,
    noiBasis: 'spine-a',
    leasingRisk,
    impliedCapRate: null,
    capRateGap: null,
    capRatePercentile: null,
  };
}

describe('buildIcMemoHtml — M6 Leasing Risk column', () => {
  it('M6-1: renders "Leasing Risk" column header in the verdict table (always present)', () => {
    // The header is always rendered regardless of whether entries are passed.
    const html = buildIcMemoHtml(portfolio());
    expect(html).toContain('Leasing Risk');
  });

  it('M6-2: formats leasingRisk 35 (0-100 scale) as "35%" via pct0 (D1: no divide-by-100)', () => {
    const p = portfolio({
      verdicts: [verdict({ propertyId: 'p-1' })],
      actionCounts: { buy: 0, hold: 0, sell: 0, refinance: 0, improve: 1 },
    });
    const entries = [makeEntry('p-1', 35)];
    const html = buildIcMemoHtml(p, entries);
    expect(html).toContain('35%');
    // Must NOT misinterpret as fractional (0.35 * 100 → "35%" is same string, but
    // if someone accidentally passes 0.35 the pct0 helper rounds to "0%" — guard:
    expect(html).not.toContain('>0%<'); // 35 rounds to 35, not 0
  });

  it('M6-2b: leasingRisk=0 renders "0%" (not DASH — zero is a valid score)', () => {
    const p = portfolio({
      verdicts: [verdict({ propertyId: 'p-1' })],
      actionCounts: { buy: 0, hold: 0, sell: 0, refinance: 0, improve: 1 },
    });
    const entries = [makeEntry('p-1', 0)];
    const html = buildIcMemoHtml(p, entries);
    expect(html).toContain('0%');
    // pct0(0) returns "0%", not DASH — 0 is finite
    expect(html.match(/0%/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it('M6-3: renders em-dash when no matching entry is provided (undefined leasingRisk → DASH)', () => {
    const p = portfolio({
      verdicts: [verdict({ propertyId: 'p-1' })],
      actionCounts: { buy: 0, hold: 0, sell: 0, refinance: 0, improve: 1 },
    });
    // Pass entries with a DIFFERENT propertyId — no match → entry?.leasingRisk is undefined
    const entries = [makeEntry('p-OTHER', 35)];
    const html = buildIcMemoHtml(p, entries);
    // Column header must be present
    expect(html).toContain('Leasing Risk');
    // Cell must show em-dash, never "undefined%" or "NaN%"
    expect(html).toContain('—');
    expect(html).not.toContain('undefined%');
    expect(html).not.toContain('NaN%');
  });

  it('M6-4: renders em-dash when entries arg is omitted entirely (backward-compat)', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).toContain('Leasing Risk');
    expect(html).not.toContain('undefined%');
    expect(html).not.toContain('NaN%');
  });
});

// Round 19e (adversarial refute of round 19d, MEDIUM — confirmed by two independent lenses): the
// dataQuality/bookTrust disclosure this round added to AllocationVerdict never reached this
// artifact. `reasons[0]` is seeded from PropertyScore's own reasons — a "Health X/100" line always
// wins the slot — so the trust line, pushed later, was essentially never rendered. A distrusted
// property read as an ordinary one on the artifact that becomes a printed PDF and drives capital
// decisions. Pinned here against the actual rendered HTML, not the verdict object.
describe('buildIcMemoHtml — debt-book trust disclosure', () => {
  it('a healthy portfolio (all trusted) shows no Book column at all', () => {
    const html = buildIcMemoHtml(portfolio());
    expect(html).not.toContain('>Book<');
  });

  it('a distrusted verdict renders a Book column naming the trust level, regardless of reasons[0] ordering', () => {
    const p = portfolio({
      verdicts: [
        verdict({
          propertyId: 'p-distrust',
          propertyName: 'Livingston Flex',
          // reasons[0] is an unrelated health line — the exact production shape that hid the
          // trust disclosure. It must NOT be required for the Book column to appear.
          reasons: ['Health 71.2/100 (good).', 'Debt book not trusted — DSCR/LTV withheld'],
          inputs: {
            healthBand: 'good',
            attentionBand: 'green',
            capitalAction: 'hold',
            debtSignal: 'hold',
            debtScoreBand: 'watch',
            dscr: null,
            dscrHeadroom: null,
            ltv: null,
            noiPerSf: null,
            forecastPresent: false,
            bookTrust: 'degraded',
          },
        }),
      ],
    });
    const html = buildIcMemoHtml(p);
    expect(html).toContain('>Book<');
    expect(html).toContain('degraded');
  });

  it('a mixed portfolio (one trusted, one not) still surfaces the column for everyone', () => {
    const p = portfolio({
      verdicts: [
        verdict({ propertyId: 'p-ok', propertyName: 'Healthy Property' }),
        verdict({
          propertyId: 'p-bad',
          propertyName: 'Unknown-Debt Property',
          inputs: {
            healthBand: 'good',
            attentionBand: 'green',
            capitalAction: 'hold',
            debtSignal: 'hold',
            debtScoreBand: 'adequate',
            dscr: null,
            dscrHeadroom: null,
            ltv: null,
            noiPerSf: null,
            forecastPresent: false,
            bookTrust: 'unknown',
          },
        }),
      ],
    });
    const html = buildIcMemoHtml(p);
    expect(html).toContain('>Book<');
    expect(html).toContain('unknown');
  });
});

// Refute H3: the pipeline table shows the persisted verdict and BUY eligibility next to the tier,
// so a legacy T1-tier row whose verdict was governor-demoted to PASS never reads as a buy.
describe('buildIcMemoHtml — pipeline verdict + BUY eligibility (refute H3)', () => {
  it('renders verdict and eligibility columns; a T1 row with verdict PASS reads Not eligible', () => {
    const html = buildIcMemoHtml(portfolio({
      pipeline: [
        { candidateId: 'c-ok', address: '1 Good Way', market: null, composite: 80.6, tier: 'T1', unleveredIrr10yr: 0.18, basisDiscountPct: 0.73, verdict: 'PURSUE', buyEligible: true },
        { candidateId: 'c-legacy', address: '2 Legacy Rd', market: null, composite: 92, tier: 'T1', unleveredIrr10yr: 0.18, basisDiscountPct: 0.73, verdict: 'PASS', buyEligible: false },
      ],
    }));
    expect(html).toContain('<th class="ic-r">Verdict</th>');
    expect(html).toContain('<th class="ic-r">BUY</th>');
    const legacyRow = html.slice(html.indexOf('2 Legacy Rd'), html.indexOf('</tr>', html.indexOf('2 Legacy Rd')));
    expect(legacyRow).toContain('PASS');
    expect(legacyRow).toContain('Not eligible');
    const okRow = html.slice(html.indexOf('1 Good Way'), html.indexOf('</tr>', html.indexOf('1 Good Way')));
    expect(okRow).toContain('PURSUE');
    expect(okRow).toContain('Eligible');
    expect(okRow).not.toContain('Not eligible');
  });

  it('an eligible row with open items reads "BUY with open items: ..." (refute round 2 T2)', () => {
    const html = buildIcMemoHtml(portfolio({
      pipeline: [
        { candidateId: 'c-open', address: '3 Open Ln', market: null, composite: 80.6, tier: 'T2', unleveredIrr10yr: 0.18, basisDiscountPct: 0.73, verdict: 'WATCH', buyEligible: true, openItems: ['DD-critical unresolved: roof'] },
      ],
    }));
    const row = html.slice(html.indexOf('3 Open Ln'), html.indexOf('</tr>', html.indexOf('3 Open Ln')));
    expect(row).toContain('BUY with open items: DD-critical unresolved: roof');
  });
});
