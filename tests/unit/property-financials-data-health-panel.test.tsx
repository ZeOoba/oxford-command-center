// tests/unit/property-financials-data-health-panel.test.tsx — T8 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The live data-health panel (Data
// destination) and its summary card (foot of the Property Financials module), rendered from the REAL
// committed dataset and the REAL server mapping (buildEntityMapping over CANON_PROPERTIES):
//   - every data_quality item, the NOI-basis disclosure, version / generated / as_of / basis / sha
//   - the entity → canonical id table: 11 rows, FVC inferred + confirm-me, 3 SF flags
//   - freshness: stale renders an icon + a label (never colour alone)
//   - Northwood appears only inside exclusion disclosures
//   - unreachable / invalid API → an honest error state, no figures
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PF_ENTITY_IDS } from '@contracts/property-financials';
import { buildEntityMapping, ENTITY_TO_CANONICAL } from '../../server/property-financials/mapping';
import { buildLiveSf, type LiveSfSnapshot } from '../../server/property-financials/live-sf';
import { PfDataHealthPanel, PfDataHealthSummary } from '../../src/modules/property-financials/DataHealthPanel';
import { PF_KEYS, parseMappingResponse } from '../../src/modules/property-financials/hooks';
import { NOI_DISCLOSURE } from '../../src/modules/property-financials/data-health';
import type { PfDatasetResponse, PfMappingResponse } from '../../src/modules/property-financials/types';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();
const SHA = 'ab12cd34ef56'.padEnd(64, '0');
const CSV_SHA = '9988776655aa'.padEnd(64, '1');

function response(over: Partial<PfDatasetResponse> = {}): PfDatasetResponse {
  return {
    availability: 'ok',
    readError: null,
    lastGoodLoadedAt: '2026-10-05T12:00:00.000Z',
    issues: [],
    meta: { version: D.meta.version, generated: D.meta.generated, as_of: D.meta.as_of, basis: 'cash', sha256: SHA, csvSha256: CSV_SHA, csvError: null, ageDays: 5, staleness: 'fresh' },
    dataset: D,
    ...over,
  };
}
const MAPPING: PfMappingResponse = { availability: 'ok', rows: buildEntityMapping(PF_ENTITY_IDS, D.sf) };

function client(data: PfDatasetResponse | null, mapping: PfMappingResponse | null = MAPPING) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  if (data) qc.setQueryData(PF_KEYS.dataset, data);
  if (mapping) qc.setQueryData(PF_KEYS.mapping, mapping);
  return qc;
}

