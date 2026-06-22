// @vitest-environment node
//
// tests/unit/ic-memo.test.ts
//
// Direction 2 — Investment Committee (IC) Memo HTML export unit tests.
// Written TDD-first: these run BEFORE server/warehouse/ic-memo.ts exists and are
// expected to FAIL until the builder is implemented.
//
// buildIcMemoHtml(report) is a PURE function: CapitalAllocationReport -> self-contained
// HTML document (ORA-styled, print-optimized, extractable text). It performs no IO and
// no DB access. The route wrapper (api.ts) handles streaming + headers and is covered by
// the existing api smoke surface; here we pin the document content + structural invariants.
import { describe, expect, it } from 'vitest';
import { buildIcMemoHtml, icMemoFilename } from '../../server/warehouse/ic-memo';
import { CapitalAllocationReport } from '../../src/contracts/capital-allocation';
import type { CapitalAllocationEntry } from '../../src/contracts/capital-allocation';

// ── Fixture builders ─────────────────────────────────────────────────────────────────────

function entry(over: Partial<CapitalAllocationEntry> = {}): CapitalAllocationEntry {
  return {
    propertyId: 'p-1',
    propertyName: 'Reynolds Industrial Park',
    market: 'Columbus, OH',
    sf: 48_000,
    capitalAction: 'invest',
    priorityScore: 72.4,
    healthScore: 64,
    attentionScore: 41,
    nearTermExpiryRent: 120_000,
    atRiskLikelihoodCount: 2,
    debtScore: 58,
    balloonMonths: 14,
    dscr: 1.42,
    rationale: ['Below-market in-place rents', 'Two near-term expiries'],
    noi: 410_000,
    noiPerSf: 8.54,
    noiBasis: 'spine-a',
    impliedCapRate: 0.082,
    capRateGap: 0.006,
    capRatePercentile: 'top',
    ...over,
  };
}

function report(over: Partial<CapitalAllocationReport> = {}): CapitalAllocationReport {
  const base: CapitalAllocationReport = {
    asOf: '2026-06-22',
    propertyCount: 3,
    entries: [
      entry({ propertyId: 'p-1', propertyName: 'Reynolds Industrial Park', capitalAction: 'invest', priorityScore: 72.4 }),
      entry({
        propertyId: 'p-2',
        propertyName: 'Maple Commerce Center',
        market: 'Kansas City, MO',
        capitalAction: 'monitor',
        priorityScore: 51.2,
        sf: 30_000,
        rationale: ['Attention elevated'],
      }),
      entry({
        propertyId: 'p-3',
        propertyName: 'Westport Flex',
        market: 'Indianapolis, IN',
        capitalAction: 'disposition-candidate',
        priorityScore: 38.0,
        sf: 22_500,
        debtScore: null,
        impliedCapRate: null,
        capRateGap: null,
        capRatePercentile: null,
        rationale: [],
      }),
    ],
    portfolioNoi: 1_240_000,
    portfolioNoBasis: 'spine-a',
    investCount: 1,
    holdCount: 0,
    monitorCount: 1,
    dispositionCount: 1,
    macro: { tenYearRate: 4.31, cpi: 3.1, source: 'fred', asOf: '2026-06-01' },
    marketBenchmarks: { available: true, source: 'seed', asOf: '2026-06-01' },
    regionalMacro: {
      asOf: '2026-05-01',
      source: 'fred',
      states: [
        { stateCode: 'OH', stateName: 'Ohio', unemploymentRate: 4.2, source: 'fred', asOf: '2026-05-01' },
        { stateCode: 'MO', stateName: 'Missouri', unemploymentRate: 3.8, source: 'fred', asOf: '2026-05-01' },
      ],
    },
    ...over,
  };
  // Self-validate the fixture against the live contract so the test can't drift from the schema.
  return CapitalAllocationReport.parse(base);
}

// ── Document shell ────────────────────────────────────────────────────────────────────────

