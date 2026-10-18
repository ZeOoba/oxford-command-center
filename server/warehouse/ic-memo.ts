// server/warehouse/ic-memo.ts
//
// Direction 2 — Investment Committee (IC) Memo HTML export.
//
// buildIcMemoHtml(portfolio) is a PURE function: PortfolioAllocation -> a single,
// self-contained HTML document in ORA house style. The browser's "Print to PDF" turns it
// into an extractable-text PDF (no rasterization) — satisfying the firm rule that exported
// PDFs carry a text layer (Microsoft Print to PDF is prohibited; this document is text +
// vector CSS, so any text-aware PDF engine preserves the layer).
//
// Scope: PORTFOLIO-LEVEL (not deal-level). It synthesizes the capital-allocation verdicts
// into an IC-ready memo:
//   1. Cover            — firm + review title + as-of + property count + hurdle rate
//   2. Executive Summary— action posture, top verdict, advisory notice
//   3. Verdict Table    — all verdicts ranked by confidence
//   4. Action Breakdown — grouped by 5-way action
//   5. Pipeline         — active acquisition pipeline candidates
//   6. Methodology      — 5-way verdict system, IRR basis, advisory-only caveat
//
// Confidentiality: a PortfolioAllocation is an ownership-financial artifact and by
// construction carries NO deal terms. The route layer runs assertNoEgressRosterMatch as
// defense-in-depth before streaming; this builder stays pure (no IO) so it remains
// trivially testable and re-usable.
import type { PortfolioAllocation, AllocationAction } from '../../src/contracts/capital';
import type { CapitalAllocationEntry } from '../../src/contracts/capital-allocation';

// ── ORA Style Guide tokens ──────────────────────────────────────────────────────────────────
const NAVY = '#1B2A4A';
const GOLD = '#C9A96E';
const PARCHMENT = '#F5F3EF';
const INK = '#2A2A2A';
const MUTED = '#6B6B6B';
const HAIRLINE = '#D9D4CC';
// Font stacks mirror the ORA guide but fall back to web-safe families so the document
// renders identically offline — no remote font fetch.
const SERIF = "'EB Garamond', Garamond, Georgia, 'Times New Roman', serif";
const SANS = "'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'IBM Plex Mono', 'Courier New', monospace";

// ── Formatting helpers (all null/NaN-safe — never emit "null", "NaN", or a 0-lie) ──────────

/** HTML-escape for any value that lands inside markup. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DASH = '—';

const ACTION_ORDER: AllocationAction[] = ['buy', 'improve', 'hold', 'refinance', 'sell'];

function int(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return Math.round(n).toString();
}

function pct0(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${Math.round(n)}%`;
}

function pct1(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(1)}%`;
}

// ── Action vocabulary (5-way) ────────────────────────────────────────────────────────────────

function actionLabel(a: AllocationAction | string): string {
  switch (a) {
    case 'buy': return 'Buy';
    case 'hold': return 'Hold';
    case 'sell': return 'Sell';
    case 'refinance': return 'Refinance';
    case 'improve': return 'Improve';
    default: return String(a);
  }
}

function actionColor(a: AllocationAction | string): string {
  switch (a) {
    case 'buy': return '#1E7A46';
    case 'improve': return '#2E8A56';
    case 'sell': return '#9A1B1B';
    case 'refinance': return '#9A6B00';
    case 'hold':
    default: return NAVY;
  }
}

// ── Filename helper ─────────────────────────────────────────────────────────────────────────

/** ORA_IC_Memo_<asOf>.html — asOf sanitized to a header/filesystem-safe token. */
export function icMemoFilename(portfolio: PortfolioAllocation): string {
  const token =
    (portfolio.asOf ?? '')
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'undated';
  return `ORA_IC_Memo_${token}.html`;
}

// ── Section renderers ───────────────────────────────────────────────────────────────────────

