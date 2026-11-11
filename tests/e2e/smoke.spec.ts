import { test, expect } from '@playwright/test';

// Run in a clean environment: `npx playwright install chromium` once, then `npm run test:e2e`.
// (The Playwright webServer starts `npm run dev`, so no Brain Server should already be on :8911.)

test('overview renders the real portfolio', async ({ page }) => {
  await page.goto('/?still=1');
  await expect(page.getByText('Command Overview')).toBeVisible();
  await expect(page.getByText('Portfolio Value')).toBeVisible();
  await expect(page.getByText('$59.6M')).toBeVisible({ timeout: 15_000 });
});

test('command palette opens and finds an entity', async ({ page }) => {
  await page.goto('/?still=1');
  await page.keyboard.press('Control+k');
  const input = page.locator('[cmdk-input]');
  await expect(input).toBeVisible();
  await input.fill('rarig');
  await expect(page.getByText(/1100 Rarig/).first()).toBeVisible();
});

test('scenario switch recomputes the portfolio', async ({ page }) => {
  await page.goto('/?still=1');
  await expect(page.getByText('$59.6M')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('radio', { name: 'Downside' }).click();
  await expect(page.getByText('$51.1M')).toBeVisible();
});

test('leasing shows the rent roll', async ({ page }) => {
  await page.goto('/?still=1');
  await page.getByRole('button', { name: 'Leasing' }).click();
  // Regex, not exact: the Rent roll tab can carry an overdue-count badge ("Rent roll2").
  await page.getByRole('tab', { name: /^Rent roll/ }).click();
  // exact:true — the tab strip and the view switch also carry "Rent roll" labels (different case).
  await expect(page.getByText('Rent Roll', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Tenant 155 LLC/).first()).toBeVisible({ timeout: 15_000 });
});

test('entity drill-through opens and closes with Escape', async ({ page }) => {
  await page.goto('/?still=1');
  await page.keyboard.press('Control+k');
  await page.locator('[cmdk-input]').fill('red branch');
  await page.getByText(/9050 Red Branch Rd/).first().click();
  await expect(page.getByText('Square Feet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Square Feet')).not.toBeVisible();
});

// --- Capital destination (IA decongestion Phase 4b): Debt / Cash / Close absorbed as Capital tabs ---
// Legacy module ids stay valid URLs and redirect (replace) to /capital?tab=<x>, preserving other params.

test('legacy /debt lands on Capital > Debt with the Positions view selected', async ({ page }) => {
  await page.goto('/debt?still=1');
  await expect(page).toHaveURL(/\/capital\?.*tab=debt/);
  const positions = page.getByRole('radio', { name: 'Positions' });
  await expect(positions).toBeVisible();
  await expect(positions).toBeChecked();
});

test('legacy /debt?tab=scorecard maps its inner tab to the ?view= segmented control', async ({ page }) => {
  await page.goto('/debt?tab=scorecard&still=1');
  await expect(page).toHaveURL(/\/capital\?/);
  const params = new URL(page.url()).searchParams;
  expect(params.get('tab')).toBe('debt');
  expect(params.get('view')).toBe('scorecard');
  await expect(page.getByRole('radio', { name: 'Scorecard' })).toBeChecked();
});

for (const key of ['cash', 'close'] as const) {
  test(`legacy /${key} lands on the Capital ${key} tab`, async ({ page }) => {
    await page.goto(`/${key}?still=1`);
    await expect(page).toHaveURL(new RegExp(`/capital[?].*tab=${key}`));
    const label = key === 'cash' ? 'Cash' : 'Close';
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
  });
}

test('Capital exposes its five tabs in order', async ({ page }) => {
  await page.goto('/capital?still=1');
  const tabs = page.getByRole('tablist', { name: 'Capital views' }).getByRole('tab');
  await expect(tabs).toHaveText(['Allocation', 'Pipeline', 'Debt', 'Cash', 'Close']);
});

// --- Obligations + Market absorption (IA decongestion Phase 4c) ---
// Insurance/Taxes fold into Obligations; the standalone Demand Signals module becomes Market > Demand.
// Aliases redirect (replace) and map a legacy inner tab to the destination's ?view= segmented control.

test('legacy /insurance?tab=selfinsure lands on Obligations > Insurance with Self-Insure selected', async ({ page }) => {
  await page.goto('/insurance?tab=selfinsure&still=1');
  await expect(page).toHaveURL(/\/obligations\?/);
  const params = new URL(page.url()).searchParams;
  expect(params.get('tab')).toBe('insurance');
  expect(params.get('view')).toBe('selfinsure');
  await expect(page.getByRole('radio', { name: 'Self-Insure & Bids' })).toBeChecked();
});

test('legacy /taxes?tab=returns lands on Obligations > Taxes with Filed Returns selected', async ({ page }) => {
  await page.goto('/taxes?tab=returns&still=1');
  await expect(page).toHaveURL(/\/obligations\?/);
  const params = new URL(page.url()).searchParams;
  expect(params.get('tab')).toBe('taxes');
  expect(params.get('view')).toBe('returns');
  // No radio assertion: the Taxes view switch renders only after the warehouse-backed useTaxAnalysis succeeds, so the URL is the durable assertion.
});

test('legacy /prospect-demand lands on Market > Demand', async ({ page }) => {
  await page.goto('/prospect-demand?still=1');
  await expect(page).toHaveURL(/\/market\?/);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('demand');
  await expect(page.getByRole('tab', { name: 'Demand', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('Obligations exposes its two tabs in order', async ({ page }) => {
  await page.goto('/obligations?still=1');
  const tabs = page.getByRole('tablist', { name: 'Obligations views' }).getByRole('tab');
  await expect(tabs).toHaveText(['Insurance', 'Taxes']);
});

test('Market exposes its four tabs in order', async ({ page }) => {
  await page.goto('/market?still=1');
  const tabs = page.getByRole('tablist', { name: 'Market views' }).getByRole('tab');
  await expect(tabs).toHaveText(['Macro', 'Scorecards', 'Comps', 'Demand']);
});

// --- Leasing destination (IA decongestion Phase 4d): Leases + Tenants absorbed as Leasing tabs ---
// The old Leases rail item and /leases, /tenants URLs alias into it; the module's own strip becomes ?view=.

test('legacy /leases?tab=rollover lands on Leasing > Rent roll with Critical dates selected', async ({ page }) => {
  await page.goto('/leases?tab=rollover&still=1');
  await expect(page).toHaveURL(/\/leasing\?/);
  const params = new URL(page.url()).searchParams;
  expect(params.get('tab')).toBe('rent-roll');
  expect(params.get('view')).toBe('rollover');
  await expect(page.getByRole('radio', { name: 'Critical dates' })).toBeChecked({ timeout: 15_000 });
});

test('legacy /tenants lands on Leasing > Tenants', async ({ page }) => {
  await page.goto('/tenants?still=1');
  await expect(page).toHaveURL(/\/leasing\?/);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('tenants');
  await expect(page.getByRole('tab', { name: 'Tenants', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('Leasing exposes its five tabs in order', async ({ page }) => {
  await page.goto('/leasing?still=1');
  const tabs = page.getByRole('tablist', { name: 'Leasing views' }).getByRole('tab');
  // Rent roll may carry an overdue-count badge suffix, so match by regex.
  await expect(tabs).toHaveText([/^Rollover$/, /^Rent roll(\d+\+?)?$/, /^Forecast$/, /^Market rents$/, /^Tenants$/]);
});

test('Leasing defaults to the Rollover tab', async ({ page }) => {
  await page.goto('/leasing?still=1');
  await expect(page.getByRole('tab', { name: 'Rollover', exact: true })).toHaveAttribute('aria-selected', 'true');
});

// --- Brain destination (IA decongestion Phase 4e): Principal Home + Insights + Versions absorbed as Brain tabs ---
// Digest and Insights are snapshot-backed; Track record / Feedback / Memory sit behind the warehouse-backed report gate,
// so only durable, gate-independent things (URL params, tab strip) are asserted here.

test('principal profile lands on Brain > Digest', async ({ page }) => {
  // Registered before goto so ViewProfileProvider reads it on first load (an explicit stored choice wins over whoami).
  await page.addInitScript(() => localStorage.setItem('ora-view', 'principal'));
  await page.goto('/?still=1');
  await expect(page).toHaveURL(/\/command-brain/, { timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe('/command-brain');
  await expect(page.getByRole('tab', { name: 'Digest', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
});

test('acquisitions profile (default) still lands on Pipeline', async ({ page }) => {
  await page.goto('/?still=1');
  await expect(page).toHaveURL(/\/pipeline/, { timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe('/pipeline');
});

test('legacy /principal lands on Brain > Digest', async ({ page }) => {
  await page.goto('/principal?still=1');
  await expect(page).toHaveURL(/\/command-brain\?/, { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get('tab')).toBe('digest');
  await expect(page.getByRole('tab', { name: 'Digest', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
});

test('legacy /insights lands on Brain > Insights', async ({ page }) => {
  await page.goto('/insights?still=1');
  await expect(page).toHaveURL(/\/command-brain\?/, { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get('tab')).toBe('insights');
  await expect(page.getByRole('tab', { name: 'Insights', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
});

test('legacy /command-brain?tab=versions lands on Brain > Memory with view=versions', async ({ page }) => {
  await page.goto('/command-brain?tab=versions&still=1');
  // Gate on a param only the REDIRECTED URL carries: the pre-redirect URL already matches /command-brain?, so that pattern would pass before the alias commits.
  await expect(page).toHaveURL(/tab=memory/, { timeout: 15_000 });
  const params = new URL(page.url()).searchParams;
  expect(params.get('tab')).toBe('memory');
  expect(params.get('view')).toBe('versions');
  // The Versions radio lives in the Memory panel, behind the warehouse-backed report gate (offline card, no
  // radiogroup when the warehouse is unavailable) — so only the URL params are asserted here.
});

test('Brain exposes its five tabs in order', async ({ page }) => {
  await page.goto('/command-brain?still=1');
  const tabs = page.getByRole('tablist', { name: 'Brain views' }).getByRole('tab');
  // Feedback may carry an open-questions count badge suffix, so match by regex.
  await expect(tabs).toHaveText([/^Digest$/, /^Insights$/, /^Track record$/, /^Feedback(\d+\+?)?$/, /^Memory$/]);
});

test('Brain defaults to the Digest tab', async ({ page }) => {
  await page.goto('/command-brain?still=1');
  await expect(page.getByRole('tab', { name: 'Digest', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
});