describe('buildIcMemoHtml — document shell', () => {
  it('emits a complete HTML5 document', () => {
    const html = buildIcMemoHtml(report());
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
    const html = buildIcMemoHtml(report());
    expect(html).toContain('#1B2A4A'); // Navy
    expect(html).toContain('#C9A96E'); // Gold
    expect(html).toContain('#F5F3EF'); // Parchment
    // No remote stylesheet / script dependency (offline-safe, IC-room-safe).
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('http://');
    expect(html).not.toMatch(/src=["']https?:/);
  });

  it('is print-optimized (page rules + page-break avoidance)', () => {
    const html = buildIcMemoHtml(report());
    expect(html).toContain('@media print');
    expect(html).toContain('@page');
    expect(html).toMatch(/page-break-inside\s*:\s*avoid/);
  });

  it('contains no rasterized/base64 image payloads (extractable text only)', () => {
    const html = buildIcMemoHtml(report());
    // Per CLAUDE.md: PDFs/exports carry extractable text — no embedded raster blobs.
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('<img');
  });

  it('escapes HTML-special characters in property names', () => {
    const html = buildIcMemoHtml(
      report({
        entries: [entry({ propertyName: 'Smith & Sons <Flex>', market: 'Madison, WI' })],
        propertyCount: 1,
        investCount: 1,
        monitorCount: 0,
        dispositionCount: 0,
      }),
    );
    expect(html).toContain('Smith &amp; Sons &lt;Flex&gt;');
    // The raw unescaped form must NOT appear as live markup.
    expect(html).not.toContain('Smith & Sons <Flex>');
  });
});

// ── Cover + executive summary ───────────────────────────────────────────────────────────────

describe('buildIcMemoHtml — cover & summary', () => {
  it('renders the ORA cover title and as-of date', () => {
    const html = buildIcMemoHtml(report({ asOf: '2026-06-22' }));
    expect(html).toContain('Oxford Realty Advisors');
    expect(html).toContain('Capital Allocation Review');
    expect(html).toContain('2026-06-22');
  });

  it('summarizes portfolio size: total SF and property count', () => {
    const html = buildIcMemoHtml(report());
    // total SF = 48,000 + 30,000 + 22,500 = 100,500
    expect(html).toContain('100,500');
    expect(html).toContain('3'); // property count
  });

  it('surfaces macro context in the executive summary (10Y rate, CPI)', () => {
    const html = buildIcMemoHtml(report());
    expect(html).toContain('4.31');
    expect(html).toContain('3.1');
  });
});

// ── Priority matrix table ─────────────────────────────────────────────────────────────────

describe('buildIcMemoHtml — priority matrix', () => {
  it('renders one table row per property entry', () => {
    const html = buildIcMemoHtml(report());
    const bodyRows = (html.match(/<tr[^>]*class="ic-row"/g) ?? []).length;
    expect(bodyRows).toBe(3);
  });

  it('includes every property name and market', () => {
    const html = buildIcMemoHtml(report());
    expect(html).toContain('Reynolds Industrial Park');
    expect(html).toContain('Maple Commerce Center');
    expect(html).toContain('Westport Flex');
    expect(html).toContain('Columbus, OH');
    expect(html).toContain('Kansas City, MO');
    expect(html).toContain('Indianapolis, IN');
  });

  it('renders rounded priority scores', () => {
    const html = buildIcMemoHtml(report());
    expect(html).toContain('72'); // 72.4 -> 72
    expect(html).toContain('51'); // 51.2 -> 51
    expect(html).toContain('38'); // 38.0 -> 38
  });

  it('renders null diagnostic fields as an em-dash, never 0 or "null"', () => {
    const html = buildIcMemoHtml(report());
    expect(html).toContain('—');
    expect(html).not.toContain('>null<');
    expect(html).not.toContain('NaN');
  });
});

// ── Action breakdown ──────────────────────────────────────────────────────────────────────

describe('buildIcMemoHtml — action breakdown', () => {
  it('renders a section per non-empty action bucket', () => {
    const html = buildIcMemoHtml(report());
    expect(html).toContain('Invest');
    expect(html).toContain('Monitor');
    expect(html).toContain('Disposition');
  });
});

// ── Market context + methodology ──────────────────────────────────────────────────────────

describe('buildIcMemoHtml — context & methodology', () => {
  it('renders regional state unemployment', () => {
    const html = buildIcMemoHtml(report());
    expect(html).toContain('OH');
    expect(html).toContain('4.2');
    expect(html).toContain('MO');
    expect(html).toContain('3.8');
  });

  it('renders the methodology footnote with the priority formula and Spine A basis', () => {
    const html = buildIcMemoHtml(report());
    expect(html).toContain('Spine A');
    expect(html.toLowerCase()).toContain('priority');
    expect(html).toContain('0.35'); // health weight in the documented formula
  });

  it('degrades gracefully when regionalMacro is null', () => {
    const html = buildIcMemoHtml(report({ regionalMacro: null }));
    expect(html).toContain('Oxford Realty Advisors');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });

  it('degrades gracefully with an empty portfolio', () => {
    const html = buildIcMemoHtml(
      report({
        entries: [],
        propertyCount: 0,
        portfolioNoi: 0,
        investCount: 0,
        holdCount: 0,
        monitorCount: 0,
        dispositionCount: 0,
      }),
    );
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });
});

// ── Filename helper ───────────────────────────────────────────────────────────────────────

describe('icMemoFilename', () => {
  it('produces ORA_IC_Memo_<asOf>.html', () => {
    expect(icMemoFilename(report({ asOf: '2026-06-22' }))).toBe('ORA_IC_Memo_2026-06-22.html');
  });

  it('sanitizes a malformed asOf into a header-safe token', () => {
    const name = icMemoFilename(report({ asOf: '2026/06/22 12:00' }));
    expect(name).toMatch(/^ORA_IC_Memo_[A-Za-z0-9_-]+\.html$/);
    expect(name).not.toContain('/');
    expect(name).not.toContain(' ');
  });
});
