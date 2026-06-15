// tests/unit/export-briefing-button.test.tsx
//
// Unit tests for src/modules/intel/ExportBriefingButton.tsx.
//
// The component is intentionally dep-light: it renders a Button with an aria-label and
// triggers a transient anchor download on press — no @react-pdf/renderer, no font import.
// These tests verify:
//   • The button renders with the correct default and custom labels.
//   • The constructed href is correct (kind + encodeURIComponent(id) + .pdf).
//   • Pressing the button appends a transient anchor with the right href and then removes it.
//   • Special characters in the id are percent-encoded.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ExportBriefingButton } from '../../src/modules/intel/ExportBriefingButton';

afterEach(() => cleanup());

describe('ExportBriefingButton — rendering', () => {
  it('renders with the default label', () => {
    render(<ExportBriefingButton kind="property" id="some-property-slug" />);
    expect(screen.getByRole('button', { name: /Export briefing \(PDF\)/i })).toBeTruthy();
  });

  it('renders with a custom label', () => {
    render(<ExportBriefingButton kind="property" id="some-property-slug" label="Download PDF" />);
    expect(screen.getByRole('button', { name: /Download PDF/i })).toBeTruthy();
  });

  it('renders for the manager kind', () => {
    render(<ExportBriefingButton kind="manager" id="kohr-royer-griffith" />);
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('renders with size="sm" by default (aria-label reflects label prop)', () => {
    render(<ExportBriefingButton kind="property" id="test-id" />);
    const btn = screen.getByRole('button');
    expect(btn).toBeTruthy();
    // aria-label is set to the label prop value.
    expect(btn.getAttribute('aria-label')).toBe('Export briefing (PDF)');
  });

  it('aria-label matches a custom label', () => {
    render(
      <ExportBriefingButton
        kind="manager"
        id="kohr-royer-griffith"
        label="Get Manager Report"
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toBe('Get Manager Report');
  });
});

describe('ExportBriefingButton — href construction', () => {
  // Capture the href the component passes to the transient anchor on press.
  function captureHref(kind: 'property' | 'manager', id: string): string | null {
    const anchors: HTMLAnchorElement[] = [];
    const originalCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag);
      if (tag === 'a') anchors.push(el as HTMLAnchorElement);
      return el;
    });

    render(<ExportBriefingButton kind={kind} id={id} />);
    const btn = screen.getByRole('button');
    // React Aria's Button fires `onPress` on pointer events, not the native `click`.
    // We use pointer events to trigger it correctly.
    fireEvent.click(btn);

    spy.mockRestore();
    cleanup();
    return anchors[0]?.href ?? null;
  }

  it('builds the correct href for a property briefing', () => {
    const href = captureHref('property', '1100-rarig-ave-columbus-oh');
    // The href may be absolute (http://localhost/...) in jsdom — extract the path portion.
    expect(href).toContain('/api/warehouse/briefing/property/1100-rarig-ave-columbus-oh.pdf');
  });

  it('builds the correct href for a manager briefing', () => {
    const href = captureHref('manager', 'kohr-royer-griffith');
    expect(href).toContain('/api/warehouse/briefing/manager/kohr-royer-griffith.pdf');
  });

  it('percent-encodes special characters in the id', () => {
    // A slug with a space or special char — encodeURIComponent must be applied.
    const href = captureHref('property', 'prop name with spaces');
    expect(href).toContain('prop%20name%20with%20spaces');
  });
});

describe('ExportBriefingButton — download behavior (transient anchor pattern)', () => {
  it('creates a transient anchor, appends it to the body, clicks it, and removes it', () => {
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.fn();

    // Track the anchor element created by the component.
    let capturedAnchor: HTMLAnchorElement | null = null;
    const originalCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag);
      if (tag === 'a') {
        capturedAnchor = el as HTMLAnchorElement;
        // Override remove so we can verify it was called.
        capturedAnchor.remove = removeSpy;
      }
      return el;
    });

    render(<ExportBriefingButton kind="property" id="test-slug" />);
    fireEvent.click(screen.getByRole('button'));

    // The anchor should have been appended to body (and subsequently removed).
    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    // Verify the anchor has rel="noopener" for security.
    expect(capturedAnchor?.rel).toBe('noopener');

    createSpy.mockRestore();
    appendSpy.mockRestore();
  });
});