function renderPanel(data: PfDatasetResponse | null = response(), mapping: PfMappingResponse | null = MAPPING) {
  return render(
    <QueryClientProvider client={client(data, mapping)}>
      <MemoryRouter>
        <PfDataHealthPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Every text node mentioning Northwood must sit inside an element marked as an exclusion disclosure. */
function northwoodOutsideExclusions(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/northwood/i.test(n.textContent ?? '') && !n.parentElement?.closest('[data-exclusion]')) out.push(n.textContent ?? '');
  }
  return out;
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PfDataHealthPanel — live data health (replaces the artifact’s static “Command center data” tab)', () => {
  it('shows version, generated, as_of, basis and the short dataset + CSV sha256', () => {
    renderPanel();
    const facts = screen.getByTestId('pf-dh-facts');
    expect(within(facts).getByText(D.meta.version)).toBeTruthy();
    expect(within(facts).getByText(/5 Oct 2026/)).toBeTruthy();
    expect(within(facts).getAllByText(/30 Sep 2026/).length).toBeGreaterThan(0);
    expect(within(facts).getByText(/cash/i)).toBeTruthy();
    const sha = within(facts).getByText('ab12cd34ef56');
    expect(sha.getAttribute('title')).toBe(SHA);
    expect(within(facts).getByText('9988776655aa').getAttribute('title')).toBe(CSV_SHA);
  });

  it('carries the NOI-definition disclosure verbatim', () => {
    renderPanel();
    expect(screen.getByTestId('pf-dh-noi').textContent).toBe(NOI_DISCLOSURE);
  });

  it('renders every data_quality item from the dataset, in order', () => {
    renderPanel();
    const items = within(screen.getByTestId('pf-dh-quality')).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(D.data_quality);
  });

  it('fresh state: icon + "Fresh" label', () => {
    renderPanel();
    const f = screen.getByTestId('pf-dh-freshness');
    expect(f.textContent).toMatch(/Fresh/);
    expect(f.querySelector('svg')).not.toBeNull();
  });

  it('stale state: icon + "Stale" label + age, announced as status — never colour alone', () => {
    renderPanel(response({ meta: { ...response().meta!, ageDays: 45, staleness: 'stale' } }));
    const f = screen.getByTestId('pf-dh-freshness');
    expect(f.getAttribute('role')).toBe('status');
    expect(f.textContent).toMatch(/Stale/);
    expect(f.textContent).toMatch(/45 days/);
    expect(f.querySelector('svg')).not.toBeNull();
  });

  it('F5: a future as-of reads Stale with the server reason, never a negative day count', () => {
    renderPanel(response({ meta: { ...response().meta!, ageDays: -2, staleness: 'stale', stalenessReason: 'as-of date is in the future' } }));
    const f = screen.getByTestId('pf-dh-freshness');
    expect(f.textContent).toBe(`Stale · as-of date is in the future (${'30 Sep 2026'}); not current`);
    expect(f.textContent).not.toMatch(/-2/);
  });

  it('F5: one day ahead (inside the clock slack) reads Fresh with the date, never "-1 days"', () => {
    renderPanel(response({ meta: { ...response().meta!, ageDays: -1, staleness: 'fresh', stalenessReason: null } }));
    const f = screen.getByTestId('pf-dh-freshness');
    expect(f.textContent).toBe('Fresh · as of 30 Sep 2026');
  });

  it('a CSV hash failure shows the sanitized error instead of a sha', () => {
    renderPanel(response({ meta: { ...response().meta!, csvSha256: null, csvError: 'monthly-long.csv: read failed (EBUSY)' } }));
    expect(within(screen.getByTestId('pf-dh-facts')).getByText(/read failed \(EBUSY\)/)).toBeTruthy();
  });

  it('an absent audit CSV (local-only by policy) says so plainly — no errno, no error styling', () => {
    renderPanel(response({ meta: { ...response().meta!, csvSha256: null, csvError: 'monthly-long.csv: stat failed (ENOENT)' } }));
    const facts = within(screen.getByTestId('pf-dh-facts'));
    const cell = facts.getByText('Audit CSV not present on this machine (kept off the remote by policy); regenerate with the refresh pipeline');
    expect(cell.className).not.toMatch(/pf-neg/);
    expect(facts.queryByText(/ENOENT|stat failed/)).toBeNull();
  });

  it('a failed re-read is disclosed (serving last good copy)', () => {
    renderPanel(response({ readError: 'dataset.json is not valid JSON' }));
    expect(screen.getByText(/last good copy/i).textContent).toMatch(/not valid JSON/);
  });

  it('mapping table: 11 rows, FVC inferred + confirm-me, 3 SF-disagreement flags, nothing else flagged', () => {
    renderPanel();
    const table = screen.getByRole('table', { name: /entity to canonical property id/i });
    const rows = within(table).getAllByTestId('pf-map-row');
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.getAttribute('data-entity'))).toEqual([...PF_ENTITY_IDS]);
    const fvc = rows.find((r) => r.getAttribute('data-entity') === 'FVC')!;
    expect(fvc.textContent).toMatch(/\[INFERRED\]/);
    expect(fvc.textContent).toMatch(/Confirm me/);
    expect(fvc.textContent).toMatch(/sepich-portfolio-columbus-oh-8-props/);
    const sfFlags = within(table).getAllByTestId('pf-map-sf-flag');
    expect(sfFlags).toHaveLength(3);
    expect(sfFlags.map((f) => f.closest('tr')!.getAttribute('data-entity'))).toEqual(['3034 Westerville', '9620 State 350', 'FVC']);
    expect(sfFlags[0]!.textContent).toMatch(/18,360.*18,000/);
    expect(within(table).queryAllByText(/\[INFERRED\]/)).toHaveLength(1);
    expect(within(table).queryByText(/Unmatched/)).toBeNull();
  });

  it('an unmatched entity is flagged with a label, not just a blank id', () => {
    const rows = MAPPING.rows.map((r) => (r.entity === '1100 Rarig' ? { ...r, canonicalId: null, method: 'unmatched' as const, flags: [{ code: 'UNMATCHED', detail: 'no ratified mapping for this entity' }] } : r));
    renderPanel(response(), { availability: 'ok', rows });
    const row = screen.getAllByTestId('pf-map-row').find((r) => r.getAttribute('data-entity') === '1100 Rarig')!;
    expect(row.textContent).toMatch(/Unmatched/);
    expect(row.textContent).toMatch(/no ratified mapping/);
  });

  it('offers a print action for the mapping deliverable', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    renderPanel();
    screen.getByRole('button', { name: /print mapping table/i }).click();
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('Northwood: the exclusion is read from meta.excluded and is the only place it appears', () => {
    const { container } = renderPanel();
    const ex = screen.getByTestId('pf-dh-excluded');
    expect(ex.textContent).toMatch(/2203-2207 Northwood excluded \(pending\)/);
    expect(northwoodOutsideExclusions(container)).toEqual([]);
    expect(screen.getAllByTestId('pf-map-row').some((r) => /northwood/i.test(r.textContent ?? ''))).toBe(false);
  });

  it('lists the leases that belong to no dataset entity (Fishel, Sunburst)', () => {
    renderPanel();
    const u = screen.getByTestId('pf-dh-unattached');
    expect(u.textContent).toMatch(/7658 Fishel/);
    expect(u.textContent).toMatch(/401 Sunburst Highway/);
  });

  it('API unreachable: an honest error state with no figures', async () => {
    renderPanel(null, null);
    expect(await screen.findByRole('heading', { name: /data health is local-only/i })).toBeTruthy();
    expect(screen.getByText(/Brain Server is not reachable/)).toBeTruthy();
    expect(screen.queryByTestId('pf-dh-facts')).toBeNull();
    expect(screen.queryByTestId('pf-map-row')).toBeNull();
    expect(screen.queryByTestId('pf-dh-quality')).toBeNull();
  });

  it('dataset invalid: availability + issues shown, no figures', () => {
    renderPanel(response({ availability: 'invalid', dataset: null, meta: null, issues: ['meta.as_of: invalid_string'] }), { availability: 'invalid', rows: [] });
    expect(screen.getByText(/failed validation/i)).toBeTruthy();
    expect(screen.getByText('meta.as_of: invalid_string')).toBeTruthy();
    expect(screen.queryByTestId('pf-dh-facts')).toBeNull();
    expect(screen.queryByTestId('pf-map-row')).toBeNull();
  });

  it('mapping endpoint failed while the dataset loaded: the table says so instead of rendering rows', async () => {
    renderPanel(response(), null);
    expect(await screen.findByTestId('pf-dh-mapping-error')).toBeTruthy();
    expect(screen.queryByTestId('pf-map-row')).toBeNull();
  });
});

