/* eslint-disable react-refresh/only-export-components -- server-side PDF module (no client fast-refresh); it intentionally exports both the Document component and the renderBriefingPdf helper. */
// server/briefing/pdf.tsx
//
// BriefingModel → ORA-branded PDF (extractable text layer). SERVER-ONLY (@react-pdf/renderer).
// Charts are lightweight vector primitives (<Svg><Path> sparklines/bars) built from the analytics
// series the composer already read — NO ECharts/canvas/headless browser.
//
// Determinism: every figure/string is read off the model; the ONLY date is meta.generatedDate
// (injected by the composer caller), never Date.now() inside the renderer. The PDF creation/mod
// dates are pinned to meta.generatedDate so two renders of the same model produce identical
// extracted text (the byte container still differs only in fontkit's random subset tag — see
// the determinism test, which asserts content equality).
import React from 'react';
import { Document, Page, View, Text, Svg, Path, Line, StyleSheet } from '@react-pdf/renderer';
import { ORA, FONT, registerFonts } from './theme';
import type {
  BriefingModel,
  PropertyBriefingModel,
  ManagerBriefingModel,
  Figure,
  BriefingMeta,
} from '../../src/contracts/briefing';

registerFonts();

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 56, paddingHorizontal: 48, fontFamily: FONT.sans, fontSize: 9, color: ORA.ink, backgroundColor: ORA.white },
  masthead: { fontFamily: FONT.sans, fontSize: 9, fontWeight: 700, letterSpacing: 2, color: ORA.navy },
  goldRule: { height: 2, backgroundColor: ORA.gold, marginTop: 4, marginBottom: 14 },
  title: { fontFamily: FONT.serif, fontSize: 22, fontWeight: 700, color: ORA.navy, marginBottom: 2 },
  subtitle: { fontFamily: FONT.sans, fontSize: 9, color: ORA.muted, marginBottom: 14 },
  sectionLabel: { fontFamily: FONT.sans, fontSize: 8, fontWeight: 700, letterSpacing: 1, color: ORA.navy, marginBottom: 6, marginTop: 14 },
  panel: { backgroundColor: ORA.parchment, borderRadius: 4, padding: 12 },
  verdictRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  verdictScore: { fontFamily: FONT.mono, fontSize: 30, fontWeight: 500, color: ORA.navy },
  chip: { fontFamily: FONT.sans, fontSize: 7.5, fontWeight: 700, letterSpacing: 0.5, color: ORA.white, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 3 },
  kpiRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  kpiTile: { flex: 1, backgroundColor: ORA.parchment, borderRadius: 4, padding: 8 },
  kpiLabel: { fontFamily: FONT.sans, fontSize: 7, color: ORA.muted, marginBottom: 2 },
  kpiValue: { fontFamily: FONT.mono, fontSize: 12, color: ORA.navy },
  body: { fontFamily: FONT.sans, fontSize: 9, color: ORA.ink, lineHeight: 1.4 },
  mono: { fontFamily: FONT.mono },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: ORA.navy, paddingBottom: 3, marginBottom: 2 },
  th: { fontFamily: FONT.sans, fontSize: 7.5, fontWeight: 700, color: ORA.navy },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: ORA.hairline, paddingVertical: 3 },
  td: { fontFamily: FONT.sans, fontSize: 8, color: ORA.ink },
  tdMono: { fontFamily: FONT.mono, fontSize: 8, color: ORA.ink },
  bullet: { flexDirection: 'row', marginBottom: 2 },
  footer: { position: 'absolute', bottom: 28, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: ORA.gold, paddingTop: 5 },
  footerText: { fontFamily: FONT.sans, fontSize: 6.5, color: ORA.muted },
  footerConf: { fontFamily: FONT.sans, fontSize: 6.5, fontWeight: 700, color: ORA.navy, letterSpacing: 0.5 },
});

