// tests/unit/capex-irr-calc.test.tsx
//
// Render-level tests for CapexIrrCalc (item-8): gating by capitalAction, the hurdle-comparison
// verdict, and the invalid-input display branches. The pure IRR/NPV math itself is covered
// independently in tests/unit/capex-irr.test.ts — this file only exercises the component's own
// decision logic (when it renders, what it labels, which branch it takes).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CapexIrrCalc } from '../../src/modules/intel/CapexIrrCalc';

afterEach(() => cleanup());

function setInputs(capex: number, uplift: number, hold: number): void {
  fireEvent.change(screen.getByLabelText(/proposed capex/i), { target: { value: String(capex) } });
  fireEvent.change(screen.getByLabelText(/annual noi uplift/i), { target: { value: String(uplift) } });
  fireEvent.change(screen.getByLabelText(/hold period/i), { target: { value: String(hold) } });
}

describe('CapexIrrCalc — capitalAction gating', () => {
  it('renders nothing for capitalAction: hold', () => {
    const { container } = render(<CapexIrrCalc capitalAction="hold" propertyName="Test Prop" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for capitalAction: disposition-candidate', () => {
    const { container } = render(<CapexIrrCalc capitalAction="disposition-candidate" propertyName="Test Prop" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the panel for capitalAction: invest', () => {
    render(<CapexIrrCalc capitalAction="invest" propertyName="Test Prop" />);
    expect(screen.getByText(/Capex IRR Calculator/i)).toBeTruthy();
  });

  it('renders the panel for capitalAction: monitor', () => {
    render(<CapexIrrCalc capitalAction="monitor" propertyName="Test Prop" />);
    expect(screen.getByText(/Capex IRR Calculator/i)).toBeTruthy();
  });
});

describe('CapexIrrCalc — heading and hurdle badge', () => {
  it('includes the property name in the heading when provided', () => {
    render(<CapexIrrCalc capitalAction="invest" propertyName="9050 Red Branch" />);
    expect(screen.getByText(/Capex IRR Calculator — 9050 Red Branch/i)).toBeTruthy();
  });

  it('omits the em-dash suffix when propertyName is null', () => {
    render(<CapexIrrCalc capitalAction="invest" propertyName={null} />);
    expect(screen.getByText(/^Capex IRR Calculator$/i)).toBeTruthy();
  });

  it('shows the CAPITAL_CONFIG.capexIrr hurdle (15%) as the badge', () => {
    render(<CapexIrrCalc capitalAction="invest" propertyName={null} />);
    expect(screen.getByText(/hurdle 15(\.0)?%/i)).toBeTruthy();
  });
});

describe('CapexIrrCalc — verdict branches (cross-checked against capex-irr.test.ts)', () => {
  it('shows "Above hurdle" for capex=100k, uplift=20k, hold=10 (IRR ~15.1%, verified > 15% hurdle)', () => {
    render(<CapexIrrCalc capitalAction="invest" propertyName={null} />);
    setInputs(100_000, 20_000, 10);
    expect(screen.getByText(/Above hurdle \(15(\.0)?%\) — deploy capital/i)).toBeTruthy();
  });

  it('shows "Below hurdle" for capex=100k, uplift=15k, hold=10 (IRR ~8.1%, verified < 15% hurdle)', () => {
    render(<CapexIrrCalc capitalAction="invest" propertyName={null} />);
    setInputs(100_000, 15_000, 10);
    expect(screen.getByText(/Below hurdle \(15(\.0)?%\) — do not deploy/i)).toBeTruthy();
  });

  it('shows the no-return verdict and −∞ IRR when uplift is 0', () => {
    render(<CapexIrrCalc capitalAction="invest" propertyName={null} />);
    setInputs(100_000, 0, 10);
    expect(screen.getByText('−∞')).toBeTruthy();
    expect(screen.getByText(/No return — do not deploy capital/i)).toBeTruthy();
  });

  it('clamps the hold-period input to [1, 10]', () => {
    render(<CapexIrrCalc capitalAction="invest" propertyName={null} />);
    fireEvent.change(screen.getByLabelText(/hold period/i), { target: { value: '25' } });
    expect((screen.getByLabelText(/hold period/i) as HTMLInputElement).value).toBe('10');
    fireEvent.change(screen.getByLabelText(/hold period/i), { target: { value: '0' } });
    expect((screen.getByLabelText(/hold period/i) as HTMLInputElement).value).toBe('1');
  });
});
