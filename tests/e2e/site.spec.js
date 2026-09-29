// Website pages: landing (hero animation from real data), research, navigation, phone layout.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
});
test.afterEach(async () => { expect(errors, errors.join('\n')).toEqual([]); });

test('landing: the hero animation turns time candles into urgent bricks, then links to the terminal', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('in a hurry');
  await expect(page.locator('#caption')).toContainText('urgent bricks', { timeout: 15_000 });   // animation reached its end
  await expect(page.locator('#replay')).toBeVisible();
  const n = Number(await page.locator('#f-bricks').textContent());
  expect(n).toBeGreaterThan(Number(await page.locator('#f-candles').textContent()));          // the burst: more bricks than candles
  await page.screenshot({ path: `test-results/screens/${info.project.name}-landing.png` });
  await page.click('.hero .btn.primary');
  await page.waitForURL(/terminal\.html/);
  await page.waitForFunction(() => document.getElementById('state-overlay')?.classList.contains('hidden'));
});

test('no dead links or buttons: every link resolves, every button does something', async ({ page, request }) => {
  for (const url of ['/', '/research.html']) {
    await page.goto(url);
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    for (const h of hrefs) {
      if (/^https?:/.test(h)) continue;                                    // external (TradingView attribution)
      if (h.startsWith('#')) { expect(await page.locator(h).count(), `${url} ${h}`).toBe(1); continue; }
      const res = await request.get(`/${h.split('#')[0]}`);
      expect(res.status(), `${url} → ${h}`).toBe(200);
    }
  }
  await page.goto('/');
  await expect(page.locator('#caption')).toContainText('urgent bricks', { timeout: 15_000 });
  await page.click('#m-time');                                             // back to the time chart
  await expect(page.locator('#m-time')).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
  await expect(page.locator('#caption')).toContainText('ordinary candles');
  await page.click('#m-vol');                                              // and to share time again
  await expect(page.locator('#m-vol')).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
  await expect(page.locator('#replay')).toBeVisible({ timeout: 5000 });
  await page.click('#replay');
  await expect(page.locator('#caption')).toContainText('urgent bricks', { timeout: 15_000 });
  await expect(page.locator('#market-text')).not.toContainText('Checking');
  const rows = page.locator('#scanner tbody tr[data-href]');
  expect(await rows.count()).toBe(11);
  await rows.first().locator('td').nth(2).click();                         // a whole row opens that stock
  await page.waitForURL(/terminal\.html#\w+/);
  const sym = decodeURIComponent(new URL(page.url()).hash.slice(1));
  await page.waitForFunction(() => document.getElementById('state-overlay')?.classList.contains('hidden'));
  await expect(page.locator('#symbol-input')).toHaveValue(sym);
});

test('research page and navigation', async ({ page }) => {
  await page.goto('/research.html');
  await expect(page.locator('h1')).toContainText('Volume-Normalized');
  await expect(page.locator('table.t tr.ours').first()).toContainText('31%');
  await page.click('.brand');
  await page.waitForURL(/index\.html|\/$/);
  await expect(page.locator('h1')).toBeVisible();
});

test('landing on a phone: no sideways scroll, animation fits', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#hero-canvas').scrollIntoViewIfNeeded();         // the figure plays when it comes into view
  await expect(page.locator('#caption')).toContainText('urgent bricks', { timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const box = await page.locator('#hero-canvas').boundingBox();
  expect(box.width).toBeGreaterThan(300);
  await page.screenshot({ path: `test-results/screens/${info.project.name}-landing-phone.png`, fullPage: true });
});

test('website accessibility: no serious or critical WCAG 2 AA issues', async ({ page }) => {
  for (const url of ['/', '/research.html']) {
    await page.goto(url);
    await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
    await page.waitForTimeout(1000);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('canvas').analyze();
    const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    expect(bad.map((v) => `${url} ${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
});