function renderCover(portfolio: PortfolioAllocation): string {
  const count = portfolio.verdicts.length;
  const hurdlePct = (portfolio.hurdleRatePct * 100).toFixed(1) + '%';
  return `
  <section class="ic-cover">
    <div class="ic-cover-rule"></div>
    <p class="ic-firm">Oxford Realty Advisors</p>
    <h1 class="ic-title">Capital Allocation Review</h1>
    <p class="ic-subtitle">Investment Committee Memorandum</p>
    <div class="ic-cover-rule"></div>
    <dl class="ic-cover-stats">
      <div><dt>As of</dt><dd>${esc(portfolio.asOf)}</dd></div>
      <div><dt>Properties</dt><dd>${int(count)}</dd></div>
      <div><dt>Hurdle Rate</dt><dd>${esc(hurdlePct)}</dd></div>
    </dl>
    ${portfolio.advisoryOnly ? '<p class="ic-advisory-banner">Advisory Only — hurdle rate not yet ratified by the Investment Committee. Verdicts are directional only.</p>' : ''}
    <p class="ic-confidential">Confidential — for Investment Committee use only.</p>
  </section>`;
}

function renderExecSummary(portfolio: PortfolioAllocation): string {
  const { actionCounts, advisoryOnly, verdicts } = portfolio;
  const bullets: string[] = [];

  const parts = ACTION_ORDER
    .filter((a) => (actionCounts[a] ?? 0) > 0)
    .map((a) => `<strong>${int(actionCounts[a])}</strong> ${actionLabel(a)}`);

  bullets.push(
    parts.length > 0
      ? `Portfolio posture: ${parts.join(', ')} across ${int(verdicts.length)} asset${verdicts.length !== 1 ? 's' : ''}.`
      : `No verdicts computed. Refresh the snapshot after the workbook is updated.`,
  );

  const top = verdicts.slice().sort((a, b) => b.confidence01 - a.confidence01)[0];
  if (top) {
    bullets.push(
      `Highest-confidence verdict: <strong>${esc(top.propertyName ?? top.propertyId)}</strong> — ` +
        `<strong>${actionLabel(top.action)}</strong>, confidence ${pct0(top.confidence01 * 100)}` +
        `${top.reasons.length > 0 ? `: ${esc(top.reasons[0])}` : ''}.`,
    );
  }

  const above = verdicts.filter((v) => v.returnAboveHurdle === true).length;
  const below = verdicts.filter((v) => v.returnAboveHurdle === false).length;
  if (above + below > 0) {
    bullets.push(
      `${int(above)} of ${int(above + below)} scored assets clear the ${pct1(portfolio.hurdleRatePct * 100)} hurdle rate.`,
    );
  }

  if (advisoryOnly) {
    bullets.push(
      'Advisory mode active — hurdle rate pending IC ratification. Verdicts are directional only and must not be cited as final recommendations.',
    );
  }

  return `
  <section class="ic-section">
    <h2>Executive Summary</h2>
    <ul class="ic-bullets">
      ${bullets.map((b) => `<li>${b}</li>`).join('\n      ')}
    </ul>
  </section>`;
}

