import type { Insight } from '../../src/analytics/types';
import { fmtUsdCompact } from '../../src/analytics/format';

export interface BriefInput {
  asOf: string;
  freshness: string;
  insights: Insight[];
  criticalDates: { date: string; label: string; days: number }[];
  dealCounts: { stage: string; count: number }[];
  kpis: { noi: string; value: string; occupancy: string; cash: string; dscrSummary: string };
  tasks: { label: string; status: string }[];
  dashboardUrl: string;
}
export interface Email { subject: string; html: string }

const NAVY = '#1B2A4A', GOLD = '#C9A96E', CREAM = '#F5F3EF', INK = '#222';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sevColor = (s: Insight['severity']) => (s === 'critical' ? '#B3261E' : s === 'warning' ? GOLD : '#5A6B8C');

function section(title: string, body: string): string {
  return `<tr><td style="padding:18px 24px 4px;font:600 13px DM Sans,Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:${NAVY}">${esc(title)}</td></tr><tr><td style="padding:0 24px 8px;font:14px/1.5 Georgia,serif;color:${INK}">${body}</td></tr>`;
}

function alertRows(insights: Insight[]): string {
  if (insights.length === 0) return '<em>No open items.</em>';
  return insights.map((i) =>
    `<div style="border-left:3px solid ${sevColor(i.severity)};padding:6px 10px;margin:6px 0;background:${CREAM}">
      <strong>${esc(i.title)}</strong>${i.metric ? ` <span style="color:${NAVY}">· ${esc(i.metric)}</span>` : ''}<br>
      <span style="font-size:13px;color:#444">${esc(i.detail)}</span></div>`).join('');
}

function dateRows(items: { date: string; label: string; days: number }[]): string {
  if (!items.length) return '<em>Nothing in the next 90 days.</em>';
  return `<ul style="margin:4px 0;padding-left:18px">${items.map((i) =>
    `<li>${esc(i.date)} — ${esc(i.label)} <span style="color:#999">(${i.days}d)</span></li>`).join('')}</ul>`;
}

function topExposureRow(insights: Insight[]): string {
  const best = insights.reduce<Insight | null>((acc, i) => {
    if (i.impactAnnualUsd === null || !Number.isFinite(i.impactAnnualUsd)) return acc;
    if (acc === null || i.impactAnnualUsd > (acc.impactAnnualUsd ?? -Infinity)) return i;
    return acc;
  }, null);
  if (best === null) return '';
  const body = `<strong>${esc(best.title)}</strong> &nbsp;·&nbsp; <span style="font-family:IBM Plex Mono,monospace;color:${NAVY}">${esc(fmtUsdCompact(best.impactAnnualUsd))}/yr</span>`;
  return section('Top exposure', body);
}

export function renderBrief(b: BriefInput): Email {
  const deals = b.dealCounts.map((d) => `${esc(d.stage)}: <strong>${d.count}</strong>`).join(' &nbsp;·&nbsp; ') || '—';
  const tasks = b.tasks.length ? b.tasks.map((t) => `<li>${esc(t.label)} <span style="color:#999">(${esc(t.status)})</span></li>`).join('') : '<li>None due</li>';
  const kpis = `NOI <strong>${esc(b.kpis.noi)}</strong> &nbsp;·&nbsp; Value <strong>${esc(b.kpis.value)}</strong> &nbsp;·&nbsp; Occupancy <strong>${esc(b.kpis.occupancy)}</strong> &nbsp;·&nbsp; Cash <strong>${esc(b.kpis.cash)}</strong> &nbsp;·&nbsp; DSCR ${esc(b.kpis.dscrSummary)}`;
  const html =
    `<table width="640" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#fff;border:1px solid #e3ddcd">
      <tr><td style="background:${NAVY};padding:18px 24px;color:#fff;font:700 18px DM Sans,Arial,sans-serif">Oxford Command Center — Daily Brief
        <div style="font:400 12px DM Sans,Arial;color:${GOLD};margin-top:2px">As of ${esc(b.asOf)} · data ${esc(b.freshness)}</div></td></tr>
      ${topExposureRow(b.insights)}
      ${section('Action items', alertRows(b.insights))}
      ${section('Critical dates — next 90 days', dateRows(b.criticalDates))}
      ${section('Deal pipeline', deals)}
      ${section('Portfolio at-a-glance', kpis)}
      ${section('Tasks', `<ul style="margin:4px 0;padding-left:18px">${tasks}</ul>`)}
      <tr><td style="padding:16px 24px;background:${CREAM};font:13px DM Sans,Arial"><a href="${esc(b.dashboardUrl)}" style="color:${NAVY};font-weight:600">Open the live dashboard →</a></td></tr>
    </table>`;
  return { subject: `[ORA Command Center] Daily Brief — ${b.asOf}`, html };
}

export function renderAlert(i: Insight): Email {
  const html =
    `<table width="560" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#fff;border:1px solid #e3ddcd">
      <tr><td style="background:${sevColor(i.severity)};padding:14px 20px;color:#fff;font:700 16px DM Sans,Arial">${i.severity.toUpperCase()} ALERT</td></tr>
      <tr><td style="padding:18px 20px;font:15px/1.6 Georgia,serif;color:${INK}">
        <strong>${esc(i.title)}</strong>${i.metric ? ` · ${esc(i.metric)}` : ''}<br><br>${esc(i.detail)}</td></tr>
    </table>`;
  return { subject: `[ORA Command Center] ${i.severity.toUpperCase()}: ${i.title}`, html };
}
