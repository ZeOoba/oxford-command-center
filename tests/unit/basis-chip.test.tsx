// tests/unit/basis-chip.test.tsx
//
// Design review 2026-10-31 finding 8: NOI figures name their basis with one primitive, using the
// same words as the Priority Actions basis chips (spineLabel: "Workbook" / "Ledger").
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BasisChip, BasisSublabel } from '../../src/primitives/BasisChip';
import { spineLabel } from '../../src/lib/spine-label';

afterEach(cleanup);

describe('BasisChip', () => {
  it('uses the spine vocabulary and explains the basis on hover', () => {
    render(
      <>
        <BasisChip basis="workbook" />
        <BasisChip basis="ledger" />
      </>,
    );
    const wb = screen.getByText(spineLabel('A'));
    const lg = screen.getByText(spineLabel('B'));
    const wbHost = wb.closest('[data-basis]')!;
    const lgHost = lg.closest('[data-basis]')!;
    expect(wbHost.getAttribute('data-basis')).toBe('workbook');
    expect(lgHost.getAttribute('data-basis')).toBe('ledger');
    expect(wbHost.getAttribute('title')).toMatch(/Master Workbook.*not comparable with the P&L ledger without basis-matching/i);
    expect(lgHost.getAttribute('title')).toMatch(/P&L statements.*not comparable with the workbook without basis-matching/i);
  });
});

describe('BasisSublabel', () => {
  it('leads the sublabel text with the basis chip', () => {
    const { container } = render(<BasisSublabel basis="ledger">FY2025 · entity 100%</BasisSublabel>);
    expect(container.textContent).toBe('LedgerFY2025 · entity 100%');
    expect(container.querySelector('[data-basis="ledger"]')).not.toBeNull();
  });

  it('renders the chip alone when there is no text', () => {
    const { container } = render(<BasisSublabel basis="workbook">{undefined}</BasisSublabel>);
    expect(container.textContent).toBe('Workbook');
  });
});
