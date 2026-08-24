// tests/unit/admin-onboard-view.test.tsx
//
// PR #302 review finding (Qodo/refute-financial-change): the 6630485 commit made
// PropertyOnboardingInputSchema.ownershipPct required with no default, but never touched
// AdminOnboardView.tsx -- the endpoint's only UI caller -- so every submit through the supported
// route 400'd with "invalid request body" (for 100%-owned properties too), silently bricking
// onboarding. This test drives the actual form submit and validates the POSTed body against the
// real schema, so a future form/schema drift like this fails CI instead of shipping.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AdminOnboardView } from '../../src/modules/intel/AdminOnboardView';
import { PropertyOnboardingInputSchema } from '../../server/warehouse/property-onboarding';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetchCapturingBody(): { getBody: () => unknown } {
  let capturedBody: unknown;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ ok: true, propertyId: 'test-property' }), { status: 200 });
    }),
  );
  return { getBody: () => capturedBody };
}

describe('AdminOnboardView', () => {
  it('defaults Ownership % to 100 and sends a schema-valid ownershipPct of 1', async () => {
    const { getBody } = stubFetchCapturingBody();
    render(<AdminOnboardView />);

    fireEvent.change(screen.getByPlaceholderText('my-new-property'), { target: { value: 'test-property' } });
    fireEvent.change(screen.getByPlaceholderText('123 Main St, Columbus OH'), { target: { value: 'Test Property' } });
    fireEvent.click(screen.getByRole('button', { name: 'Onboard Property' }));

    await waitFor(() => expect(getBody()).toBeDefined());
    const body = getBody() as Record<string, unknown>;
    expect(body.ownershipPct).toBe(1);

    // The exact regression this test guards against: the POSTed body must actually satisfy the
    // real schema, not just "have a field named ownershipPct".
    const parsed = PropertyOnboardingInputSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it('converts a fractional JV ownership entry (e.g. 50) to the schema fraction 0.5', async () => {
    const { getBody } = stubFetchCapturingBody();
    render(<AdminOnboardView />);

    fireEvent.change(screen.getByPlaceholderText('my-new-property'), { target: { value: 'jv-property' } });
    fireEvent.change(screen.getByPlaceholderText('123 Main St, Columbus OH'), { target: { value: 'JV Property' } });
    fireEvent.change(screen.getByPlaceholderText('100'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Onboard Property' }));

    await waitFor(() => expect(getBody()).toBeDefined());
    const body = getBody() as Record<string, unknown>;
    expect(body.ownershipPct).toBe(0.5);
    expect(PropertyOnboardingInputSchema.safeParse(body).success).toBe(true);
  });

  it('rejects submission client-side for an out-of-range Ownership % (0) without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<AdminOnboardView />);

    fireEvent.change(screen.getByPlaceholderText('my-new-property'), { target: { value: 'bad-property' } });
    fireEvent.change(screen.getByPlaceholderText('123 Main St, Columbus OH'), { target: { value: 'Bad Property' } });
    fireEvent.change(screen.getByPlaceholderText('100'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Onboard Property' }));

    await waitFor(() => screen.getByText(/Ownership % must be/));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
