import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewProfileProvider } from '../../src/brain/view-profile';
import { ViewToggle } from '../../src/shell/ViewToggle';

beforeEach(() => localStorage.clear());

describe('ViewToggle', () => {
  it('flips the profile and persists it', () => {
    render(<ViewProfileProvider><ViewToggle /></ViewProfileProvider>);
    fireEvent.click(screen.getByRole('button', { name: /principal/i }));
    expect(localStorage.getItem('ora-view')).toBe('principal');
    fireEvent.click(screen.getByRole('button', { name: /acquisitions/i }));
    expect(localStorage.getItem('ora-view')).toBe('acquisitions');
  });
});
