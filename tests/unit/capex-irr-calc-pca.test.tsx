// tests/unit/capex-irr-calc-pca.test.tsx
//
// Phase 4: the Capex IRR calculator's opt-in "Include PCA near-term repairs" line, and the pure
// pcaNearTermForProperty helper behind it. Same cache-seeding pattern as capex-irr-calc.test.tsx
// (no network, no module mocking — vitest runs with isolate:false here).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CapexIrrCalc } from '../../src/modules/intel/CapexIrrCalc';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import type { SnapshotResponse } from '../../src/data/client';
import { GOVERNOR_FALLBACK } from '@contracts/index';
import type { PropertyConditionReport } from '../../src/contracts/property-condition';
import { PROPERTY_CONDITION_KEYS, pcaNearTermForProperty } from '../../src/modules/property-condition/hooks';

type Prop = PropertyConditionReport['properties'][number];

function prop(over: Partial<Prop> & { propertyKey: string; propertyMasterId: string | null }, cur: Partial<Prop['current']> = {}): Prop {
  return {
    propertyLabel: over.propertyKey,
    history: [],
    ageYears: 1,
    reservesPsfYr: null,
    hasDollarFigures: true,
    ...over,
    current: {
      reportId: `R-${over.propertyKey}`, reportDate: '2026-04-07', consultant: 'Intertek', usabilityClass: 'current', usabilityRaw: null,
      sf: 10000, immediateUsd: 20000, shortTermUsd: 30000, reservesUninflUsd: null, reservesInflUsd: null, termYears: 12, psfYrStated: null,
      notes: null, ...cur,
    },
  };
}

function report(properties: Prop[], loaded = true): PropertyConditionReport {
  return {
    asOf: '2026-10-07', loaded, properties,
    totals: { propertiesTotal: properties.length, propertiesWithFigures: properties.length, immediateUsd: 0, shortTermUsd: 0, reservesUninflUsd: 0 },
    schedule: [], lifecycle: [], calibration: [], quotes: [], priceBook: [], openItems: [],
  };
}

function seededClient(pca?: PropertyConditionReport): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const response: SnapshotResponse = {
    snapshot: { governors: { ...GOVERNOR_FALLBACK, hurdleRatePct: 0.08, hurdleRateRatification: 'ratified' } } as unknown as SnapshotResponse['snapshot'],
    state: { status: 'ready' } as unknown as SnapshotResponse['state'],
  };
  qc.setQueryData(SNAPSHOT_KEY, response);
  if (pca) qc.setQueryData(PROPERTY_CONDITION_KEYS.report, pca);
  return qc;
}

