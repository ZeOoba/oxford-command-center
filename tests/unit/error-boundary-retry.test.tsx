// Review round 3: a crashed module can be retried in place, not only by switching modules.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@/shell/ErrorBoundary';

afterEach(() => cleanup());

describe('ErrorBoundary "Try again"', () => {
  it('re-renders the children after a transient failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    function Flaky() {
      if (fail) throw new Error('transient render failure');
      return <div>module content</div>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong rendering this module.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('module content')).toBeTruthy();
    vi.restoreAllMocks();
  });
});
