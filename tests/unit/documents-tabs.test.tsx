// tests/unit/documents-tabs.test.tsx
//
// IA decongestion Phase 3 — the single-scroll Documents module is tabbed: Search · Corpus. The KPI
// strip stays above the strip (R2). Both panels are force-mounted so the semantic-search query,
// folder filter and results survive a tab round-trip. The "mirror is read-only" / "brain server
// unavailable" hints are unchanged.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DocumentsModule } from '../../src/modules/documents/DocumentsModule';
import { inactivePanelIsHiddenByClass, isInInactivePanel, selectTab, tabIsSelected } from './tab-test-utils';

const STATUS = {
  configured: true,
  dir: 'C:/docs',
  documents: 2,
  chunks: 9,
  docs: [{ name: 'lease-a.pdf', chunks: 5 }, { name: 'psa-b.pdf', chunks: 4 }],
};
const HITS = [
  { docId: 'd1', chunkIdx: 0, doc: 'Eurosort/lease.pdf', snippet: 'renewal option of five years', score: 0.9 },
  { docId: 'd2', chunkIdx: 0, doc: 'Widgets/psa.pdf', snippet: 'renewal option in the PSA', score: 0.8 },
];

function stubFetch(mode: 'live' | 'offline') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (mode === 'offline') return new Response('{}', { status: 503 });
    if (String(url).startsWith('/api/documents/search')) return new Response(JSON.stringify({ hits: HITS }), { status: 200 });
    return new Response(JSON.stringify(STATUS), { status: 200 });
  }));
}

function renderDocs(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <DocumentsModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => stubFetch('live'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DocumentsModule — Phase 3 tabs', () => {
  it('Search is the default tab, with the query box and the Ask CTA visible', () => {
    renderDocs();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Search', 'Corpus']);
    expect(tabIsSelected('Search')).toBe(true);
    expect(isInInactivePanel(screen.getByLabelText('Semantic document search'))).toBe(false);
    expect(isInInactivePanel(screen.getByRole('button', { name: /ask a document question/i }))).toBe(false);
  });

  it('keeps the KPI strip above the tab strip on every tab', () => {
    renderDocs('/?tab=corpus');
    expect(screen.getByText('Documents Indexed').closest('[role="tabpanel"]')).toBeNull();
    expect(isInInactivePanel(screen.getByText('Documents Indexed'))).toBe(false);
  });

  it('the Corpus list is hidden until its tab is selected, then reachable', async () => {
    renderDocs();
    const heading = screen.getByText('Document Corpus');
    expect(isInInactivePanel(heading)).toBe(true);
    expect(inactivePanelIsHiddenByClass(heading)).toBe(true);
    expect(isInInactivePanel(screen.getByText('Semantic Search'))).toBe(false);
    selectTab('Corpus');
    expect(isInInactivePanel(heading)).toBe(false);
    expect(await screen.findByText('lease-a.pdf')).toBeTruthy();
    expect(isInInactivePanel(screen.getByText('lease-a.pdf'))).toBe(false);
    expect(isInInactivePanel(screen.getByText('Semantic Search'))).toBe(true);
  });

  it('?tab=corpus deep-links to Corpus; an unknown tab falls back to Search', () => {
    renderDocs('/?tab=corpus');
    expect(tabIsSelected('Corpus')).toBe(true);
    expect(isInInactivePanel(screen.getByText('Document Corpus'))).toBe(false);
    cleanup();
    renderDocs('/?tab=bogus');
    expect(tabIsSelected('Search')).toBe(true);
  });

  it('keeps the mirror-safe fallback hint on the Corpus tab when the Brain Server is unreachable', async () => {
    stubFetch('offline');
    renderDocs('/?tab=corpus');
    expect(await screen.findByText(/runs on the local Brain Server, not the read-only mirror/)).toBeTruthy();
    expect(screen.getByText('Mirror — read-only')).toBeTruthy();
  });

  it('state survives a tab round-trip: search query, results and folder filter', async () => {
    renderDocs();
    fireEvent.change(screen.getByLabelText('Semantic document search'), { target: { value: 'renewal option' } });
    await waitFor(() => expect(screen.getByText('Eurosort/lease.pdf')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Eurosort' })); // folder chip → filters to that folder
    expect(screen.queryByText('Widgets/psa.pdf')).toBeNull();

    selectTab('Corpus');
    selectTab('Search');

    expect((screen.getByLabelText('Semantic document search') as HTMLInputElement).value).toBe('renewal option');
    expect(screen.getByText('Eurosort/lease.pdf')).toBeTruthy();
    expect(screen.queryByText('Widgets/psa.pdf')).toBeNull();
  });
});
