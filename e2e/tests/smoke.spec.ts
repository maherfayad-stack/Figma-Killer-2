import { test, expect } from '@playwright/test';

// Trivial P0 smoke spec: it does not exercise a real studio yet (that
// needs P1's daemon + canvas). It proves the harness itself works and
// demonstrates the acceptance path from the playbook §4/P0 prompt:
// `pnpm create-file demo && pnpm dev` serving `?frame=Hero` / `?frame=Pricing`,
// including the Arabic/RTL fixture (playbook §5.9).
test('file-app template serves the Hero frame', async ({ page }) => {
  await page.goto('/?frame=Hero');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Plan your next trip');
});

test('file-app template serves the Pricing frame with correct RTL direction', async ({ page }) => {
  await page.goto('/?frame=Pricing');
  const section = page.locator('section[dir="rtl"]');
  await expect(section).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('خطط الأسعار');
});