function renderVerdictTable(
  portfolio: PortfolioAllocation,
  entries?: CapitalAllocationEntry[],
): string {
  if (portfolio.verdicts.length === 0) {
    return `
  <section class="ic-section">
    <h2>Verdicts</h2>
    <p class="ic-empty">No verdicts computed. Refresh the snapshot after the workbook is updated
    and the warehouse backfill has populated scores.</p>
  </section>`;
  }

  // Round 19e (adversarial refute, MEDIUM — confirmed by two independent lenses): the debt-book
  // trust disclosure this round added to AllocationVerdict (inputs.bookTrust, dataQuality) never
  // actually reached this table. `reasons[0]` is seeded from `[...ps.reasons]` — scores.ts
  // unconditionally pushes a "Health X/100 (band)" line first — so the trust line, pushed onto
  // `reasons` well after that seed, is essentially never `reasons[0]` in production. A distrusted
  // property therefore read as an ordinary one in the artifact that turns into a printed PDF.
  // A dedicated Book column reads inputs.bookTrust directly and cannot be pre-empted by ordering.
  const anyDistrusted = portfolio.verdicts.some((v) => v.inputs.bookTrust !== 'trusted');

  const rows = portfolio.verdicts
    .slice()
    .sort((a, b) => b.confidence01 - a.confidence01)
    .map((v) => {
      const name = esc(v.propertyName ?? v.propertyId);
      const reason = v.reasons[0] ? esc(v.reasons[0]) : DASH;
      const retPct = v.expectedReturnPct !== null ? pct1(v.expectedReturnPct * 100) : DASH;
      const hurdle =
        v.returnAboveHurdle === null ? DASH : v.returnAboveHurdle ? '&#10003;' : '&#10007;';
      const entry = entries?.find((e) => e.propertyId === v.propertyId);
      const leasingRiskCell = pct0(entry?.leasingRisk);
      const bookCell =
        v.inputs.bookTrust === 'trusted'
          ? DASH
          : `<span class="ic-badge" style="color:#b3261e;border-color:#b3261e">${esc(v.inputs.bookTrust)}</span>`;
      return `        <tr class="ic-row">
          <td class="ic-name">${name}</td>
          <td><span class="ic-badge" style="color:${actionColor(v.action)};border-color:${actionColor(v.action)}">${actionLabel(v.action)}</span></td>
          <td>${esc(v.riskBand)}</td>
          <td class="ic-r">${pct0(v.confidence01 * 100)}</td>
          <td class="ic-r">${retPct}</td>
          <td class="ic-r">${hurdle}</td>
          <td class="ic-r">${leasingRiskCell}</td>
          ${anyDistrusted ? `<td class="ic-r">${bookCell}</td>` : ''}
          <td class="ic-rationale">${reason}</td>
        </tr>`;
    })
    .join('\n');

  return `
  <section class="ic-section">
    <h2>Verdicts</h2>
    <table class="ic-table">
      <thead>
        <tr>
          <th>Property</th><th>Action</th><th>Risk</th>
          <th class="ic-r">Confidence</th><th class="ic-r">Expected Return</th>
          <th class="ic-r">Hurdle</th><th class="ic-r">Leasing Risk</th>
          ${anyDistrusted ? '<th class="ic-r">Book</th>' : ''}<th>Reason</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <p class="ic-note">Sorted descending by confidence. Em-dash (${DASH}) = value not available
    (never zero-substituted). &#10003; = above hurdle; &#10007; = below hurdle.${
      anyDistrusted
        ? ' Book column shows the debt-book trust level for any property NOT on a fully trusted book — "unknown" (no snapshot loaded), "refused" (last write declined, figures may be stale), or "degraded" (rows lost, DSCR/LTV withheld).'
        : ''
    }</p>
  </section>`;
}

function renderActionBreakdown(portfolio: PortfolioAllocation): string {
  const blocks = ACTION_ORDER
    .map((action) => {
      const group = portfolio.verdicts.filter((v) => v.action === action);
      if (group.length === 0) return '';
      const items = group
        .map((v) => {
          const detail = v.reasons.length > 0 ? ` — ${esc(v.reasons.join('; '))}` : '';
          const ret =
            v.expectedReturnPct !== null ? `, expected return ${pct1(v.expectedReturnPct * 100)}` : '';
          return (
            `        <li><strong>${esc(v.propertyName ?? v.propertyId)}</strong>` +
            `, confidence ${pct0(v.confidence01 * 100)}${ret}${detail}.</li>`
          );
        })
        .join('\n');
      return `
    <div class="ic-action-block">
      <h3 style="color:${actionColor(action)}">${actionLabel(action)} <span class="ic-count">(${group.length})</span></h3>
      <ul class="ic-action-list">
${items}
      </ul>
    </div>`;
    })
    .filter(Boolean)
    .join('\n');

  return `
  <section class="ic-section">
    <h2>Action Breakdown</h2>
    ${blocks || '<p class="ic-empty">No actions to report.</p>'}
  </section>`;
}