// The brand latin subsets do NOT cover every symbol the analytics engine might emit (Greek Δ, ≥, the
// → in driver-bridge lines, and any future glyph). A referenced-but-absent glyph crashes fontkit
// mid-render (RangeError in TTFGlyph). For an outward-facing financial artifact we NEVER risk that, so
// safeText is defense-in-depth: (1) substitute the known symbols that have a clean ASCII equivalent,
// then (2) RANGE-FILTER — strip anything outside the glyph ranges the brand faces actually cover, so a
// brand-new un-mapped symbol degrades to nothing rather than crashing. The covered punctuation the
// briefing uses (em-dash —, middot ·, bullet •, en-dash –, ×) is inside the kept range and passes through.
const GLYPH_SUBSTITUTIONS: Record<string, string> = {
  'Δ': 'd', // Greek capital delta → 'd' (we avoid it in labels; this is the backstop)
  '≥': '>=',
  '≤': '<=',
  '→': '->', // right arrow (appears in 'FY2023->FY2024' driver-bridge lines) is not in the latin subset
};
/** Codepoints kept by the range filter: Basic Latin + Latin-1 Supplement (incl. ×, ·, en/em context),
 *  plus the specific General-Punctuation glyphs the brand subsets carry (– — ' ' " " • …). Anything
 *  else is dropped (after substitution) so an un-anticipated symbol can never reach fontkit and crash. */
const KEEP_PUNCT = new Set(['–', '—', '‘', '’', '“', '”', '•', '…']);
function isCovered(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true; // tab/newlines (layout-only)
  if (cp >= 0x20 && cp <= 0x7e) return true; // Basic Latin (printable ASCII)
  if (cp >= 0xa0 && cp <= 0xff) return true; // Latin-1 Supplement (× ·, accented letters, etc.)
  return KEEP_PUNCT.has(String.fromCodePoint(cp));
}
function safeText(s: string): string {
  let out = s;
  for (const [bad, good] of Object.entries(GLYPH_SUBSTITUTIONS)) out = out.split(bad).join(good);
  // Drop any remaining codepoint the brand faces don't cover (fail-safe, never a render crash).
  let filtered = '';
  for (const ch of out) if (isCovered(ch.codePointAt(0)!)) filtered += ch;
  return filtered;
}

const HEALTH_COLOR: Record<string, string> = { excellent: ORA.pos, good: ORA.pos, watch: ORA.gold, concern: ORA.neg };
const ATTENTION_COLOR: Record<string, string> = { green: ORA.pos, yellow: ORA.gold, orange: '#C2700A', red: ORA.neg };
const SEVERITY_COLOR: Record<string, string> = { low: ORA.muted, moderate: ORA.gold, high: '#C2700A', critical: ORA.neg };

