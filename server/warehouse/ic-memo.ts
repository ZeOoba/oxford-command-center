// server/warehouse/ic-memo.ts
//
// Direction 2 — Investment Committee (IC) Memo HTML export.
//
// buildIcMemoHtml(report) is a PURE function: CapitalAllocationReport -> a single,
// self-contained HTML document in ORA house style. The browser's "Print to PDF" turns it
// into an extractable-text PDF (no rasterization) — satisfying the firm rule that exported
// PDFs carry a text layer (Microsoft Print to PDF is prohibited; this document is text +
// vector CSS, so any text-aware PDF engine preserves the layer).
//
// Scope: PORTFOLIO-LEVEL (not deal-level). It synthesizes the existing capital-allocation
// report — health/attention, debt, leasing, and FRED/regional macro — into an IC-ready memo:
//   1. Cover            — firm + review title + as-of + portfolio size (SF / count / NOI)
//   2. Executive Summary— health posture, top actions, macro context
//   3. Priority Matrix  — all properties ranked by priorityScore
//   4. Action Breakdown — Invest / Monitor / Disposition sections
//   5. Market Context   — FRED macro + regional state unemployment
//   6. Methodology      — priority formula, Spine-A basis, diagnostic-only fields
//
// Basis discipline: every NOI/SF figure here is Spine A (ownership layer). The memo never
// mixes in Spine-B warehouse-ledger NOI — the report it consumes is already Spine-A-tagged at
// the H6 boundary. The footnote states this explicitly for the IC audience.
//
// Confidentiality: a CapitalAllocationReport is an ownership-financial artifact and by
// construction carries NO deal terms. The route layer runs assertNoConfidential as
// defense-in-depth before streaming; this builder stays pure (no IO) so it remains trivially
// testable and re-usable.
import type {
  CapitalAllocationReport,
  CapitalAllocationEntry,
} from '../../src/contracts/capital-allocation';

// ── ORA Style Guide tokens ─────────────────────────────────────────────────────────────────
const NAVY = '#1B2A4A';
const GOLD = '#C9A96E';
const PARCHMENT = '#F5F3EF';
const INK = '#2A2A2A';
const MUTED = '#6B6B6B';
const HAIRLINE = '#D9D4CC';
// Font stacks mirror the ORA guide (EB Garamond / DM Sans / IBM Plex Mono) but fall back to
// web-safe families so the document renders identically offline — no remote font fetch.
const SERIF = "'EB Garamond', Garamond, Georgia, 'Times New Roman', serif";
const SANS = "'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'IBM Plex Mono', 'Courier New', monospace";

// ── Formatting helpers (all null/NaN-safe — never emit "null", "NaN", or a 0-lie) ───────────

/** HTML-escape for any value that lands inside markup (property names, markets, rationale). */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DASH = '—';

function num0(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return Math.round(n).toLocaleString('en-US');
}

function int(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return Math.round(n).toString();
}

/** Compact USD for headline figures: $1.2M / $480K / $920. Zero renders as an em-dash. */
function usdCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function pct1(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(1)}%`;
}

/** 2-decimal percent for macro rates (matches the UI's 10Y/CPI precision). */
function pct2(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(2)}%`;
}

