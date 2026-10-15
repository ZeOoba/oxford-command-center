// tests/unit/property-condition-module.test.tsx
//
// Render-level tests for src/modules/property-condition/PropertyConditionModule.tsx and the pure display
// helpers in ./hooks.ts. The report query is seeded straight into the QueryClient cache (mirrors
// capital-module.test.tsx) so the render is deterministic and network-free.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PropertyConditionModule } from '../../src/modules/property-condition/PropertyConditionModule';
import { CoverageCard } from '../../src/modules/property-condition/SpecsView';
import {
  PROPERTY_CONDITION_KEYS,
  ageLabel,
  ageTone,
  evidenceBadge,
  fmtDeltaPct,
  fmtPartialDate,
  fmtPsf,
  truncate,
  usabilityBadge,
  warrantyBadge,
} from '../../src/modules/property-condition/hooks';
import type { PropertyConditionReport } from '../../src/contracts/property-condition';

function brief(over: Partial<PropertyConditionReport['properties'][number]['current']> = {}) {
  return {
    reportId: 'R03', reportDate: '2025-04-28', consultant: 'CBRE', usabilityClass: 'limited' as const,
    usabilityRaw: 'CURRENT (reliance limited)', sf: 198576, immediateUsd: 26000, shortTermUsd: 566125,
    reservesUninflUsd: 781625, reservesInflUsd: 838287.64, termYears: 12, psfYrStated: 0.33, notes: 'No roof access', ...over,
  };
}

function report(over: Partial<PropertyConditionReport> = {}): PropertyConditionReport {
  return {
    asOf: '2026-10-07',
    loaded: true,
    properties: [
      {
        propertyKey: 'e-fulton', propertyLabel: '3520 E Fulton St', propertyMasterId: null, current: brief(),
        history: [], ageYears: 1, reservesPsfYr: 0.328, hasDollarFigures: true,
      },
      {
        propertyKey: 'sheriff-rd', propertyLabel: '6410 Sheriff Rd', propertyMasterId: null,
        current: brief({ reportId: 'R16', reportDate: '2007-07-19', consultant: 'PCI', usabilityClass: 'stale', usabilityRaw: 'STALE', sf: null, immediateUsd: 11500, shortTermUsd: null, reservesUninflUsd: null, reservesInflUsd: 60855, termYears: null, psfYrStated: null, notes: null }),
        history: [], ageYears: 19, reservesPsfYr: null, hasDollarFigures: true,
      },
    ],
    totals: { propertiesTotal: 2, propertiesWithFigures: 2, immediateUsd: 37500, shortTermUsd: 566125, reservesUninflUsd: 781625 },
    schedule: [
      { propertyKey: 'northwood', propertyLabel: 'Northwood', component: 'Roof', installFact: null, installYear: 2020, ageYears: 6, warranty: 'to 2025', warrantyEndYear: 2025, warrantyStatus: 'expired', flag: null },
      { propertyKey: 'new-plant', propertyLabel: 'New Plant', component: 'Roof EPDM', installFact: null, installYear: 2017, ageYears: 9, warranty: '20-yr to 2037', warrantyEndYear: 2037, warrantyStatus: 'active', flag: null },
    ],
    lifecycle: [
      { propertyKey: 'banwick', propertyLabel: 'Banwick', reportId: 'R01', reportDate: '2026-04-07', system: 'EPDM roof replacement', eul: 20, age: 17, rulRaw: '3', dueYear: 2029, totalUsd: 144000, timing: 'Yr3', basis: 'estimate' },
    ],
    calibration: [
      { propertyKey: 'new-plant', propertyLabel: '55 New Plant Ct', scope: 'Re-roof', estimateSource: 'PCI 2016', estimateUsd: 202300, estimatePsf: 7, contractorSource: 'R.D. Bean 2017', contractorUsd: 81870, contractorPsf: 2.85, deltaPct: -0.595, deltaBasis: 'usd', comment: null },
      { propertyKey: 'e-fulton', propertyLabel: '3520 E Fulton', scope: 'Roof replacement', estimateSource: 'CBRE', estimateUsd: null, estimatePsf: 4, contractorSource: 'Able', contractorUsd: null, contractorPsf: 12.5, deltaPct: 2.125, deltaBasis: 'psf', comment: null },
    ],
    quotes: [
      { quoteKey: 'q1', title: '3540 E Fifth — TPO re-roof (Contractors Inc.)', propertyKey: 'e-fifth', propertyLabel: '3540 E Fifth', vendor: 'Contractors Inc.', recordType: 'Contract', status: 'Awarded', trade: 'Roofing', docDate: '2022-04-14', quotedUsd: 243437.88, actualUsd: null, qty: 26700, uom: 'SF', unitPriceUsdPsf: 9.1177, evidenceClass: 'executed', scopeSummary: null, confidence: 'Medium', verified: false, fundingClass: 'Unknown', leaseRecovery: 'Unreviewed', notes: null },
    ],
    priceBook: [
      { reportId: 'R01', propertyKey: 'banwick', propertyLabel: 'Banwick', reportYear: 2026, system: 'Paving full-depth', uom: 'SY', unitCost: 42.5, basis: 'estimate' },
    ],
    openItems: [
      { itemNo: 1, severity: 'High', propertyText: '3520 E Fulton', issue: 'CBRE reserve is a prior-owner PCR', actionNeeded: 'Treat as floor' },
      { itemNo: 15, severity: 'Info', propertyText: null, issue: 'Fee benchmarks', actionNeeded: null },
    ],
    ...over,
  };
}