function renderPipeline(portfolio: PortfolioAllocation): string {
  if (portfolio.pipeline.length === 0) {
    return `
  <section class="ic-section">
    <h2>Acquisition Pipeline</h2>
    <p class="ic-empty">No active pipeline candidates at this time.</p>
  </section>`;
  }

  const rows = portfolio.pipeline
    .map((p) => {
      const addr = p.address ? esc(p.address) : DASH;
      const mkt = p.market ? esc(p.market) : DASH;
      const comp = p.composite !== null ? pct0(p.composite) : DASH;
      const tier = p.tier ? esc(p.tier) : DASH;
      const irr = p.leveredIrr !== null ? pct1(p.leveredIrr * 100) : DASH;
      const disc = p.basisDiscountPct !== null ? pct1(p.basisDiscountPct * 100) : DASH;
      // Refute H3: persisted verdict + BUY eligibility beside the tier — a legacy row can carry
      // tier T1 next to a governor-demoted PASS; absent buyEligible reads as Not eligible.
      const verdict = p.verdict ? esc(p.verdict) : DASH;
      const open = p.openItems ?? [];
      const eligible =
        p.buyEligible !== true
          ? 'Not eligible'
          : open.length > 0
            ? `BUY with open items: ${esc(open.join('; '))}` // refute round 2 T2 — never silent
            : 'Eligible';
      return `        <tr class="ic-row">
          <td class="ic-name">${addr}</td>
          <td>${mkt}</td>
          <td class="ic-r">${tier}</td>
          <td class="ic-r">${verdict}</td>
          <td class="ic-r">${eligible}</td>
          <td class="ic-r">${comp}</td>
          <td class="ic-r">${irr}</td>
          <td class="ic-r">${disc}</td>
        </tr>`;
    })
    .join('\n');

  return `
  <section class="ic-section">
    <h2>Acquisition Pipeline</h2>
    <table class="ic-table">
      <thead>
        <tr>
          <th>Address</th><th>Market</th><th class="ic-r">Tier</th>
          <th class="ic-r">Verdict</th><th class="ic-r">BUY</th>
          <th class="ic-r">Composite</th><th class="ic-r">Levered IRR</th><th class="ic-r">Basis Discount</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function renderMethodology(portfolio: PortfolioAllocation): string {
  const hurdlePct = (portfolio.hurdleRatePct * 100).toFixed(1) + '%';
  return `
  <section class="ic-section ic-methodology">
    <h2>Methodology</h2>
    <p>
      Each property receives a 5-way capital verdict: <strong>Buy</strong> (new acquisition),
      <strong>Improve</strong> (value-add capex / leasing push), <strong>Hold</strong> (no action),
      <strong>Refinance</strong> (debt restructure), or <strong>Sell</strong> (disposition).
      Verdicts are driven by expected unlevered IRR vs the ${esc(hurdlePct)} hurdle rate
      (${portfolio.advisoryOnly ? 'advisory only — pending IC ratification' : 'ratified by the Investment Committee'}),
      alongside debt signal, health band, attention band, and leasing forecast inputs.
    </p>
    <p>
      Confidence (0–100%) reflects data completeness: confirmed = live workbook and ledger signals;
      estimated = partial data; derived = model extrapolation. Em-dash (${DASH}) denotes
      an unavailable value — never zero-substituted.
    </p>
    <p>
      All NOI figures are <strong>workbook basis</strong> (ownership layer, from the master workbook
      snapshot). They are <strong>not</strong> comparable with ledger (warehouse) analytics
      and must never be aggregated against them without explicit basis-matching.
    </p>
    <p class="ic-note">Generated ${esc(portfolio.asOf)} from the Capital Allocation engine
    (GET /api/warehouse/capital/allocate). Confidential — Investment Committee use only.</p>
  </section>`;
}

// ── Stylesheet ──────────────────────────────────────────────────────────────────────────────

function styleBlock(): string {
  return `
  <style>
    :root {
      --navy: ${NAVY};
      --gold: ${GOLD};
      --parchment: ${PARCHMENT};
      --ink: ${INK};
      --muted: ${MUTED};
      --hairline: ${HAIRLINE};
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: ${SANS};
      color: var(--ink);
      background: var(--parchment);
      font-size: 12px;
      line-height: 1.5;
    }
    .ic-page { max-width: 1040px; margin: 0 auto; padding: 32px 36px 48px; background: #fff; }
    h1, h2, h3 { font-family: ${SERIF}; color: var(--navy); margin: 0 0 8px; }
    h2 { font-size: 18px; border-bottom: 2px solid var(--gold); padding-bottom: 6px; margin-top: 0; }
    h3 { font-size: 13px; margin-bottom: 6px; }
    .num, .ic-r, .ic-strong, .ic-badge, .ic-table td.ic-r { font-family: ${MONO}; }

    /* Cover */
    .ic-cover { text-align: center; padding: 56px 0 32px; }
    .ic-cover-rule { height: 2px; background: var(--gold); width: 160px; margin: 0 auto 20px; }
    .ic-firm { font-family: ${MONO}; letter-spacing: 0.22em; text-transform: uppercase;
      font-size: 12px; color: var(--gold); margin: 0 0 12px; }
    .ic-title { font-size: 34px; margin: 0 0 6px; color: var(--navy); }
    .ic-subtitle { font-family: ${SERIF}; font-style: italic; color: var(--muted); font-size: 16px; margin: 0 0 20px; }
    .ic-cover-stats { display: flex; justify-content: center; gap: 28px; flex-wrap: wrap;
      margin: 24px 0 16px; padding: 0; }
    .ic-cover-stats div { text-align: center; }
    .ic-cover-stats dt { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .ic-cover-stats dd { font-family: ${MONO}; font-size: 20px; color: var(--navy); margin: 4px 0 0; font-weight: 600; }
    .ic-confidential { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 28px; }
    .ic-advisory-banner { background: #FFF8E1; border: 1px solid #C9A96E; border-radius: 4px;
      padding: 8px 16px; font-size: 11px; color: #9A6B00; margin: 16px auto; max-width: 520px; }

    /* Sections */
    .ic-section { margin: 26px 0; }
    .ic-bullets { margin: 8px 0 0; padding-left: 18px; }
    .ic-bullets li { margin-bottom: 6px; }
    .ic-bullets strong { color: var(--navy); }

    /* Tables */
    .ic-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11px; }
    .ic-table thead th { background: var(--navy); color: #fff; text-align: left; padding: 6px 8px;
      font-family: ${SANS}; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    .ic-table tbody td { padding: 6px 8px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
    .ic-row:nth-child(even) td { background: var(--parchment); }
    .ic-r { text-align: right; }
    .ic-strong { font-weight: 700; color: var(--navy); }
    .ic-name { font-weight: 600; color: var(--navy); }
    .ic-rationale { color: var(--muted); max-width: 240px; }
    .ic-badge { display: inline-block; border: 1px solid; border-radius: 3px; padding: 1px 6px;
      font-size: 10px; font-weight: 600; }
    .ic-note { font-size: 10px; color: var(--muted); margin-top: 6px; }
    .ic-empty { color: var(--muted); font-style: italic; }

    /* Action breakdown */
    .ic-action-block { margin-bottom: 14px; }
    .ic-action-list { margin: 4px 0 0; padding-left: 18px; }
    .ic-action-list li { margin-bottom: 4px; }
    .ic-count { font-family: ${MONO}; font-size: 12px; color: var(--muted); }

    /* Methodology */
    .ic-methodology p { font-size: 11px; color: var(--ink); margin: 0 0 8px; }

    /* Print optimization — keep blocks intact, force section page-breaks, hide chrome */
    @page { size: letter; margin: 14mm; }
    @media print {
      body { background: #fff; }
      .ic-page { max-width: none; padding: 0; box-shadow: none; }
      .ic-section, .ic-action-block { page-break-inside: avoid; break-inside: avoid; }
      .ic-table thead { display: table-header-group; }
      .ic-row { page-break-inside: avoid; break-inside: avoid; }
      .ic-cover { page-break-after: always; break-after: page; }
      h2, h3 { page-break-after: avoid; break-after: avoid; }
    }
  </style>`;
}

// ── Document builder ────────────────────────────────────────────────────────────────────────

/**
 * Builds the complete, self-contained IC Memo HTML document from a PortfolioAllocation.
 *
 * Pure — no IO, no DB. Output is a full HTML5 document (inline ORA styles, no remote
 * dependencies) suitable for browser "Print to PDF" into an extractable-text PDF.
 *
 * @param portfolio - The PortfolioAllocation (verdicts + pipeline).
 * @param entries   - Optional CapitalAllocationEntry array (D3: joined by propertyId to
 *                    source leasingRisk for the verdict table). When omitted, the Leasing
 *                    Risk column renders em-dash for all rows (fail-open, backward-compat).
 */
export function buildIcMemoHtml(
  portfolio: PortfolioAllocation,
  entries?: CapitalAllocationEntry[],
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ORA Capital Allocation Review — ${esc(portfolio.asOf)}</title>${styleBlock()}
</head>
<body>
  <div class="ic-page">
${renderCover(portfolio)}
${renderExecSummary(portfolio)}
${renderVerdictTable(portfolio, entries)}
${renderActionBreakdown(portfolio)}
${renderPipeline(portfolio)}
${renderMethodology(portfolio)}
  </div>
</body>
</html>`;
}
