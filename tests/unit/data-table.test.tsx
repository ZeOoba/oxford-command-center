import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DataTable, type Column } from '../../src/primitives/DataTable';

interface Row { id: string; name: string; n: number }
const rows: Row[] = [
  { id: 'a', name: 'Alpha Holdings LLC', n: 1 },
  { id: 'b', name: 'Beta Industrial', n: 2 },
];
const cols: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
  { key: 'n', header: 'N', align: 'right', render: (r) => r.n, sortValue: (r) => r.n },
];

afterEach(() => cleanup());

describe('DataTable responsive behavior', () => {
  it('applies a default minWidth to the table so it scrolls instead of crushing', () => {
    render(<DataTable columns={cols} rows={rows} getRowId={(r) => r.id} />);
    const table = screen.getByRole('table');
    expect(table.style.minWidth).toBe('640px');
  });

  it('honors an explicit minWidth prop', () => {
    render(<DataTable columns={cols} rows={rows} getRowId={(r) => r.id} minWidth={900} />);
    expect(screen.getByRole('table').style.minWidth).toBe('900px');
  });

  it('renders body cells with whitespace-nowrap so multi-word cells do not wrap', () => {
    render(<DataTable columns={cols} rows={rows} getRowId={(r) => r.id} />);
    const cell = screen.getByText('Alpha Holdings LLC').closest('td')!;
    expect(cell.className).toContain('whitespace-nowrap');
  });
});

// Review round 3: clickable rows were mouse-only.
describe('DataTable keyboard row activation', () => {
  it('a clickable row is focusable and opens on Enter or Space; keys from a control inside a cell do not', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const opened: string[] = [];
    const withButton: Column<Row>[] = [...cols, { key: 'act', header: 'Act', render: (r) => <button type="button">act {r.id}</button> }];
    render(<DataTable columns={withButton} rows={rows} getRowId={(r) => r.id} onRowClick={(r) => opened.push(r.id)} />);
    const row = screen.getByText('Alpha Holdings LLC').closest('tr')!;
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(screen.getByText('Beta Industrial').closest('tr')!, { key: ' ' });
    fireEvent.keyDown(screen.getByText('act a'), { key: 'Enter' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(opened).toEqual(['a', 'b']);
  });

  it('a non-clickable table adds no tab stops', () => {
    render(<DataTable columns={cols} rows={rows} getRowId={(r) => r.id} />);
    expect(screen.getByText('Alpha Holdings LLC').closest('tr')!.hasAttribute('tabindex')).toBe(false);
  });
});