function seededClient(r: PropertyConditionReport = report()): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(PROPERTY_CONDITION_KEYS.report, r);
  return qc;
}

function renderModule(entry = '/property-condition', qc: QueryClient = seededClient()) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <PropertyConditionModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PropertyConditionModule', () => {
  it('renders the KPI strip and defaults to the Capex outlook view', () => {
    renderModule();
    expect(screen.getByText('Immediate Repairs')).toBeTruthy();
    expect(screen.getByText('Capex Reserves')).toBeTruthy();
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.getByText('Capex outlook by property')).toBeTruthy();
    expect(screen.getAllByText('3520 E Fulton St').length).toBeGreaterThan(0);
    // An old report still appears (current = newest we have) with its age as a caveat badge.
    expect(screen.getAllByText('6410 Sheriff Rd').length).toBeGreaterThan(0);
    expect(screen.getByText('19 yrs')).toBeTruthy();
  });

  it('shows the near-term rollup, reserve intensity and report-currency alerts on the default view', () => {
    renderModule();
    expect(screen.getByText('Near-term capex rollup')).toBeTruthy();
    expect(screen.getByText(/Reserve intensity/)).toBeTruthy();
    expect(screen.getByText('Report-currency alerts')).toBeTruthy();
  });

  it('?view=open adds the 9-item PCA decision queue, all Open and unassigned', () => {
    renderModule('/property-condition?view=open');
    expect(screen.getByText('PCA decision queue')).toBeTruthy();
    expect(screen.getAllByText('Open')).toHaveLength(9);
    expect(screen.getAllByText('Owner: unassigned')).toHaveLength(9);
  });

  it('?view=infolane never shows the Year 1 / Year 2 reserve outlays as Immediate or Short-term', () => {
    renderModule('/property-condition?view=infolane');
    expect(screen.getByText('Immediate (ADA)')).toBeTruthy();
    expect(screen.getByText('$1,100')).toBeTruthy();
    expect(screen.getByText('Reserve schedule by year (uninflated)')).toBeTruthy();
    expect(screen.getAllByText(/\[SPECULATIVE\]/).length).toBeGreaterThanOrEqual(2);
  });

  it('?view=calibration carries the permanent estimate-vs-quote label', () => {
    renderModule('/property-condition?view=calibration');
    expect(screen.getByText(/PCA consultant estimate vs contractor quote; .*directional only below n=5/)).toBeTruthy();
  });

  it('falls back to Capex outlook for an unknown ?view=', () => {
    renderModule('/property-condition?view=nonsense');
    expect(screen.getByText('Capex outlook by property')).toBeTruthy();
  });

  it('?view=schedule shows warranty status and the lifecycle due year', () => {
    renderModule('/property-condition?view=schedule');
    expect(screen.getByText('Install & warranty facts')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getAllByText('Active')).toHaveLength(2); // New Plant (register) + 3540 E Fifth (derived 2042 end)
    expect(screen.getByText('Consultant lifecycle (current reports)')).toBeTruthy();
    expect(screen.getByText('2029')).toBeTruthy();
  });

  it('?view=calibration renders per-component tiers from the ledger, never a single portfolio factor', () => {
    renderModule('/property-condition?view=calibration');
    expect(screen.getByText('PCA estimate vs contractor price — calibration ledger')).toBeTruthy();
    expect(screen.getByText('Roof — EPDM')).toBeTruthy();
    expect(screen.getByText('Roof — TPO')).toBeTruthy();
    expect(screen.getAllByText('LIMITED').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('THIN').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('USABLE')).toBeNull();
    expect(screen.getAllByText('directional only').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/What changed:/)).toBeTruthy();
    expect(screen.queryByText(/portfolio calibration factor/i)).toBeNull();
  });

  it('?view=specs loads the vintage-stamped extractions: coverage, roof clock, rollups, profile and findings ledger', async () => {
    renderModule('/property-condition?view=specs');
    expect(await screen.findByText('Extraction coverage', {}, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText('Roof age & past-EUL list')).toBeTruthy();
    expect(screen.getByText('Portfolio spec rollups (counts by vintage)')).toBeTruthy();
    expect(screen.getByText('Building profile — effective facts')).toBeTruthy();
    expect(screen.getByText(/Findings ledger/)).toBeTruthy();
    expect(screen.getAllByText(/\[FORECAST\]/).length).toBeGreaterThan(0);
    // The ledger exposes per-row, year-labeled estimates and says outright that there are no totals.
    expect(screen.getByText(/no totals/)).toBeTruthy();
  }, 30000);

  it('?view=costseg renders the study register, spec sheet, PCA cross-check and D1-D14 queue, with DERIVED/OCR/UNVERIFIED flags', async () => {
    renderModule('/property-condition?view=costseg');
    expect(await screen.findByText('Cost segregation property data', {}, { timeout: 20000 })).toBeTruthy();
    expect(screen.getByText('Study register & basis (read-only)')).toBeTruthy();
    expect(screen.getByText('6/6 allocations tie')).toBeTruthy();
    expect(screen.getByText(/Property spec sheet/)).toBeTruthy();
    expect(screen.getByText('PCA vs cost seg — quantity cross-check')).toBeTruthy();
    expect(screen.getByText('Cost seg discrepancy queue (D1–D14)')).toBeTruthy();
    expect(screen.getAllByText('Owner: unassigned')).toHaveLength(14);
    // Default study is Livingston: three roof surfaces and the GBA flag.
    expect(screen.getAllByText(/Roof — 3883 aluminum corrugated panel/).length).toBeGreaterThan(0);
    // The PCA side of the cross-check comes from the lazily loaded building-specs chunk (a second query), so wait for it.
    expect((await screen.findAllByText('differs', {}, { timeout: 20000 })).length).toBeGreaterThan(0);
    // The firewall statement is on the page.
    expect(screen.getByText(/not a condition assessment/i)).toBeTruthy();
  }, 40000);

  it('an UNREADABLE report renders as UNREADABLE with the path that was tried', () => {
    render(
      <CoverageCard
        rows={[{ reportId: 'R99', propertyLabel: 'Test Property', consultant: 'ACME', reportDate: '2010-01-01', status: 'UNREADABLE', ocr: false,
          pagesTotal: 0, pagesWithoutText: 0, facts: 0, findings: 0, factsByComponent: {}, pathTried: 'Business/Test/missing.pdf', notes: '' }]}
      />,
    );
    expect(screen.getByText('UNREADABLE')).toBeTruthy();
    expect(screen.getByText(/path tried: Business\/Test\/missing\.pdf/)).toBeTruthy();
    expect(screen.getByText(/1 unreadable/)).toBeTruthy();
  });

  it('?view=prices keeps contractor evidence and the consultant price book in separate, labeled cards', () => {
    renderModule('/property-condition?view=prices');
    expect(screen.getByText('Contractor quotes & awards')).toBeTruthy();
    expect(screen.getByText('Executed')).toBeTruthy();
    expect(screen.getByText('Unverified')).toBeTruthy();
    expect(screen.getByText('Estimate basis — not contractor prices')).toBeTruthy();
    expect(screen.getByText('Paving full-depth')).toBeTruthy();
  });

  it('?view=open lists the register items with severity badges', () => {
    renderModule('/property-condition?view=open');
    expect(screen.getByText('Register open items')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Info')).toBeTruthy();
    expect(screen.getByText('Portfolio')).toBeTruthy();
  });

  it('shows the import instruction when the warehouse is up but the register is not loaded', () => {
    renderModule('/property-condition', seededClient(report({ loaded: false, properties: [] })));
    expect(screen.getByText('not loaded')).toBeTruthy();
    expect(screen.getByText(/npm run warehouse:import-pca/)).toBeTruthy();
  });

  it('shows the offline card when the warehouse routes are unreachable (503, no baked mirror)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderModule('/property-condition', qc);
    // QUERY_OPTS retries once (1s backoff) before the query errors, so allow more than findBy's 1s default.
    expect(await screen.findByText('offline', {}, { timeout: 6000 })).toBeTruthy();
    expect(screen.getByText(/requires the live brain server/)).toBeTruthy();
  });
});

