// tests/unit/documents-tabs.test.tsx
//
// IA decongestion Phase 3/4a — Documents has two views, Search · Corpus. Since Phase 4a it is a tab
// of the Data destination, which owns the tab strip, so the inner switch is a SegmentedControl on
// `?view=` (rule R5: no nested tab strips). The KPI strip stays above the switch (R2). Both views
// stay mounted (the inactive one is `hidden`) so the semantic-search query, folder filter and
// results survive a view round-trip. The "mirror is read-only" / "brain server unavailable" hints
// are unchanged.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DocumentsModule } from '../../src/modules/documents/DocumentsModule';

/** A view is hidden when it sits inside a `hidden` container. */
const isHidden = (el: Element) => el.closest('[hidden]') !== null;
const selectView = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
const viewIsSelected = (name: string) => (screen.getByRole('radio', { name }) as HTMLInputElement).checked;

const STATUS = {
  configured: true,
  dir: 'C:/docs',
  documents: 2,
  chunks: 9,
  docs: [{ name: 'lease-a.pdf', chunks: 5 }, { name: 'psa-b.pdf', chunks: 4 }],
};
const HITS = [
  { docId: 'd1', chunkIdx: 0, doc: 'Tenant 155 LLC/lease.pdf', snippet: 'renewal option of five years', score: 0.9 },
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

describe('DocumentsModule — Search/Corpus views', () => {
  it('Search is the default tab, with the query box and the Ask CTA visible', () => {
    renderDocs();
    expect(screen.queryAllByRole('tab')).toHaveLength(0); // R5: no nested tab strip
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['search', 'corpus']);
    expect(viewIsSelected('Search')).toBe(true);
    expect(isHidden(screen.getByLabelText('Semantic document search'))).toBe(false);
    expect(isHidden(screen.getByRole('button', { name: /ask a document question/i }))).toBe(false);
  });

  it('keeps the KPI strip above the switch on every view', () => {
    renderDocs('/?view=corpus');
    expect(isHidden(screen.getByText('Documents Indexed'))).toBe(false);
  });

  it('the Corpus list is hidden until its view is selected, then reachable', async () => {
    renderDocs();
    const heading = screen.getByText('Document Corpus');
    expect(isHidden(heading)).toBe(true);
    expect(isHidden(screen.getByText('Semantic Search'))).toBe(false);
    selectView('Corpus');
    expect(isHidden(heading)).toBe(false);
    expect(await screen.findByText('lease-a.pdf')).toBeTruthy();
    expect(isHidden(screen.getByText('lease-a.pdf'))).toBe(false);
    expect(isHidden(screen.getByText('Semantic Search'))).toBe(true);
  });

  it('?view=corpus deep-links to Corpus; an unknown view falls back to Search; the outer ?tab= is ignored', () => {
    renderDocs('/?view=corpus');
    expect(viewIsSelected('Corpus')).toBe(true);
    expect(isHidden(screen.getByText('Document Corpus'))).toBe(false);
    cleanup();
    renderDocs('/?view=bogus');
    expect(viewIsSelected('Search')).toBe(true);
    cleanup();
    renderDocs('/?tab=documents'); // the Data destination's own tab param must not drive the inner switch
    expect(viewIsSelected('Search')).toBe(true);
  });

  it('keeps the mirror-safe fallback hint on the Corpus tab when the Brain Server is unreachable', async () => {
    stubFetch('offline');
    renderDocs('/?view=corpus');
    expect(await screen.findByText(/runs on the local Brain Server, not the read-only mirror/)).toBeTruthy();
    expect(screen.getByText('Mirror — read-only')).toBeTruthy();
  });

  it('state survives a tab round-trip: search query, results and folder filter', async () => {
    renderDocs();
    fireEvent.change(screen.getByLabelText('Semantic document search'), { target: { value: 'renewal option' } });
    await waitFor(() => expect(screen.getByText('Tenant 155 LLC/lease.pdf')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Tenant 155 LLC' })); // folder chip → filters to that folder
    expect(screen.queryByText('Widgets/psa.pdf')).toBeNull();

    selectView('Corpus');
    selectView('Search');

    expect((screen.getByLabelText('Semantic document search') as HTMLInputElement).value).toBe('renewal option');
    expect(screen.getByText('Tenant 155 LLC/lease.pdf')).toBeTruthy();
    expect(screen.queryByText('Widgets/psa.pdf')).toBeNull();
  });
});
