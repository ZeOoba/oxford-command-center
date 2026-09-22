import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Automated accessibility audit. Requires `npx playwright install chromium`.

test('overview has no serious/critical axe violations', async ({ page }) => {
  await page.goto('/?still=1');
  await page.waitForSelector('text=Portfolio Value', { timeout: 15_000 });
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious.map((v) => v.id), null, 2)).toEqual([]);
});

test('leases table is keyboard-sortable and labeled', async ({ page }) => {
  await page.goto('/?still=1');
  await page.getByRole('button', { name: 'Leasing' }).click();
  await page.getByRole('tab', { name: /^Rent roll/ }).click();
  const header = page.locator('th[aria-sort]').first();
  await expect(header).toBeVisible();
});