describe('square footage source (T9b part 2)', () => {
  const rarig = ENTITY_TO_CANONICAL['1100 Rarig']!.id;
  const snapshot = (asOf: string): LiveSfSnapshot =>
    ({
      meta: { schemaVersion: 1, asOf, generatedAt: `${asOf}T08:00:00.000Z`, source: 'wb', scenario: 'base' },
      properties: [{ id: rarig, sf: 21000, occPct: 0.9, tenantCount: 9 }],
      leases: [{ id: 'a', propertyId: rarig, propertyKey: '1100 Rarig', tenantName: 't', unit: null, company: null, sf: 18900, monthlyRent: 1, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null, status: 'Active', annualRent: 12, monthsToExpiry: null, flags: [] }],
    }) as unknown as LiveSfSnapshot;
  const NOW = new Date(2026, 9, 5, 12, 0, 0);

  it('fresh live block: Rarig shown as Live (Spine A) with the live leased SF; the others as Static dataset; headline says how many are live', () => {
    renderPanel(response({ liveSf: buildLiveSf(snapshot('2026-10-04'), D, NOW) }));
    const sec = screen.getByTestId('pf-dh-sf');
    expect(within(sec).getByTestId('pf-dh-sf-headline').textContent).toMatch(/Live.*Master Workbook \(live Spine A\) as of 2026-10-04 is fresh \(1 day old\); 1 of 11 entities use live SF/);
    const rows = within(sec).getAllByTestId('pf-sf-row');
    expect(rows).toHaveLength(PF_ENTITY_IDS.length);
    const rarigRow = rows.find((r) => r.getAttribute('data-entity') === '1100 Rarig')!;
    expect(rarigRow.getAttribute('data-using')).toBe('live');
    expect(rarigRow.textContent).toMatch(/21,000/);
    expect(rarigRow.textContent).toMatch(/18,900/);
    expect(rarigRow.textContent).toMatch(/Live \(Spine A\)/);
    const e5 = rows.find((r) => r.getAttribute('data-entity') === '3540 E 5th')!;
    expect(e5.getAttribute('data-using')).toBe('static');
    expect(e5.textContent).toMatch(/Static dataset/);
    expect(e5.textContent).toMatch(/static dataset \(2026-10-02\)/);
    expect(rows.find((r) => r.getAttribute('data-entity') === '1851 South Club Solar')!.getAttribute('data-using')).toBe('none');
  });

  it('stale live block: headline says Stale with the reason and every row falls back to the static dataset', () => {
    renderPanel(response({ liveSf: buildLiveSf(snapshot('2026-09-01'), D, NOW) }));
    const sec = screen.getByTestId('pf-dh-sf');
    expect(within(sec).getByTestId('pf-dh-sf-headline').textContent).toMatch(/Stale.*is STALE \(34 days old, limit 7\)/);
    expect(within(sec).getAllByTestId('pf-sf-row').every((r) => r.getAttribute('data-using') !== 'live')).toBe(true);
  });

  it('F5: a future-dated live block reads STALE with the future reason and no negative day count', () => {
    renderPanel(response({ liveSf: buildLiveSf(snapshot('2026-10-10'), D, NOW) }));
    const h = within(screen.getByTestId('pf-dh-sf')).getByTestId('pf-dh-sf-headline').textContent!;
    expect(h).toMatch(/is STALE \(as-of date 2026-10-10 is in the future, limit 7 days\)/);
    expect(h).not.toMatch(/-\d+ days?/);
  });

  it('no block (older server) and the static fallback block both read as static, without error', () => {
    renderPanel(response({ liveSf: null }));
    expect(screen.getByTestId('pf-dh-sf-headline').textContent).toMatch(/no live square-footage block/);
    cleanup();
    renderPanel(response({ liveSf: buildLiveSf(null, D, NOW) }));
    expect(screen.getByTestId('pf-dh-sf-headline').textContent).toMatch(/Live Master Workbook unavailable; figures use the static dataset \(2026-10-02\)/);
  });
});

