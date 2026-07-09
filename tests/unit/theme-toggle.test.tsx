import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeToggle } from '../../src/shell/ThemeToggle';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('ThemeToggle 3-way cycle', () => {
  it('cycles command -> parchment -> warm -> command on repeated clicks', () => {
    render(<ThemeToggle />);
    const btn = screen.getByLabelText(/toggle theme/i);

    expect(document.documentElement.getAttribute('data-theme')).toBe(null);

    fireEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('parchment');

    fireEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('warm');

    fireEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('command');
  });
});
