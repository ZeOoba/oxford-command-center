import { describe, it, expect, vi, afterEach } from 'vitest';
import { toCsv, downloadCsv } from '../../src/lib/export';

describe('toCsv', () => {
  it('returns an empty string for no rows', () => {
    expect(toCsv([])).toBe('');
  });

  it('derives the header row from the first object’s keys', () => {
    const csv = toCsv([{ name: 'Rarig', noi: 511000 }]);
    expect(csv).toBe('name,noi\nRarig,511000');
  });

  it('renders one data line per row in key order', () => {
    const csv = toCsv([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
    expect(csv.split('\n')).toEqual(['a,b', '1,2', '3,4']);
  });

  it('quotes and escapes values containing comma, quote, or newline', () => {
    const csv = toCsv([{ note: 'Smith, Jones', quote: 'he said "hi"', multi: 'a\nb' }]);
    // header + one row
    const [, row] = csv.split('\n');
    // The newline inside a quoted field means split('\n') over-splits; assert on the raw string.
    expect(csv).toContain('"Smith, Jones"');
    expect(csv).toContain('"he said ""hi"""');
    expect(csv).toContain('"a\nb"');
    expect(row).toContain('"Smith, Jones"');
  });

  it('renders null and undefined as empty cells', () => {
    const csv = toCsv([{ a: null, b: undefined, c: 0 }]);
    expect(csv).toBe('a,b,c\n,,0');
  });

  it('uses only the first row’s keys as columns (heterogeneous rows)', () => {
    const csv = toCsv([{ a: 1 }, { a: 2, b: 9 } as Record<string, unknown>]);
    expect(csv).toBe('a\n1\n2');
  });
});

describe('downloadCsv', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does nothing when there are no rows (no object URL, no anchor click)', () => {
    const createUrl = vi.fn(() => 'blob:none');
    vi.stubGlobal('URL', { ...URL, createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadCsv('empty.csv', []);

    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('creates a blob URL and clicks a download anchor with the given filename', () => {
    const createUrl = vi.fn(() => 'blob:abc');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const created: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === 'a') created.push(el as HTMLAnchorElement);
      return el;
    });

    downloadCsv('export.csv', [{ a: 1 }]);

    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]!.download).toBe('export.csv');
    expect(created[0]!.href).toContain('blob:abc');
    // The temporary anchor is removed and the URL revoked after the click.
    expect(created[0]!.isConnected).toBe(false);
    expect(revokeUrl).toHaveBeenCalledWith('blob:abc');
  });
});
