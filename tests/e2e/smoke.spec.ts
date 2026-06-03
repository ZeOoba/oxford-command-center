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
  await expect(page.getByText('Rent Roll')).toBeVisible();
  await expect(page.getByText(/REDACTED-659/).first()).toBeVisible();
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
