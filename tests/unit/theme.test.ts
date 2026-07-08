import { describe, it, expect, beforeEach } from 'vitest';
import { getInitialTheme, applyTheme } from '../../src/lib/theme';

beforeEach(() => localStorage.clear());

describe('theme persistence', () => {
  it('getInitialTheme returns "warm" when localStorage has it', () => {
    localStorage.setItem('ora-theme', 'warm');
    expect(getInitialTheme()).toBe('warm');
  });

  it('getInitialTheme falls back to "command" for an unrecognized value', () => {
    localStorage.setItem('ora-theme', 'garbage');
    expect(getInitialTheme()).toBe('command');
  });

  it('applyTheme sets data-theme="warm" and persists it', () => {
    applyTheme('warm');
    expect(document.documentElement.getAttribute('data-theme')).toBe('warm');
    expect(localStorage.getItem('ora-theme')).toBe('warm');
  });
});
