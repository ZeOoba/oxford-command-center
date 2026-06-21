import { describe, it, expect } from 'vitest';
import type { Insight } from '../../src/analytics/types';
import { renderBrief, renderAlert } from '../../server/brief/render';

const insight = (o: Partial<Insight>): Insight => ({ id: 'x', severity: 'critical', category: 'debt', title: 'T', detail: 'D', impactAnnualUsd: null, spine: 'B', provenance: 'absent', ...o });

describe('renderBrief', () => {
  const out = renderBrief({
    asOf: '2026-06-04', freshness: 'live',
    insights: [insight({ id: 'a', severity: 'critical', title: 'Balloon due — X', detail: '$1M' })],
    criticalDates: [{ date: '2026-06-20', label: 'Expiration: Eurosort', days: 16 }],
    dealCounts: [{ stage: 'LOI/PSA', count: 2 }],
    kpis: { noi: '$3.9M', value: '$59.6M', occupancy: '94%', cash: '$7.8M', dscrSummary: 'min 1.10x' },
    tasks: [{ label: 'Send estoppel', status: 'overdue' }],
    dashboardUrl: 'https://ora-command-center.pages.dev',
  });
  it('includes a dated subject', () => expect(out.subject).toContain('2026-06-04'));
  it('renders the action-items section with the alert title', () => expect(out.html).toContain('Balloon due — X'));
  it('renders the critical-dates section', () => { expect(out.html).toContain('Critical dates'); expect(out.html).toContain('Expiration: Eurosort'); });
  it('renders the portfolio at-a-glance figures', () => { expect(out.html).toContain('$3.9M'); expect(out.html).toContain('94%'); });
  it('links to the live dashboard', () => expect(out.html).toContain('https://ora-command-center.pages.dev'));
});

describe('renderAlert', () => {
  it('renders a single-item critical email with a CRITICAL subject', () => {
    const out = renderAlert(insight({ title: 'Policy cancelled — Y', detail: 'Bind coverage' }));
    expect(out.subject).toMatch(/CRITICAL/);
    expect(out.html).toContain('Policy cancelled — Y');
  });
});

describe('renderBrief — top-exposure line', () => {
  it('emits a Top exposure line above Action items when at least one insight has a numeric impact', () => {
    const out = renderBrief({
      asOf: '2026-06-04', freshness: 'live',
      insights: [
        insight({ id: 'b', severity: 'warning', title: 'Lease expiring — SmallTenant', detail: '$20K/yr', impactAnnualUsd: 20000 }),
        insight({ id: 'a', severity: 'warning', title: 'Lease expiring — BigTenant', detail: '$80K/yr', impactAnnualUsd: 80000 }),
        insight({ id: 'c', severity: 'critical', title: 'Balloon due — Loan', detail: 'null impact', impactAnnualUsd: null }),
      ],
      criticalDates: [],
      dealCounts: [],
      kpis: { noi: '$3.9M', value: '$59.6M', occupancy: '94%', cash: '$7.8M', dscrSummary: 'min 1.10x' },
      tasks: [],
      dashboardUrl: 'https://ora-command-center.pages.dev',
    });
    // The top-exposure line must be present and reference BigTenant (highest impactAnnualUsd = $80K)
    expect(out.html).toContain('Top exposure');
    expect(out.html).toContain('Lease expiring — BigTenant');
    // The compact dollar format for $80,000 should be $80K
    expect(out.html).toContain('$80K');
    // It must appear before the Action items section
    const topIdx = out.html.indexOf('Top exposure');
    const actionIdx = out.html.indexOf('Action items');
    expect(topIdx).toBeGreaterThanOrEqual(0);
    expect(actionIdx).toBeGreaterThanOrEqual(0);
    expect(topIdx).toBeLessThan(actionIdx);
  });

  it('renders nothing for top exposure when all insights have null impact', () => {
    const out = renderBrief({
      asOf: '2026-06-04', freshness: 'live',
      insights: [
        insight({ id: 'a', severity: 'critical', title: 'Reconciliation failure', detail: 'mismatch', impactAnnualUsd: null }),
      ],
      criticalDates: [],
      dealCounts: [],
      kpis: { noi: '$3.9M', value: '$59.6M', occupancy: '94%', cash: '$7.8M', dscrSummary: 'min 1.10x' },
      tasks: [],
      dashboardUrl: 'https://ora-command-center.pages.dev',
    });
    expect(out.html).not.toContain('Top exposure');
  });

  it('renders nothing for top exposure when insights array is empty', () => {
    const out = renderBrief({
      asOf: '2026-06-04', freshness: 'live',
      insights: [],
      criticalDates: [],
      dealCounts: [],
      kpis: { noi: '$3.9M', value: '$59.6M', occupancy: '94%', cash: '$7.8M', dscrSummary: 'min 1.10x' },
      tasks: [],
      dashboardUrl: 'https://ora-command-center.pages.dev',
    });
    expect(out.html).not.toContain('Top exposure');
  });
});