/** A vector sparkline path over `series` within a w×h box, baseline-padded. Returns null for <2 pts. */
function sparkPath(series: number[], w: number, h: number): string | null {
  if (series.length < 2) return null;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const dx = w / (series.length - 1);
  const pad = 2;
  const ih = h - pad * 2;
  return series
    .map((v, i) => {
      const x = (i * dx).toFixed(2);
      const y = (pad + ih - ((v - min) / span) * ih).toFixed(2);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

function Sparkline({ series, color = ORA.gold }: { series: number[]; color?: string }) {
  const d = sparkPath(series, 80, 20);
  if (!d) return null;
  return (
    <Svg width={80} height={20} viewBox="0 0 80 20">
      <Path d={d} stroke={color} strokeWidth={1.2} fill="none" />
    </Svg>
  );
}

/** Vertical bars for the NOI trend — labeled below by index position (FY order). */
function BarSpark({ series }: { series: number[] }) {
  if (series.length < 1) return <Text style={styles.footerText}>n/a — needs at least one full year</Text>;
  const w = 220;
  const h = 40;
  const max = Math.max(...series, 0);
  const min = Math.min(...series, 0);
  const span = max - min || 1;
  const bw = (w / series.length) * 0.6;
  const gap = (w / series.length) * 0.4;
  const zeroY = h - ((0 - min) / span) * h;
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <Line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke={ORA.hairline} strokeWidth={0.5} />
      {series.map((v, i) => {
        const x = i * (bw + gap) + gap / 2;
        const top = h - ((Math.max(v, 0) - min) / span) * h;
        const bottom = h - ((Math.min(v, 0) - min) / span) * h;
        return <Path key={i} d={`M${x.toFixed(2)},${top.toFixed(2)} h${bw.toFixed(2)} v${(bottom - top).toFixed(2)} h${(-bw).toFixed(2)} Z`} fill={v >= 0 ? ORA.navy : ORA.neg} />;
      })}
    </Svg>
  );
}

function Chip({ label, color }: { label: string; color: string }) {
  return <Text style={[styles.chip, { backgroundColor: color }]}>{label.toUpperCase()}</Text>;
}

function fig(f: Figure): string {
  return safeText(f.display);
}

function Footer({ meta }: { meta: BriefingMeta }) {
  const freshness = meta.dataFreshness ? `· QB data ${meta.dataFreshness}` : '';
  return (
    <View style={styles.footer} fixed>
      <Text style={styles.footerConf}>{meta.confidentialMarking}</Text>
      <Text style={styles.footerText}>
        Workbook as of {meta.workbookAsOf} {freshness} · Generated {meta.generatedDate}
      </Text>
    </View>
  );
}

function Masthead({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View>
      <Text style={styles.masthead}>OXFORD REALTY ADVISORS</Text>
      <View style={styles.goldRule} />
      <Text style={styles.title}>{safeText(title)}</Text>
      <Text style={styles.subtitle}>{safeText(subtitle)}</Text>
    </View>
  );
}

// ── Per-property page ──────────────────────────────────────────────────────────────────────────
function PropertyBriefingDoc({ m }: { m: PropertyBriefingModel }) {
  const subtitleParts = [m.subject.market, m.subject.manager ? `Managed by ${m.subject.manager}` : null].filter(Boolean);
  return (
    <Document title={`ORA Briefing — ${m.subject.name}`} author="Oxford Realty Advisors" creator="Oxford Command Center" producer="Oxford Command Center" creationDate={new Date(`${m.meta.generatedDate}T00:00:00Z`)} modificationDate={new Date(`${m.meta.generatedDate}T00:00:00Z`)}>
      <Page size="LETTER" style={styles.page}>
        <Masthead title={m.subject.name} subtitle={`Property Intelligence Briefing${subtitleParts.length ? ' · ' + subtitleParts.join(' · ') : ''}`} />

        <Text style={styles.sectionLabel}>VERDICT</Text>
        <View style={styles.panel}>
          <View style={styles.verdictRow}>
            <Text style={styles.verdictScore}>{fig(m.verdict.health)}</Text>
            <View style={{ gap: 3 }}>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                <Chip label={m.verdict.healthBand} color={HEALTH_COLOR[m.verdict.healthBand] ?? ORA.muted} />
                <Chip label={`attention ${m.verdict.attentionBand}`} color={ATTENTION_COLOR[m.verdict.attentionBand] ?? ORA.muted} />
                <Chip label={m.verdict.capitalAction.replace(/-/g, ' ')} color={ORA.navy} />
              </View>
              <Text style={[styles.footerText, { fontSize: 7 }]}>Health score (0–100){m.subject.scoredPeriod ? ` · scored on FY${m.subject.scoredPeriod}` : ''}</Text>
            </View>
          </View>
          {m.verdict.rootCause ? <Text style={[styles.body, { marginTop: 8 }]}>{safeText(m.verdict.rootCause)}</Text> : <Text style={[styles.body, { marginTop: 8, color: ORA.muted }]}>Root-cause waterfall n/a — needs two full years.</Text>}
          <Text style={[styles.body, { marginTop: 4, fontWeight: 700, color: ORA.navy }]}>{safeText(m.verdict.recommendation)}</Text>
        </View>

        <Text style={styles.sectionLabel}>KEY METRICS</Text>
        <View style={styles.kpiRow}>
          {m.kpis.map((k) => (
            <View key={k.label} style={styles.kpiTile}>
              <Text style={styles.kpiLabel}>{k.label}</Text>
              <Text style={styles.kpiValue}>{fig(k.figure)}</Text>
              <View style={{ marginTop: 3 }}>
                <Sparkline series={k.spark} />
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.sectionLabel}>NOI TREND (FY)</Text>
        <BarSpark series={m.noiTrend} />

        <Text style={styles.sectionLabel}>TOP NOI-CHANGE DRIVERS</Text>
        {m.drivers.length === 0 ? (
          <Text style={[styles.body, { color: ORA.muted }]}>n/a — needs two full years to bridge.</Text>
        ) : (
          <View>
            <View style={styles.tableHead}>
              <Text style={[styles.th, { flex: 3 }]}>Category</Text>
              <Text style={[styles.th, { flex: 1, textAlign: 'right' }]}>NOI change ($)</Text>
              <Text style={[styles.th, { flex: 1, textAlign: 'right' }]}>Share (%)</Text>
            </View>
            {m.drivers.map((d, i) => (
              <View key={i} style={styles.tr}>
                <Text style={[styles.td, { flex: 3 }]}>{safeText(d.category)}</Text>
                <Text style={[styles.tdMono, { flex: 1, textAlign: 'right' }]}>{fig(d.delta)}</Text>
                <Text style={[styles.tdMono, { flex: 1, textAlign: 'right' }]}>{fig(d.contributionPct)}</Text>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.sectionLabel}>ANOMALIES</Text>
        {m.anomalies.length === 0 ? (
          <Text style={[styles.body, { color: ORA.muted }]}>None flagged.</Text>
        ) : (
          m.anomalies.map((a, i) => (
            <View key={i} style={styles.bullet}>
              <Text style={{ color: SEVERITY_COLOR[a.severity] ?? ORA.muted, fontWeight: 700, fontSize: 8, marginRight: 4 }}>[{a.severity}]</Text>
              <Text style={[styles.body, { flex: 1 }]}>{safeText(a.detail)}</Text>
            </View>
          ))
        )}

        <Text style={styles.sectionLabel}>ROLLOVER / LEASE RUN</Text>
        {!m.leaseRun.present ? (
          <Text style={[styles.body, { color: ORA.muted }]}>n/a — no abstracted lease terms for this property.</Text>
        ) : (
          <View style={styles.panel}>
            <Text style={styles.body}>
              Tenant: <Text style={styles.mono}>{safeText(m.leaseRun.tenant ?? '—')}</Text> · Current expiry:{' '}
              <Text style={styles.mono}>{m.leaseRun.currentExpiry ?? '—'}</Text>
            </Text>
            <Text style={[styles.body, { marginTop: 3 }]}>
              Stabilized NOI: <Text style={styles.mono}>{fig(m.leaseRun.stabilizedNoi)}</Text> · Indicative value:{' '}
              <Text style={styles.mono}>{fig(m.leaseRun.indicativeValue)}</Text>
              {m.leaseRun.belowMarket ? '  · BELOW MARKET' : ''}
            </Text>
            {m.leaseRun.rolloverLabels.length > 0 && (
              <Text style={[styles.body, { marginTop: 3 }]}>Rollover at: {m.leaseRun.rolloverLabels.join(', ')}</Text>
            )}
          </View>
        )}

        <Text style={styles.sectionLabel}>BENCHMARK</Text>
        <Text style={styles.body}>
          NOI/SF: <Text style={styles.mono}>{fig(m.benchmark.noiPerSf)}</Text> · Cohort median:{' '}
          <Text style={styles.mono}>{fig(m.benchmark.cohortMedianNoiPerSf)}</Text> · Quartile:{' '}
          <Text style={styles.mono}>{m.benchmark.noiPerSfQuartile ?? '—'}</Text> of 4 · Cohort n={m.benchmark.cohortSize}
        </Text>

        <Footer meta={m.meta} />
      </Page>
    </Document>
  );
}

// ── Per-PM page ───────────────────────────────────────────────────────────────────────────────
function ManagerBriefingDoc({ m }: { m: ManagerBriefingModel }) {
  return (
    <Document title={`ORA Briefing — ${m.subject.name}`} author="Oxford Realty Advisors" creator="Oxford Command Center" producer="Oxford Command Center" creationDate={new Date(`${m.meta.generatedDate}T00:00:00Z`)} modificationDate={new Date(`${m.meta.generatedDate}T00:00:00Z`)}>
      <Page size="LETTER" style={styles.page}>
        <Masthead title={m.subject.name} subtitle={`Property Manager Briefing${m.subject.contact ? ` · ${m.subject.contact}` : ''}${m.subject.smallSample ? ' · small sample — directional' : ''}`} />

        <Text style={styles.sectionLabel}>PORTFOLIO SCORECARD</Text>
        <View style={styles.kpiRow}>
          <View style={styles.kpiTile}>
            <Text style={styles.kpiLabel}>Properties</Text>
            <Text style={styles.kpiValue}>{m.subject.propertyCount}</Text>
          </View>
          <View style={styles.kpiTile}>
            <Text style={styles.kpiLabel}>Aggregate NOI</Text>
            <Text style={styles.kpiValue}>{fig(m.scorecard.aggregateNoi)}</Text>
          </View>
          <View style={styles.kpiTile}>
            <Text style={styles.kpiLabel}>Avg NOI / SF</Text>
            <Text style={styles.kpiValue}>{fig(m.scorecard.avgNoiPerSf)}</Text>
          </View>
          <View style={styles.kpiTile}>
            <Text style={styles.kpiLabel}>Avg NOI growth</Text>
            <Text style={styles.kpiValue}>{fig(m.scorecard.avgNoiGrowth)}</Text>
          </View>
        </View>

        <Text style={styles.sectionLabel}>MANAGED PROPERTIES</Text>
        {m.managedProperties.length === 0 ? (
          <Text style={[styles.body, { color: ORA.muted }]}>n/a — no managed properties with ledger data.</Text>
        ) : (
          <View>
            <View style={styles.tableHead}>
              <Text style={[styles.th, { flex: 4 }]}>Property</Text>
              <Text style={[styles.th, { flex: 1.2, textAlign: 'right' }]}>Health</Text>
              <Text style={[styles.th, { flex: 1.2, textAlign: 'right' }]}>NOI ($)</Text>
              <Text style={[styles.th, { flex: 1.4, textAlign: 'right' }]}>Attention</Text>
            </View>
            {m.managedProperties.map((r) => (
              <View key={r.propertyId} style={styles.tr}>
                <Text style={[styles.td, { flex: 4 }]}>{safeText(r.name)}</Text>
                <Text style={[styles.tdMono, { flex: 1.2, textAlign: 'right', color: HEALTH_COLOR[r.healthBand] ?? ORA.ink }]}>{fig(r.health)}</Text>
                <Text style={[styles.tdMono, { flex: 1.2, textAlign: 'right' }]}>{fig(r.noi)}</Text>
                <Text style={[styles.td, { flex: 1.4, textAlign: 'right', color: ATTENTION_COLOR[r.attentionBand] ?? ORA.ink, fontWeight: 700 }]}>{r.attentionBand}</Text>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.sectionLabel}>ATTENTION ITEMS</Text>
        {m.attentionItems.length === 0 ? (
          <Text style={[styles.body, { color: ORA.muted }]}>None flagged across the managed portfolio.</Text>
        ) : (
          m.attentionItems.map((t, i) => (
            <View key={i} style={styles.bullet}>
              <Text style={{ color: ORA.gold, marginRight: 4 }}>•</Text>
              <Text style={[styles.body, { flex: 1 }]}>{safeText(t)}</Text>
            </View>
          ))
        )}

        <Text style={styles.sectionLabel}>RANKED ACTIONS</Text>
        {m.actionList.map((t, i) => (
          <View key={i} style={styles.bullet}>
            <Text style={[styles.mono, { marginRight: 4, color: ORA.navy }]}>{i + 1}.</Text>
            <Text style={[styles.body, { flex: 1 }]}>{safeText(t)}</Text>
          </View>
        ))}

        <Footer meta={m.meta} />
      </Page>
    </Document>
  );
}

/** The single entry point: a BriefingModel → a react-pdf Document element. */
export function BriefingDocument({ model }: { model: BriefingModel }): React.ReactElement {
  return model.kind === 'property' ? <PropertyBriefingDoc m={model} /> : <ManagerBriefingDoc m={model} />;
}

/** Render a BriefingModel to PDF bytes (Buffer). */
export async function renderBriefingPdf(model: BriefingModel): Promise<Buffer> {
  // Lazy import keeps renderToBuffer off the module top-level (it pulls the full pdfkit graph).
  const { renderToBuffer } = await import('@react-pdf/renderer');
  return renderToBuffer(<BriefingDocument model={model} />);
}
