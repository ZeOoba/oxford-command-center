// tests/unit/edge-pull-queue-ui.test.tsx — spec §8.6: write controls only when the warehouse is live;
// Mark done → POST with ORA_JSON_MUTATION_HEADERS; Undo → confirm → POST /:id/void; 503 → offline note.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EdgePullQueueResponse } from '@contracts/edge';
import { localIsoToday } from '../../src/modules/acquisitions/edge-hooks';
import { EdgePullQueue } from '../../src/modules/acquisitions/EdgePullQueue';
import { EDGE_KEYS } from '../../src/modules/acquisitions/edge-hooks';

const QUEUE: EdgePullQueueResponse = {
  today: '2026-10-02',
  automatedCoverage: { truck: ['MI', 'VA'] },
  items: [
    {
      kind: 'storage', label: 'Self-storage asking rates', cadenceDays: 90, cadenceLabel: 'Quarterly', scopeType: 'market',
      why: 'Storage rates are the space-scarcity proxy.', caveat: "Today's rate only — record a baseline.",
      counts: { open: 1, due: 0, current: 1 },
      scopes: [
        { scopeKey: 'columbus', scopeLabel: 'Columbus, OH', state: 'open', lastDoneOn: null, lastNote: null, lastLogId: null, ageDays: null,
          links: [{ label: 'StorageCafe', url: 'https://www.storagecafe.com/self-storage-rates/columbus-oh/' }], blocker: null },
        { scopeKey: 'richmond', scopeLabel: 'Richmond, VA', state: 'current', lastDoneOn: '2026-09-01', lastNote: 'baseline $1.10/SF', lastLogId: 7, ageDays: 31,
          links: [], blocker: null },
      ],
    },
  ],
};

function renderQueue({ live, seed = true }: { live: boolean; seed?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } } });
  if (seed) qc.setQueryData(EDGE_KEYS.pullQueue, QUEUE);
  qc.setQueryData(['warehouse', 'live-probe'], live ? true : undefined);
  return render(<QueryClientProvider client={qc}><EdgePullQueue /></QueryClientProvider>);
}

