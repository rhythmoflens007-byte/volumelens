// Live mode: the terminal subscribes to the live server (here replaying 29 Sep through the live path)
// and shows today's session exactly as the server computed it, following the newest candle.

const { test, expect } = require('@playwright/test');

const LIVE = 'http://127.0.0.1:8788';
let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
});
test.afterEach(async () => { expect(errors, errors.join('\n')).toEqual([]); });

const liveState = (page) => page.evaluate(() => {
  const { state, volChart } = window.vl, s = state.series.sessions.at(-1);
  return { badge: document.getElementById('live-badge').textContent, date: s.date, mode: s.live?.mode,
    rows: s.bars[state.density], upto: state.upto, to: volChart.timeScale().getVisibleLogicalRange().to };
});

test('live: streams today, matches the server, follows the newest candle and never repaints', async ({ page, request }) => {
  await page.goto(`/?debug&live=${LIVE}#RELIANCE`);
  await expect(page.locator('#live-badge')).toHaveText(/SIMULATED \d\d:\d\d:\d\d/, { timeout: 20_000 });
  await page.waitForFunction(() => window.vl?.state.series?.sessions.at(-1).live);

  const first = await liveState(page);
  expect(first.date).toBe('2026-09-29');
  expect(first.mode).toBe('simulated');
  expect(first.to).toBeGreaterThanOrEqual(first.upto - 1);            // newest candle in view

  // the chart holds exactly what the server published
  await expect.poll(async () => {
    const [s, srv] = [await liveState(page), await (await request.get(`${LIVE}/session/RELIANCE`)).json()];
    return JSON.stringify(s.rows) === JSON.stringify(srv.bars.standard);
  }, { timeout: 10_000 }).toBe(true);

  // while the session is still running, new candles arrive and published ones never change
  const srv = await (await request.get(`${LIVE}/session/RELIANCE`)).json();
  if (srv.minutes.length < 360) {
    await expect.poll(async () => (await liveState(page)).rows.length, { timeout: 30_000 }).toBeGreaterThan(first.rows.length);
    const later = await liveState(page);
    expect(later.rows.slice(0, first.rows.length - 1)).toEqual(first.rows.slice(0, -1));
    expect(later.to).toBeGreaterThanOrEqual(later.upto - 1);
  }
});

test('live: a missing live server leaves the terminal fully usable', async ({ page }) => {
  page.on('console', () => {});
  await page.goto('/?debug&live=http://127.0.0.1:8799#RELIANCE');
  await page.waitForFunction(() => window.vl && window.vl.bars().length);
  await expect(page.locator('#live-badge')).toHaveText('Reconnecting…');
  errors = errors.filter((e) => !/ERR_CONNECTION_REFUSED|EventSource|8799/.test(e));
  await expect(page.locator('#vol-chart canvas').first()).toBeVisible();
});
