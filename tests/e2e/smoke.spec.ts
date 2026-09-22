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

test('leases module shows the rent roll', async ({ page }) => {
  await page.goto('/?still=1');
  await page.getByRole('button', { name: 'Leases' }).click();
  // exact:true — the default tab strip now also carries a "Rent roll" label (different case).
  await expect(page.getByText('Rent Roll', { exact: true })).toBeVisible();
  await expect(page.getByText(/Eurosort/).first()).toBeVisible();
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