/** Mutation POSTs only (the success path also refetches the queue with a GET). */
const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
const itemJson = () => new Response(JSON.stringify(QUEUE.items[0]), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // The live probe (GET /api/warehouse/noi) answers 503 so a non-seeded probe reads "not live";
  // every other call (the mutations) answers with the updated item.
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).includes('/noi')
      ? new Response(JSON.stringify({ error: 'warehouse unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
      : itemJson()));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('EdgePullQueue', () => {
  it('renders the card with cadence, counts, caveat and automated coverage', () => {
    renderQueue({ live: false });
    expect(screen.getByText('Self-storage asking rates · Quarterly')).toBeTruthy();
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(screen.getByText('1 current')).toBeTruthy();
    expect(screen.getByText("Today's rate only — record a baseline.")).toBeTruthy();
    expect(screen.getByText('Truck AADT automated (not queued): MI, VA')).toBeTruthy();
    expect(document.getElementById('edge-pull-storage')).not.toBeNull();
  });

  it('hides write controls when the warehouse is not live', () => {
    renderQueue({ live: false });
    expect(screen.queryByRole('button', { name: /mark .* done/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
  });

  it('Mark done posts RecordPullRequest with the client header', async () => {
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.change(screen.getByLabelText('Done on'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: ' baseline $1.05/SF ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/warehouse/edge/pull-queue');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['X-ORA-Client']).toBe('1');
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', note: 'baseline $1.05/SF' });
  });

  it('Undo asks for confirmation, then voids (never deletes)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Undo Richmond, VA' }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo Richmond, VA' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(2);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/warehouse/edge/pull-queue/7/void');
    expect(init?.method).toBe('POST');
  });

  it('503 → Warehouse offline — pull status unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'warehouse unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })));
    renderQueue({ live: false, seed: false });
    expect(await screen.findByText('Warehouse offline — pull status unavailable')).toBeTruthy();
  });

  it('defaults the date to the local date, caps it at today, and shows an offline-safe control set', () => {
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    const date = screen.getByLabelText('Done on') as HTMLInputElement;
    expect(date.value).toBe(localIsoToday());
    expect(date.max).toBe(localIsoToday());
  });

  it('shows a server rejection readably, announces it, and re-enables the controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('/noi')
        ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'doneOn cannot be in the future' }), { status: 400, headers: { 'content-type': 'application/json' } })));
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('doneOn cannot be in the future');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('never dumps a raw parse error: a malformed 200 body reads "Could not save"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('/noi')
        ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not save');
  });

  it('uses void wording only, and external links are rel-hardened vetted hosts', () => {
    renderQueue({ live: true });
    expect(screen.getByRole('button', { name: 'Undo Richmond, VA' })).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/delete/i);
    const link = screen.getByRole('link', { name: 'StorageCafe' }) as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.href).toBe('https://www.storagecafe.com/self-storage-rates/columbus-oh/');
  });

  it('drops a link whose host is not on the vetted list', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    const q = structuredClone(QUEUE);
    q.items[0]!.scopes[0]!.links = [
      { label: 'Evil', url: 'https://evil.example.com/x' },
      { label: 'Script', url: 'javascript:alert(1)' },
      { label: 'StorageCafe', url: 'https://www.storagecafe.com/self-storage-rates/columbus-oh/' },
    ];
    qc.setQueryData(EDGE_KEYS.pullQueue, q);
    qc.setQueryData(['warehouse', 'live-probe'], false);
    render(<QueryClientProvider client={qc}><EdgePullQueue /></QueryClientProvider>);
    expect(screen.queryByRole('link', { name: 'Evil' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Script' })).toBeNull();
    expect(screen.getByRole('link', { name: 'StorageCafe' })).toBeTruthy();
  });

  it('renders an alert when the queue query fails (non-503) and an empty note for no items', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderQueue({ live: false, seed: false });
    await vi.advanceTimersByTimeAsync(1500); // the hook retries a real failure once (default 1 s delay)
    const alert = await screen.findByRole('alert');
    vi.useRealTimers();
    expect(alert.textContent).toBe('Unable to load the pull queue. Try again shortly.');
    expect(alert.textContent).not.toContain('Could not save');
    expect(alert.textContent).not.toContain('boom');
    cleanup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    qc.setQueryData(EDGE_KEYS.pullQueue, { today: '2026-10-02', automatedCoverage: { truck: [] }, items: [] });
    qc.setQueryData(['warehouse', 'live-probe'], false);
    render(<QueryClientProvider client={qc}><EdgePullQueue /></QueryClientProvider>);
    expect(screen.getByText('No manual pulls are queued.')).toBeTruthy();
  });

  it('a future date shows an inline hint and keeps Save disabled', () => {
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    expect(screen.queryByText('The done date cannot be in the future.')).toBeNull();
    fireEvent.change(screen.getByLabelText('Done on'), { target: { value: '2999-01-01' } });
    expect(screen.getByText('The done date cannot be in the future.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Cancel clears a mutation error and closes the form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'doneOn cannot be in the future' }), { status: 400, headers: { 'content-type': 'application/json' } })));
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByLabelText('Done on')).toBeNull();
  });

  it('a 5xx body string is replaced by a generic message (no server internals rendered)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'disk I/O error at /data/finance.sqlite' }), { status: 500, headers: { 'content-type': 'application/json' } })));
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The server could not complete that request. Try again shortly.');
    expect(alert.textContent).not.toMatch(/disk|sqlite/i);
  });

  it('Enter-key submit (form submit event) posts once', async () => {
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.change(screen.getByLabelText('Done on'), { target: { value: '2026-09-30' } });
    fireEvent.submit(screen.getByLabelText('Done on').closest('form')!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]?.body))).toMatchObject({ scopeKey: 'columbus', doneOn: '2026-09-30' });
  });

  it('a second submit while the first is pending does not post again', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    const form = screen.getByLabelText('Done on').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(posts()).toHaveLength(1);
  });

  it('the form resets after success: reopening starts from the default date and an empty note', async () => {
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.change(screen.getByLabelText('Done on'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'first note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Done on')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    expect((screen.getByLabelText('Done on') as HTMLInputElement).value).toBe(localIsoToday());
    expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toBe('');
  });

  it('shows a busy loading state before the queue arrives', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { container } = renderQueue({ live: false, seed: false });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe('fix-pass 3 - mutation plumbing (B5) and busy guard (B7)', () => {
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const queueGets = () =>
    vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u) === '/api/warehouse/edge/pull-queue' && (init?.method ?? 'GET') === 'GET');

  it('record POST sends content-type application/json AND X-ORA-Client, then invalidates (a second GET fires)', async () => {
    renderQueue({ live: true });
    expect(queueGets()).toHaveLength(0); // seeded: nothing fetched yet
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.change(screen.getByLabelText('Done on'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const headers = posts()[0]![1]?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['X-ORA-Client']).toBe('1');
    await waitFor(() => expect(queueGets()).toHaveLength(1)); // invalidation refetched the queue
  });

  it('void POST sends X-ORA-Client, then invalidates (a second GET fires)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Undo Richmond, VA' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect((posts()[0]![1]?.headers as Record<string, string>)['X-ORA-Client']).toBe('1');
    await waitFor(() => expect(queueGets()).toHaveLength(1));
  });

  it('while a save is pending: Save and the row actions are disabled, and a repeat submit posts nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    const form = screen.getByLabelText('Done on').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: 'Mark Columbus, OH done' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Undo Richmond, VA' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    await settle(); // a mutation invokes fetch asynchronously: wait before asserting nothing was posted
    expect(posts()).toHaveLength(1);
  });

  it('a pending void blocks a save submit (the guard covers both mutations)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    const form = screen.getByLabelText('Done on').closest('form')!;
    // start a void on another row, then try to submit the open form
    fireEvent.click(screen.getByRole('button', { name: 'Undo Richmond, VA' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.submit(form);
    await settle(); // a mutation invokes fetch asynchronously: wait before asserting nothing was posted
    expect(posts()).toHaveLength(1);
  });
});
