// @vitest-environment node
//
// tests/unit/ic-memo.test.ts
//
// Direction 2 — IC Memo HTML export unit tests.
// Updated for PortfolioAllocation schema (CapitalAllocationReport removed in PR #117).
// buildIcMemoHtml(portfolio) is PURE: PortfolioAllocation → self-contained HTML doc.
import { describe, expect, it } from 'vitest';
import { buildIcMemoHtml, icMemoFilename } from '../../server/warehouse/ic-memo';
import { PortfolioAllocation, AllocationVerdict } from '../../src/contracts/capital';

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