describe('PfDataHealthSummary — compact card at the foot of the module', () => {
  function renderSummary(data: PfDatasetResponse = response()) {
    return render(
      <QueryClientProvider client={client(data)}>
        <MemoryRouter>
          <PfDataHealthSummary response={data} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('summarises version, freshness, gap and mapping counts and links to the Data destination panel', () => {
    renderSummary();
    const card = screen.getByTestId('pf-dh-summary');
    expect(card.textContent).toMatch(new RegExp(D.meta.version));
    expect(card.textContent).toMatch(new RegExp(`${D.data_quality.length} data-quality notes`));
    expect(card.textContent).toMatch(/11 entities mapped/);
    expect(card.textContent).toMatch(/1 inferred/);
    expect(card.textContent).toMatch(/3 SF flags/);
    const link = within(card).getByRole('link', { name: /data health/i });
    expect(link.getAttribute('href')).toBe('/data?tab=quality&view=property-financials');
  });

  it('stale: icon + label in the summary too', () => {
    renderSummary(response({ meta: { ...response().meta!, ageDays: 45, staleness: 'stale' } }));
    const f = within(screen.getByTestId('pf-dh-summary')).getByTestId('pf-dh-freshness');
    expect(f.textContent).toMatch(/Stale/);
    expect(f.querySelector('svg')).not.toBeNull();
  });
});

describe('parseMappingResponse — GET /mapping fails loud on a malformed body', () => {
  it('accepts the real server output unchanged', () => {
    expect(parseMappingResponse(JSON.parse(JSON.stringify(MAPPING)))).toEqual(MAPPING);
  });

  it.each([
    ['not an object', 'nope'],
    ['rows missing', { availability: 'ok' }],
    ['unknown availability', { availability: 'maybe', rows: [] }],
    ['bad method', { availability: 'ok', rows: [{ entity: 'FVC', canonicalId: 'x', method: 'guessed', flags: [] }] }],
    ['bad canonical id', { availability: 'ok', rows: [{ entity: 'FVC', canonicalId: 7, method: 'exact', flags: [] }] }],
    ['bad flag', { availability: 'ok', rows: [{ entity: 'FVC', canonicalId: 'x', method: 'exact', flags: [{ code: 1 }] }] }],
  ])('%s → throws', (_name, raw) => {
    expect(() => parseMappingResponse(raw)).toThrow(/property-financials: .*mapping/);
  });
});