function renderPanel(propertyId: string | undefined, pca?: PropertyConditionReport) {
  return render(
    <QueryClientProvider client={seededClient(pca)}>
      <CapexIrrCalc capitalAction="invest" propertyName="Prop A" propertyId={propertyId} />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('pcaNearTermForProperty', () => {
  it('sums immediate + Yr 1–2 over the current report(s) mapped to the master id', () => {
    const r = report([
      prop({ propertyKey: 'banwick', propertyMasterId: 'sepich' }, { immediateUsd: 1050, shortTermUsd: null, reportDate: '2026-04-07' }),
      prop({ propertyKey: 'fairground', propertyMasterId: 'sepich' }, { immediateUsd: 3000, shortTermUsd: 66210, reportDate: '2013-08-12' }),
      prop({ propertyKey: 'other', propertyMasterId: 'prop-x' }, { immediateUsd: 999999 }),
    ]);
    const n = pcaNearTermForProperty(r, 'sepich')!;
    expect(n.dollars).toBe(70260);
    expect(n.immediateUsd).toBe(4050);
    expect(n.shortTermUsd).toBe(66210);
    expect(n.reportCount).toBe(2);
    expect(n.consultant).toBeNull(); // several reports roll up
    expect(n.reportDate).toBe('2013-08-12'); // oldest — a 13-year-old report is still the newest for that key
  });

  it('drops a portfolio-scope report when building reports exist (no double count, same as the engine)', () => {
    const r = report([
      prop({ propertyKey: 'sepich-portfolio', propertyMasterId: 'm' }, { immediateUsd: 500000, shortTermUsd: null }),
      prop({ propertyKey: 'banwick', propertyMasterId: 'm' }, { immediateUsd: 150000, shortTermUsd: null }),
    ]);
    expect(pcaNearTermForProperty(r, 'm')!.dollars).toBe(150000);
    const only = report([prop({ propertyKey: 'sepich-portfolio', propertyMasterId: 'm' }, { immediateUsd: 500000, shortTermUsd: null })]);
    expect(pcaNearTermForProperty(only, 'm')!.dollars).toBe(500000);
  });

  it('reports the consultant for a single report and tolerates a missing short-term figure', () => {
    const n = pcaNearTermForProperty(report([prop({ propertyKey: 'a', propertyMasterId: 'prop-a' }, { immediateUsd: 500, shortTermUsd: null })]), 'prop-a')!;
    expect(n).toMatchObject({ dollars: 500, consultant: 'Intertek', reportCount: 1 });
  });

  it('is null when there is nothing to add: no report, not loaded, no id, no match, no dollars, or all-zero', () => {
    const r = report([prop({ propertyKey: 'a', propertyMasterId: 'prop-a' }, { immediateUsd: null, shortTermUsd: null })]);
    expect(pcaNearTermForProperty(undefined, 'prop-a')).toBeNull();
    expect(pcaNearTermForProperty(report([], false), 'prop-a')).toBeNull();
    expect(pcaNearTermForProperty(r, null)).toBeNull();
    expect(pcaNearTermForProperty(r, 'prop-zzz')).toBeNull();
    expect(pcaNearTermForProperty(r, 'prop-a')).toBeNull();
    expect(pcaNearTermForProperty(report([prop({ propertyKey: 'z', propertyMasterId: 'prop-a' }, { immediateUsd: 0, shortTermUsd: 0 })]), 'prop-a')).toBeNull();
  });

  it('an undated covered report leaves the oldest date null rather than guessing', () => {
    const r = report([
      prop({ propertyKey: 'a', propertyMasterId: 'm' }, { reportDate: null }),
      prop({ propertyKey: 'b', propertyMasterId: 'm' }, { reportDate: '2026-04-07' }),
    ]);
    expect(pcaNearTermForProperty(r, 'm')!.reportDate).toBeNull();
  });
});

describe('CapexIrrCalc — PCA near-term repairs line', () => {
  const pca = report([prop({ propertyKey: 'a', propertyMasterId: 'prop-a' }, { immediateUsd: 20000, shortTermUsd: 30000 })]);

  it('shows an UNCHECKED opt-in with the dollar amount and basis when the property has a PCA on file', () => {
    renderPanel('prop-a', pca);
    const box = screen.getByLabelText(/Include PCA near-term repairs/) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/capex floor \(\$50,000\)/)).toBeTruthy();
    expect(screen.getByText(/Immediate \$20,000 \+ Yr 1–2 \$30,000/)).toBeTruthy();
    expect(screen.queryByText(/Total capex modeled/)).toBeNull();
  });

  it('checking it floors the modeled capex at the PCA near-term total: a larger PCA lowers the IRR, a smaller one changes nothing', () => {
    const big = report([prop({ propertyKey: 'a', propertyMasterId: 'prop-a' }, { immediateUsd: 100000, shortTermUsd: 50000 })]);
    renderPanel('prop-a', big);
    const irrBefore = screen.getByText('IRR').nextElementSibling!.textContent;
    fireEvent.click(screen.getByLabelText(/Include PCA near-term repairs/));
    expect(screen.getByText('Total capex modeled: $150,000')).toBeTruthy(); // PCA $150k exceeds the $100k default
    const irrWith = screen.getByText('IRR').nextElementSibling!.textContent;
    expect(irrWith).not.toBe(irrBefore);
    fireEvent.click(screen.getByLabelText(/Include PCA near-term repairs/));
    expect(screen.getByText('IRR').nextElementSibling!.textContent).toBe(irrBefore);
    cleanup();
    renderPanel('prop-a', pca); // PCA $50k is below the $100k default capex
    const irrSmall = screen.getByText('IRR').nextElementSibling!.textContent;
    fireEvent.click(screen.getByLabelText(/Include PCA near-term repairs/));
    expect(screen.getByText('Total capex modeled: $100,000')).toBeTruthy();
    expect(screen.getByText('IRR').nextElementSibling!.textContent).toBe(irrSmall);
  });

  it('renders nothing extra without a propertyId, for a property with no PCA, or before the register is loaded', () => {
    renderPanel(undefined, pca);
    expect(screen.queryByLabelText(/Include PCA near-term repairs/)).toBeNull();
    cleanup();
    renderPanel('prop-none', pca);
    expect(screen.queryByLabelText(/Include PCA near-term repairs/)).toBeNull();
    cleanup();
    renderPanel('prop-a', report([], false));
    expect(screen.queryByLabelText(/Include PCA near-term repairs/)).toBeNull();
  });
});
