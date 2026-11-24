// Tier 3 UI hygiene (2026-11-23 review): ~23 surfaces printed the raw error.message, and the shell
// fallback blamed "the Brain Server (:8911)" for every failure, including schema and 500 errors.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describeActionError, describeError } from '../../src/lib/describe-error';
import { QueryError } from '../../src/primitives/QueryError';
import { ActionError } from '../../src/primitives/ActionError';

class WarehouseUnavailableError extends Error {
  constructor() {
    super('warehouse unavailable');
    this.name = 'WarehouseUnavailableError';
  }
}

afterEach(cleanup);

describe('describeError', () => {
  it('names an unreachable server without a port number', () => {
    const d = describeError(new TypeError('Failed to fetch'), 'the debt ladder');
    expect(d.kind).toBe('network');
    expect(d.headline).toBe("Can't reach the command-center server.");
    expect(d.headline).not.toMatch(/8911/);
  });

  it('names the warehouse-unavailable case (any module copy of the class, matched by name)', () => {
    const d = describeError(new WarehouseUnavailableError(), 'tax analysis');
    expect(d.kind).toBe('unavailable');
    expect(d.headline).toMatch(/needs the live warehouse/);
  });

  it('a server or schema error says what failed and keeps the raw text as detail only', () => {
    const d = describeError(new Error('HTTP 500: column "x" missing'), 'the debt ladder');
    expect(d).toEqual({ kind: 'failed', headline: "Couldn't load the debt ladder.", detail: 'HTTP 500: column "x" missing' });
  });

  it('a non-Error value still describes safely', () => {
    expect(describeError('boom', 'scores')).toEqual({ kind: 'failed', headline: "Couldn't load scores.", detail: 'boom' });
    expect(describeError(undefined, 'scores').detail).toBeNull();
  });
});

describe('<QueryError>', () => {
  it('shows the headline, hides the raw detail behind a disclosure, and retries', () => {
    const retry = vi.fn();
    render(<QueryError error={new Error('HTTP 500: boom')} what="the debt ladder" onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load the debt ladder.");
    const details = screen.getByText('Details').closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('HTTP 500: boom');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders no Retry button without onRetry', () => {
    render(<QueryError error={new TypeError('Failed to fetch')} what="x" />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText('Details')).toBeTruthy(); // the network message is still available
  });
});

// Review round 2 (2026-11-24): the action-side twin. Save/grade/file/decide failures printed the
// raw error.message as the whole message.
describe('describeActionError / ActionError', () => {
  it('headline is what did not happen; the raw server text is detail only', () => {
    expect(describeActionError(new Error('HTTP 400: Invalid input: vacancyPct'), 'The decision was not saved.')).toEqual({
      kind: 'failed',
      headline: 'The decision was not saved.',
      detail: 'HTTP 400: Invalid input: vacancyPct',
    });
  });

  it('an unreachable server says so, then what did not happen', () => {
    const d = describeActionError(new TypeError('Failed to fetch'), 'Not saved.');
    expect(d.kind).toBe('network');
    expect(d.headline).toBe("Can't reach the command-center server. Not saved.");
  });

  it('renders the headline as an alert with the raw text under Details', () => {
    render(<ActionError error={new Error('SQLITE_CONSTRAINT: UNIQUE')} failed="The mapping was not added." />);
    expect(screen.getByRole('alert').textContent).toMatch(/^The mapping was not added\./);
    expect(screen.getByText('Details')).toBeTruthy();
    expect(screen.getByText('SQLITE_CONSTRAINT: UNIQUE')).toBeTruthy();
  });

  it('renders no Details when there is no message', () => {
    render(<ActionError error={undefined} failed="Not saved." />);
    expect(screen.queryByText('Details')).toBeNull();
  });
});
