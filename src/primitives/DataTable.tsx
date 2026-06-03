import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  width?: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => number | string | null;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  maxHeight?: number;
}

const VIRTUALIZE_THRESHOLD = 80;

export function DataTable<T>({ columns, rows, getRowId, onRowClick, initialSort, maxHeight }: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, sort, columns]);

  const toggle = (key: string) => {
    const col = columns.find((c) => c.key === key);
    if (!col?.sortValue) return;
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  };

  const virtualize = maxHeight != null && sorted.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 14,
  });
  const vItems = virtualizer.getVirtualItems();
  const padTop = virtualize && vItems.length ? vItems[0]!.start : 0;
  const padBottom = virtualize && vItems.length ? virtualizer.getTotalSize() - vItems[vItems.length - 1]!.end : 0;

  const ariaSort = (key: string): 'ascending' | 'descending' | 'none' =>
    sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

  const renderRow = (row: T, vIndex?: number) => (
    <tr
      key={getRowId(row)}
      data-index={vIndex}
      ref={vIndex !== undefined ? virtualizer.measureElement : undefined}
      onClick={() => onRowClick?.(row)}
      className={cn('transition-colors', onRowClick && 'cursor-pointer')}
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      {columns.map((c) => (
        <td key={c.key} className={cn('px-3 py-2 align-middle', c.align === 'right' ? 'num text-right' : 'text-left')} style={{ color: 'var(--text-primary)' }}>
          {c.render(row)}
        </td>
      ))}
    </tr>
  );

  return (
    <div ref={scrollRef} className="overflow-auto" style={{ maxHeight }}>
      <table className="ora-table w-full border-collapse">
        <thead className="sticky top-0 z-10" style={{ background: 'var(--surface-raised)' }}>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                aria-sort={c.sortValue ? ariaSort(c.key) : undefined}
                tabIndex={c.sortValue ? 0 : undefined}
                onClick={() => toggle(c.key)}
                onKeyDown={(e) => {
                  if (c.sortValue && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    toggle(c.key);
                  }
                }}
                className={cn(
                  'num px-3 py-2.5 text-2xs font-semibold uppercase whitespace-nowrap select-none',
                  c.sortValue && 'cursor-pointer',
                  c.align === 'right' ? 'text-right' : 'text-left',
                )}
                style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-strong)', width: c.width }}
              >
                <span className={cn('inline-flex items-center gap-1', c.align === 'right' && 'flex-row-reverse')}>
                  {c.header}
                  {sort?.key === c.key && (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {virtualize ? (
            <>
              {padTop > 0 && (
                <tr aria-hidden>
                  <td colSpan={columns.length} style={{ height: padTop, padding: 0, border: 'none' }} />
                </tr>
              )}
              {vItems.map((vi) => renderRow(sorted[vi.index]!, vi.index))}
              {padBottom > 0 && (
                <tr aria-hidden>
                  <td colSpan={columns.length} style={{ height: padBottom, padding: 0, border: 'none' }} />
                </tr>
              )}
            </>
          ) : (
            sorted.map((row) => renderRow(row))
          )}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No records.
        </div>
      )}
    </div>
  );
}
