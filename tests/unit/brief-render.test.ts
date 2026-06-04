import { describe, it, expect } from 'vitest';
import type { Insight } from '../../src/analytics/types';
import { renderBrief, renderAlert } from '../../server/brief/render';

const insight = (o: Partial<Insight>): Insight => ({ id: 'x', severity: 'critical', category: 'debt', title: 'T', detail: 'D', ...o });

describe('renderBrief', () => {
  const out = renderBrief({
    asOf: '2026-06-04', freshness: 'live',
    insights: [insight({ id: 'a', severity: 'critical', title: 'Balloon due — X', detail: '$1M' })],
    criticalDates: [{ date: '2026-06-20', label: 'Expiration: REDACTED-659', days: 16 }],
    dealCounts: [{ stage: 'LOI/PSA', count: 2 }],
    kpis: { noi: '$3.9M', value: '$59.6M', occupancy: '94%', cash: '$7.8M', dscrSummary: 'min 1.10x' },
    tasks: [{ label: 'Send estoppel', status: 'overdue' }],
    dashboardUrl: 'https://ora-command-center.pages.dev',
  });
  it('includes a dated subject', () => expect(out.subject).toContain('2026-06-04'));
  it('renders the action-items section with the alert title', () => expect(out.html).toContain('Balloon due — X'));
  it('renders the critical-dates section', () => { expect(out.html).toContain('Critical dates'); expect(out.html).toContain('Expiration: REDACTED-659'); });
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