describe('property-condition display helpers', () => {
  it('badges', () => {
    expect(usabilityBadge('current')).toEqual({ label: 'Usable', tone: 'green' });
    expect(usabilityBadge('draft').tone).toBe('amber');
    expect(usabilityBadge('stale').tone).toBe('neutral');
    expect(warrantyBadge('expired').tone).toBe('red');
    expect(warrantyBadge('unknown').label).toBe('Not stated');
    expect(evidenceBadge('executed').tone).toBe('green');
    expect(evidenceBadge('budget').tone).toBe('amber');
  });

  it('age is a caveat: neutral to 5 yrs, amber 6–9, red 10+', () => {
    expect(ageTone(null)).toBe('neutral');
    expect(ageTone(5)).toBe('neutral');
    expect(ageTone(6)).toBe('amber');
    expect(ageTone(10)).toBe('red');
    expect(ageLabel(0)).toBe('<1 yr');
    expect(ageLabel(1)).toBe('1 yr');
    expect(ageLabel(19)).toBe('19 yrs');
    expect(ageLabel(null)).toBe('undated');
  });

  it('formats deltas, prices and partial dates without timezone math', () => {
    expect(fmtDeltaPct(-0.595)).toBe('−60%');
    expect(fmtDeltaPct(2.125)).toBe('+213%');
    expect(fmtDeltaPct(0.595)).toBe('+60%');
    expect(fmtDeltaPct(0)).toBe('+0%');
    expect(fmtDeltaPct(null)).toBe('—');
    expect(fmtPsf(9.1177)).toBe('$9.12');
    expect(fmtPsf(null)).toBe('—');
    expect(fmtPartialDate('2025-11-25')).toBe('25 Nov 2025');
    expect(fmtPartialDate('2025-11')).toBe('Nov 2025');
    expect(fmtPartialDate('2016')).toBe('2016');
    expect(fmtPartialDate(null)).toBe('—');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate(null, 5)).toBe('');
  });
});