/** Cap rate is stored as a decimal fraction (0.082 = 8.2%). */
function capRate(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${(n * 100).toFixed(1)}%`;
}

// ── Action vocabulary ───────────────────────────────────────────────────────────────────────

type Action = CapitalAllocationEntry['capitalAction'];

function actionLabel(a: Action): string {
  switch (a) {
    case 'invest':
      return 'Invest';
    case 'hold':
      return 'Hold';
    case 'monitor':
      return 'Monitor';
    case 'disposition-candidate':
      return 'Disposition';
    default:
      return String(a);
  }
}

/** Inline badge color per action (Gold accent for Invest, neutral for Hold, amber/red otherwise). */
function actionColor(a: Action): string {
  switch (a) {
    case 'invest':
      return '#1E7A46'; // green
    case 'monitor':
      return '#9A6B00'; // amber
    case 'disposition-candidate':
      return '#9A1B1B'; // red
    case 'hold':
    default:
      return NAVY;
  }
}

// ── Filename helper ─────────────────────────────────────────────────────────────────────────

/** ORA_IC_Memo_<asOf>.html — asOf sanitized to a header/filesystem-safe token. */
export function icMemoFilename(report: CapitalAllocationReport): string {
  const token =
    (report.asOf ?? '')
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'undated';
  return `ORA_IC_Memo_${token}.html`;
}

// ── Section renderers ───────────────────────────────────────────────────────────────────────

function totalSf(report: CapitalAllocationReport): number {
  return report.entries.reduce((sum, e) => sum + (Number.isFinite(e.sf) ? e.sf : 0), 0);
}

function renderCover(report: CapitalAllocationReport): string {
  const sf = totalSf(report);
  return `
  <section class="ic-cover">
    <div class="ic-cover-rule"></div>
    <p class="ic-firm">Oxford Realty Advisors</p>
    <h1 class="ic-title">Capital Allocation Review</h1>
    <p class="ic-subtitle">Investment Committee Memorandum</p>
    <div class="ic-cover-rule"></div>
    <dl class="ic-cover-stats">
      <div><dt>As of</dt><dd>${esc(report.asOf)}</dd></div>
      <div><dt>Properties</dt><dd>${int(report.propertyCount)}</dd></div>
      <div><dt>Portfolio SF</dt><dd>${num0(sf)}</dd></div>
      <div><dt>Portfolio NOI (Spine A)</dt><dd>${usdCompact(report.portfolioNoi)}</dd></div>
    </dl>
    <p class="ic-confidential">Confidential — for Investment Committee use only.</p>
  </section>`;
}

function renderExecSummary(report: CapitalAllocationReport): string {
  const { investCount, holdCount, monitorCount, dispositionCount, macro, regionalMacro } = report;
  const top = report.entries[0];
  const bullets: string[] = [];

  bullets.push(
    `Portfolio posture: <strong>${int(investCount)}</strong> Invest, ` +
      `<strong>${int(holdCount)}</strong> Hold, ` +
      `<strong>${int(monitorCount)}</strong> Monitor, ` +
      `<strong>${int(dispositionCount)}</strong> Disposition across ` +
      `${int(report.propertyCount)} assets (${num0(totalSf(report))} SF).`,
  );

  if (top) {
    bullets.push(
      `Highest-priority asset: <strong>${esc(top.propertyName ?? top.propertyId)}</strong>` +
        `${top.market ? ` (${esc(top.market)})` : ''} — ` +
        `priority ${int(top.priorityScore)}, action <strong>${actionLabel(top.capitalAction)}</strong>` +
        `${top.rationale.length > 0 ? `: ${esc(top.rationale[0])}` : ''}.`,
    );
  }

  if (dispositionCount > 0) {
    bullets.push(
      `<strong>${int(dispositionCount)}</strong> disposition candidate(s) flagged for exit review.`,
    );
  }
  if (monitorCount > 0) {
    bullets.push(`<strong>${int(monitorCount)}</strong> asset(s) on the Monitor watch list.`);
  }

  const macroParts: string[] = [];
  if (macro.tenYearRate !== null) macroParts.push(`10Y Treasury ${pct2(macro.tenYearRate)}`);
  if (macro.cpi !== null) macroParts.push(`CPI ${pct1(macro.cpi)}`);
  if (macroParts.length > 0) {
    const prov = macro.source === 'fred' ? 'FRED' : 'seeded fallback';
    bullets.push(
      `Macro context: ${macroParts.join(', ')} (${prov}${macro.asOf ? `, as of ${esc(macro.asOf)}` : ''}).`,
    );
  }

  if (regionalMacro && regionalMacro.states.length > 0) {
    const tight = regionalMacro.states
      .filter((s) => s.unemploymentRate !== null)
      .map((s) => `${esc(s.stateCode)} ${pct1(s.unemploymentRate)}`)
      .join(', ');
    if (tight) {
      bullets.push(`Regional labor (unemployment): ${tight}.`);
    }
  }

  return `
  <section class="ic-section">
    <h2>Executive Summary</h2>
    <ul class="ic-bullets">
      ${bullets.map((b) => `<li>${b}</li>`).join('\n      ')}
    </ul>
  </section>`;
}

function renderPriorityMatrix(report: CapitalAllocationReport): string {
  if (report.entries.length === 0) {
    return `
  <section class="ic-section">
    <h2>Priority Matrix</h2>
    <p class="ic-empty">No properties scored. Refresh the snapshot after the workbook is updated
    and the warehouse backfill has populated health/attention scores.</p>
  </section>`;
  }

  const rows = report.entries
    .map((e) => {
      const name = esc(e.propertyName ?? e.propertyId);
      const rationale = e.rationale.length > 0 ? esc(e.rationale[0]) : DASH;
      return `        <tr class="ic-row">
          <td class="ic-name">${name}</td>
          <td>${e.market ? esc(e.market) : DASH}</td>
          <td class="ic-r">${num0(e.sf)}</td>
          <td><span class="ic-badge" style="color:${actionColor(e.capitalAction)};border-color:${actionColor(e.capitalAction)}">${actionLabel(e.capitalAction)}</span></td>
          <td class="ic-r ic-strong">${int(e.priorityScore)}</td>
          <td class="ic-r">${int(e.healthScore)}</td>
          <td class="ic-r">${e.nearTermExpiryRent > 0 ? usdCompact(e.nearTermExpiryRent) : DASH}</td>
          <td class="ic-r">${int(e.debtScore)}</td>
          <td class="ic-r">${capRate(e.impliedCapRate)}</td>
          <td class="ic-rationale">${rationale}</td>
        </tr>`;
    })
    .join('\n');

  return `
  <section class="ic-section">
    <h2>Priority Matrix</h2>
    <table class="ic-table">
      <thead>
        <tr>
          <th>Property</th><th>Market</th><th class="ic-r">SF</th><th>Action</th>
          <th class="ic-r">Priority</th><th class="ic-r">Health</th>
          <th class="ic-r">Leasing Risk</th><th class="ic-r">Debt</th>
          <th class="ic-r">Implied Cap</th><th>Rationale</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <p class="ic-note">Ranked descending by priority score. Em-dash (${DASH}) = no value /
    diagnostic unavailable (never zero-substituted).</p>
  </section>`;
}

function renderActionBreakdown(report: CapitalAllocationReport): string {
  const order: Action[] = ['invest', 'hold', 'monitor', 'disposition-candidate'];
  const blocks = order
    .map((action) => {
      const group = report.entries.filter((e) => e.capitalAction === action);
      if (group.length === 0) return '';
      const items = group
        .map((e) => {
          const detail =
            e.rationale.length > 0 ? ` — ${esc(e.rationale.join('; '))}` : '';
          return `        <li><strong>${esc(e.propertyName ?? e.propertyId)}</strong>` +
            `${e.market ? ` (${esc(e.market)})` : ''}, ${num0(e.sf)} SF, ` +
            `priority ${int(e.priorityScore)}${detail}.</li>`;
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

function renderMarketContext(report: CapitalAllocationReport): string {
  const { macro, regionalMacro, marketBenchmarks } = report;
  const macroRows: string[] = [];
  if (macro.tenYearRate !== null)
    macroRows.push(`<tr><td>10Y Treasury</td><td class="ic-r">${pct2(macro.tenYearRate)}</td></tr>`);
  if (macro.cpi !== null)
    macroRows.push(`<tr><td>CPI (YoY)</td><td class="ic-r">${pct1(macro.cpi)}</td></tr>`);
  const macroProv = macro.source === 'fred' ? 'FRED (live)' : 'seeded fallback';

  let regionalBlock = '';
  if (regionalMacro && regionalMacro.states.length > 0) {
    const stateRows = regionalMacro.states
      .map(
        (s) =>
          `<tr><td>${esc(s.stateName)} (${esc(s.stateCode)})</td><td class="ic-r">${pct1(s.unemploymentRate)}</td></tr>`,
      )
      .join('\n          ');
    const regionalProv = regionalMacro.source === 'fred' ? 'FRED (live)' : 'seeded fallback';
    regionalBlock = `
    <div class="ic-context-col">
      <h3>Regional Labor — Unemployment</h3>
      <table class="ic-mini-table">
        <tbody>
          ${stateRows}
        </tbody>
      </table>
      <p class="ic-note">Seasonally adjusted, monthly${regionalMacro.asOf ? `, as of ${esc(regionalMacro.asOf)}` : ''}.
      Source: ${regionalProv}. Diagnostic only — does not affect priority or action.</p>
    </div>`;
  }

  const benchProv =
    !marketBenchmarks.available || marketBenchmarks.source === 'unavailable'
      ? 'unavailable'
      : marketBenchmarks.source === 'fred'
        ? 'FRED (live)'
        : 'seeded snapshot';

  return `
  <section class="ic-section">
    <h2>Market Context</h2>
    <div class="ic-context-grid">
      <div class="ic-context-col">
        <h3>National Macro</h3>
        <table class="ic-mini-table">
          <tbody>
            ${macroRows.join('\n            ') || `<tr><td>${DASH}</td><td class="ic-r">${DASH}</td></tr>`}
          </tbody>
        </table>
        <p class="ic-note">Source: ${macroProv}${macro.asOf ? `, as of ${esc(macro.asOf)}` : ''}.
        Cap-rate benchmarks: ${benchProv}.</p>
      </div>
      ${regionalBlock}
    </div>
  </section>`;
}

function renderMethodology(report: CapitalAllocationReport): string {
  return `
  <section class="ic-section ic-methodology">
    <h2>Methodology</h2>
    <p>
      Priority score = 0.35 &times; (100 &minus; health) + 0.30 &times; attention +
      0.20 &times; leasing risk + 0.15 &times; debt urgency, clamped to [0, 100].
      Higher priority = greater need for capital-committee attention, not desirability.
    </p>
    <p>
      All NOI and SF figures are <strong>Spine A</strong> (ownership layer, from the master
      workbook snapshot). They are <strong>not</strong> comparable with Spine-B warehouse-ledger
      analytics and must never be aggregated against them without explicit basis-matching.
    </p>
    <p>
      Implied cap rate, cap-rate gap vs market, regional unemployment, and national macro are
      <strong>diagnostic / display-only</strong>: they do not feed the priority score or the
      capital action. Cap band is a discrete position (below / at / above market), not a
      continuous percentile. Em-dash (${DASH}) denotes an unavailable value (never zero-substituted).
    </p>
    <p class="ic-note">Generated ${esc(report.asOf)} from the Capital Allocation report
    (GET /api/warehouse/capital-allocation). Confidential — Investment Committee use only.</p>
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
    .num, .ic-r, .ic-strong, .ic-badge, .ic-table td.ic-r, .ic-mini-table td.ic-r { font-family: ${MONO}; }

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

    /* Market context */
    .ic-context-grid { display: flex; gap: 32px; flex-wrap: wrap; }
    .ic-context-col { flex: 1; min-width: 240px; }
    .ic-mini-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    .ic-mini-table td { padding: 4px 8px; border-bottom: 1px solid var(--hairline); }

    /* Methodology */
    .ic-methodology p { font-size: 11px; color: var(--ink); margin: 0 0 8px; }

    /* Print optimization — keep blocks intact, force section page-breaks, hide chrome */
    @page { size: letter; margin: 14mm; }
    @media print {
      body { background: #fff; }
      .ic-page { max-width: none; padding: 0; box-shadow: none; }
      .ic-section, .ic-action-block, .ic-context-col { page-break-inside: avoid; break-inside: avoid; }
      .ic-table thead { display: table-header-group; }
      .ic-row { page-break-inside: avoid; break-inside: avoid; }
      .ic-cover { page-break-after: always; break-after: page; }
      h2, h3 { page-break-after: avoid; break-after: avoid; }
    }
  </style>`;
}

// ── Document builder ────────────────────────────────────────────────────────────────────────

/**
 * Builds the complete, self-contained IC Memo HTML document from a CapitalAllocationReport.
 *
 * Pure — no IO, no DB. Output is a full HTML5 document (inline ORA styles, no remote
 * dependencies) suitable for browser "Print to PDF" into an extractable-text PDF.
 */
export function buildIcMemoHtml(report: CapitalAllocationReport): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ORA Capital Allocation Review — ${esc(report.asOf)}</title>${styleBlock()}
</head>
<body>
  <div class="ic-page">
${renderCover(report)}
${renderExecSummary(report)}
${renderPriorityMatrix(report)}
${renderActionBreakdown(report)}
${renderMarketContext(report)}
${renderMethodology(report)}
  </div>
</body>
</html>`;
}
