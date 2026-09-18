import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SegmentedControl } from '../../src/primitives/SegmentedControl';

afterEach(() => cleanup());

const OPTIONS = [
  { value: 'dollar', label: '$' },
  { value: 'psf', label: '$/SF' },
] as const;

function Harness({ initial = 'dollar' as (typeof OPTIONS)[number]['value'], onChange }: {
  initial?: (typeof OPTIONS)[number]['value'];
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      options={OPTIONS}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      aria-label="View basis"
    />
  );
}

describe('SegmentedControl / accessible name and roles', () => {
  it('exposes a radiogroup with the given accessible name and one radio per option', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'View basis' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
  });
});

describe('SegmentedControl / selection', () => {
  it('marks the current value selected and the rest unselected', () => {
    render(<Harness initial="psf" />);
    expect((screen.getByRole('radio', { name: '$/SF' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: '$' }) as HTMLInputElement).checked).toBe(false);
  });

  it('calls onChange with the clicked option value and updates the checked segment', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '$/SF' }));
    expect(onChange).toHaveBeenCalledWith('psf');
    expect((screen.getByRole('radio', { name: '$/SF' }) as HTMLInputElement).checked).toBe(true);
  });

  it('moves selection via ArrowRight (roving radiogroup keyboard pattern)', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    screen.getByRole('radio', { name: '$' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('psf');
  });
});
