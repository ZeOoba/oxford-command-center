// tests/unit/property-financials-property-gaps.test.tsx — T8 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. Property-page gaps on the REAL
// committed dataset: the Explorer and the Scorecard row detail surface the data_quality items, partial
// lease reads and inferences relevant to the selected property ([INFERRED] marked); the module foot
// carries the data-health summary card; and Northwood never appears outside an exclusion disclosure
// on any rendered surface (every Explorer selection, every Scorecard detail, masthead, summary card).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PF_ENTITY_IDS, type PfEntityId } from '@contracts/property-financials';
import { buildEntityMapping } from '../../server/property-financials/mapping';
import { PropertyFinancialsModule } from '../../src/modules/property-financials/PropertyFinancialsModule';
import { PF_KEYS } from '../../src/modules/property-financials/hooks';
import { gapsForEntity } from '../../src/modules/property-financials/data-health';
import type { PfDatasetResponse } from '../../src/modules/property-financials/types';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();

function response(): PfDatasetResponse {
  return {
    availability: 'ok',
    readError: null,
    lastGoodLoadedAt: '2026-10-05T12:00:00.000Z',
    issues: [],
    meta: { version: D.meta.version, generated: D.meta.generated, as_of: D.meta.as_of, basis: 'cash', sha256: 'a'.repeat(64), csvSha256: 'b'.repeat(64), csvError: null, ageDays: 5, staleness: 'fresh' },
    dataset: D,
  };
}

function renderModule(search: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(PF_KEYS.dataset, response());
  qc.setQueryData(PF_KEYS.insightStatus, { records: [], orphanedIds: [] });
  qc.setQueryData(PF_KEYS.mapping, { availability: 'ok', rows: buildEntityMapping(PF_ENTITY_IDS, D.sf) });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/property-financials${search}`]}>
        <PropertyFinancialsModule />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function northwoodOutsideExclusions(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/northwood/i.test(n.textContent ?? '') && !n.parentElement?.closest('[data-exclusion]')) out.push(n.textContent ?? '');
  }
  return out;
}

const explorerGaps = () => screen.getByTestId('pf-explorer').querySelector('[data-testid="pf-gaps"]') as HTMLElement | null;
const gapItems = (root: HTMLElement | null) => (root ? [...root.querySelectorAll('li')].map((li) => li.textContent ?? '') : []);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Explorer — known gaps for the selected property', () => {
  it.each(PF_ENTITY_IDS.map((id) => [id]))('%s: lists exactly its matched gaps (FVC mapping shown once, in the Confirm flag)', (id) => {
    renderModule(`?view=explorer&p=${encodeURIComponent(id)}`);
    const expected = gapsForEntity(D, id as PfEntityId).filter((g) => g.source !== 'mapping');
    const items = gapItems(explorerGaps());
    expect(items).toHaveLength(expected.length);
    expected.forEach((g, i) => {
      expect(items[i]).toContain(g.text);
      expect(items[i]!.includes('[INFERRED]')).toBe(g.inferred);
    });
  });

  it('Westerville shows the missing-months item; 3540 E 5th shows its partial lease read', () => {
    renderModule('?view=explorer&p=3034%20Westerville');
    expect(gapItems(explorerGaps()).join(' ')).toMatch(/Westerville 2024-01 to 2024-08/);
    cleanup();
    renderModule('?view=explorer&p=3540%20E%205th');
    expect(gapItems(explorerGaps()).join(' ')).toMatch(/OCR of scan, first pages only/);
  });

  it('FVC: [INFERRED] on the Sepich items and the Confirm flag stays', () => {
    renderModule('?view=explorer&p=FVC');
    expect(gapItems(explorerGaps()).filter((t) => t.includes('[INFERRED]')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('pf-fvc-flag')).toBeTruthy();
  });

  it('every gap list links to the full data-health panel', () => {
    renderModule('?view=explorer&p=9620%20State%20350');
    const link = within(explorerGaps()!).getByRole('link', { name: /data health/i });
    expect(link.getAttribute('href')).toBe('/data?tab=quality&view=property-financials');
  });
});

describe('Scorecard row detail — known gaps', () => {
  function openRow(id: string) {
    const row = document.querySelector(`tr.pf-row[data-entity="${CSS.escape(id)}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    return screen.getByTestId(`pf-detail-${id}`);
  }

  it('55 New Plant: annual-only item + renewal clause not read', () => {
    renderModule('?view=scorecard');
    const items = gapItems(openRow('55 New Plant (EGFLLC)').querySelector('[data-testid="pf-gaps"]'));
    expect(items.join(' ')).toMatch(/entity-level annual QuickBooks/);
    expect(items.join(' ')).toMatch(/renewal clause not read/);
  });

  it('FVC: includes the square-footage inference itself, marked [INFERRED]', () => {
    renderModule('?view=scorecard');
    const items = gapItems(openRow('FVC').querySelector('[data-testid="pf-gaps"]'));
    expect(items).toHaveLength(gapsForEntity(D, 'FVC').length);
    expect(items.some((t) => t.includes('[INFERRED]') && t.includes('Inferred by reconciliation'))).toBe(true);
  });

  it('Livingston: missing months + reconciliation difference', () => {
    renderModule('?view=scorecard');
    const text = gapItems(openRow('3883 Livingston').querySelector('[data-testid="pf-gaps"]')).join(' ');
    expect(text).toMatch(/Livingston 2024-01 to 2025-05/);
    expect(text).toMatch(/Livingston FY2025 differs/);
  });
});

describe('module foot + Northwood', () => {
  it('the module foot carries the data-health summary card', () => {
    renderModule('');
    const card = screen.getByTestId('pf-dh-summary');
    expect(within(card).getByRole('link', { name: /data health/i }).getAttribute('href')).toBe('/data?tab=quality&view=property-financials');
    expect(card.textContent).toMatch(/3 SF flags/);
  });

  it('Northwood never appears outside an exclusion disclosure: masthead, summary, all 11 Explorer views, every Scorecard detail', () => {
    for (const id of PF_ENTITY_IDS) {
      const { container } = renderModule(`?view=explorer&p=${encodeURIComponent(id)}`);
      expect(northwoodOutsideExclusions(container), id).toEqual([]);
      cleanup();
    }
    const { container } = renderModule('?view=scorecard');
    for (const t of screen.getAllByRole('button', { expanded: false })) fireEvent.click(t);
    expect(PF_ENTITY_IDS.every((id) => screen.queryByTestId(`pf-detail-${id}`))).toBe(true);
    expect(northwoodOutsideExclusions(container)).toEqual([]);
    // The masthead still discloses the exclusion (read from meta.excluded).
    expect(container.querySelector('[data-exclusion]')?.textContent).toMatch(/2203-2207 Northwood excluded \(pending\)/);
  });
});
