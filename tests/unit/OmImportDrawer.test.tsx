// tests/unit/OmImportDrawer.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { OmImportDrawer } from '../../src/modules/acquisitions/OmImportDrawer';
import { OmExtractError } from '../../src/modules/acquisitions/acquisition-score';

afterEach(() => cleanup());

const noop = () => {};

describe('OmImportDrawer', () => {
  it('does not render when open=false', () => {
    render(<OmImportDrawer open={false} onClose={noop} onApply={noop} />);
    expect(screen.queryByText(/OM Import/i)).toBeNull();
  });

  it('renders upload button in idle state', () => {
    render(<OmImportDrawer open={true} onClose={noop} onApply={noop} />);
    expect(screen.getByText(/OM Import/i)).toBeTruthy();
    expect(screen.getByText(/upload/i)).toBeTruthy();
  });

  it('shows extracting state while upload is in flight', async () => {
    let resolve!: (v: { fields: Record<string, string>; fieldCount: number }) => void;
    const extractFn = vi.fn(() => new Promise<{ fields: Record<string, string>; fieldCount: number }>((r) => { resolve = r; }));

    render(<OmImportDrawer open={true} onClose={noop} onApply={noop} extractFn={extractFn} />);

    // Simulate file selection via the hidden input
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'test.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/Extracting fields/i)).toBeTruthy());
    resolve({ fields: {}, fieldCount: 0 }); // unblock
  });

  it('shows extracted table and Apply/Discard when extraction succeeds', async () => {
    const fields = { price: '1450000', totalSf: '17688', yearBuilt: '1987' };
    const extractFn = vi.fn(async () => ({ fields, fieldCount: 3 }));
    const onApply = vi.fn();
    const onClose = vi.fn();

    render(<OmImportDrawer open={true} onClose={onClose} onApply={onApply} extractFn={extractFn} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'test.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/3 fields found/i)).toBeTruthy());
    expect(screen.getByText('1450000')).toBeTruthy();
    expect(screen.getByText('17688')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /apply to form/i }));
    expect(onApply).toHaveBeenCalledWith(fields);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Discard is clicked', async () => {
    const fields = { price: '1450000' };
    const extractFn = vi.fn(async () => ({ fields, fieldCount: 1 }));
    const onClose = vi.fn();

    render(<OmImportDrawer open={true} onClose={onClose} onApply={noop} extractFn={extractFn} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'test.pdf')] } });

    await waitFor(() => expect(screen.getByRole('button', { name: /discard/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows error state when extraction throws OmExtractError', async () => {
    const extractFn = vi.fn(async (): Promise<{ fields: Record<string, string>; fieldCount: number }> => {
      throw new OmExtractError('AI service temporarily unavailable — try again in a moment.');
    });

    render(<OmImportDrawer open={true} onClose={noop} onApply={noop} extractFn={extractFn} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'test.pdf')] } });

    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });
});
