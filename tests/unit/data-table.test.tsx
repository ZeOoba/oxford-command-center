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
