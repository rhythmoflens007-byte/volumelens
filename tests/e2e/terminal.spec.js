// End-to-end checks of the VolumeLens terminal in real browsers (Edge, Chrome).
// Every test fails on any uncaught page error or console error.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
});
test.afterEach(async () => { expect(errors, errors.join('\n')).toEqual([]); });

async function open(page, hash = '') {
  const t0 = Date.now();
  await page.goto(`/?debug${hash ? `#${hash}` : ''}`);
  await page.waitForFunction(() => window.vl && window.vl.state.day && document.getElementById('state-overlay').classList.contains('hidden'));
  return Date.now() - t0;
}

/** The compare chart must cover the same stretch of the day as the main chart (within one candle). */
async function expectInSync(page) {
  const r = await page.evaluate(() => {
    const { volChart, timeChart, state } = window.vl;
    const bars = state.day.bars, cs = state.candles, span = state.tf * 60;
    const clamp = (x, n) => Math.max(0, Math.min(n - 1, x));
    const vr = volChart.timeScale().getVisibleLogicalRange();
    const tr = timeChart.timeScale().getVisibleLogicalRange();
    const tStart = bars[clamp(Math.ceil(vr.from), bars.length)][1];
    const tEnd = bars[clamp(Math.floor(vr.to), bars.length)][0];
    const c0 = cs[clamp(Math.ceil(tr.from), cs.length)][0];
    const c1 = cs[clamp(Math.floor(tr.to), cs.length)][0] + span;
    return { ok: c0 <= tStart + span && c1 >= tEnd - span, tStart, tEnd, c0, c1 };
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

/** Each legend must sit at the top of its own pane. */
async function expectLegendsPlaced(page) {
  const r = await page.evaluate(() => {
    const panes = window.vl.volChart.panes().map((p) => p.getHeight());
    const fill = parseFloat(document.getElementById('legend-fill').style.top);
    return { expected: panes[0] + 1 + 8, fill };
  });
  expect(Math.abs(r.fill - r.expected)).toBeLessThanOrEqual(2);
}

const mainChart = (page) => page.locator('#vol-chart');

test('opens on the most urgent session and loads fast', async ({ page }) => {
  const ms = await open(page);
  expect(ms).toBeLessThan(3000);
  await expect(page).toHaveURL(/#RELIANCE\/2026-05-29/);
  await expect(page.locator('#day-score')).toHaveText(/\d+%/);
  await expect(page.locator('#day-burst')).toContainText('urgent candles');
  await expect(page.locator('#scanner tr')).toHaveCount(6);
  await expect(page.locator('#results tbody tr')).toHaveCount(5);
  await expect(page.locator('#legend-vol')).toContainText('RELIANCE');
  await expectLegendsPlaced(page);
});

test('every time frame rebuilds the compare chart and stays in sync', async ({ page }) => {
  await open(page, 'SBIN/2026-06-03');
  for (const tf of [1, 3, 5, 15, 30]) {
    await page.click(`#tf button[data-tf="${tf}"]`);
    await expect(page.locator('#legend-time')).toContainText(`SBIN · ${tf}m`);
    const n = await page.evaluate(() => window.vl.state.candles.length);
    expect(n).toBeGreaterThan(Math.floor(350 / tf) - 2);
    await expectInSync(page);
  }
});

test('zooming in and out and panning keep both charts aligned', async ({ page }) => {
  await open(page, 'SBIN/2026-06-03');
  const box = await mainChart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + 150);
  for (let k = 0; k < 8; k++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(40); }
  await page.waitForTimeout(300);
  const zoomed = await page.evaluate(() => { const r = window.vl.volChart.timeScale().getVisibleLogicalRange(); return r.to - r.from; });
  expect(zoomed).toBeLessThan(120);
  await expectInSync(page);
  await expectLegendsPlaced(page);

  // pan by dragging
  await page.mouse.move(box.x + box.width * 0.6, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + 150, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expectInSync(page);

  // zoom far out, past the whole session
  for (let k = 0; k < 20; k++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(30); }
  await page.waitForTimeout(300);
  await expectInSync(page);

  // Esc fits the whole session again
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expectInSync(page);
});

test('drawing tools: fast two-click shapes, horizontal line on both charts, undo, clear', async ({ page }) => {
  await open(page, 'TECHM/2026-06-17');
  await page.evaluate(() => { localStorage.removeItem('vl:shapes:TECHM:2026-06-17'); localStorage.removeItem('vl:hlines:TECHM'); });
  await page.reload();
  await page.waitForFunction(() => window.vl && window.vl.state.day);
  const box = await mainChart(page).boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + fy];
  const shapes = () => page.evaluate(() => JSON.parse(localStorage.getItem('vl:shapes:TECHM:2026-06-17') || '[]'));

  await page.keyboard.press('z');
  await page.mouse.click(...at(0.2, 80));
  await page.mouse.click(...at(0.45, 180));          // immediately: the case that used to be swallowed
  await page.keyboard.press('t');
  await page.mouse.click(...at(0.1, 200));
  await page.mouse.click(...at(0.7, 90));
  expect((await shapes()).map((s) => s.type)).toEqual(['zone', 'trend']);

  await page.keyboard.press('h');
  await page.mouse.click(...at(0.5, 120));
  const hl = await page.evaluate(() => JSON.parse(localStorage.getItem('vl:hlines:TECHM')));
  expect(hl).toHaveLength(1);

  await page.keyboard.press('m');
  await page.mouse.click(...at(0.3, 100));
  await page.mouse.click(...at(0.6, 160));

  await page.keyboard.press('Control+z');             // removes the horizontal line
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vl:hlines:TECHM')))).toHaveLength(0);
  await page.click('#clear');
  expect(await shapes()).toEqual([]);
  await page.keyboard.press('v');
  await expect(page.locator('.tool[data-tool="cursor"]')).toHaveClass(/active/);
});

test('replay shows only what was known at the time, then restores the session', async ({ page }) => {
  await open(page, 'RELIANCE/2026-05-29');
  const n = await page.evaluate(() => window.vl.state.day.bars.length);
  await page.keyboard.press('r');
  await expect(page.locator('#replay-bar')).toBeVisible();
  await page.selectOption('#rp-speed', '30');
  await page.keyboard.press(' ');
  await page.waitForTimeout(1500);
  await page.keyboard.press(' ');
  const s = await page.evaluate(() => {
    const st = window.vl.state;
    const now = st.day.bars[st.upto - 1][0];
    return { upto: st.upto, now, lastCandle: st.candles.at(-1)?.[0] ?? 0, alertsAhead: st.day.alerts.filter((a) => a.i < st.upto && a.t > now).length };
  });
  expect(s.upto).toBeGreaterThan(1);
  expect(s.upto).toBeLessThan(n);
  expect(s.lastCandle).toBeLessThanOrEqual(s.now);   // no time candle from the future
  expect(s.alertsAhead).toBe(0);
  const clock = await page.locator('#rp-clock').textContent();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#rp-clock')).not.toHaveText(clock);
  await page.keyboard.press('Escape');
  await expect(page.locator('#replay-bar')).toBeHidden();
  expect(await page.evaluate(() => window.vl.state.upto)).toBe(n);
  await expectInSync(page);
});

test('unfold: clicking a time candle reveals the volume candles inside it', async ({ page }) => {
  await open(page, 'RELIANCE/2026-05-29');
  const box = await page.locator('#time-chart').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await expect(page.locator('#unfold-card')).toBeVisible();
  await expect(page.locator('#unfold-card')).toContainText(/unfolds into|No volume candle/);
  await page.waitForTimeout(700);
  await expectInSync(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#unfold-card')).toBeHidden();
});

test('layers, theme, scanner and session navigation', async ({ page }) => {
  await open(page, 'SBIN/2026-06-03');
  await page.click('#layers summary');
  await page.check('[data-layer="aai"]');
  await expect(page.locator('#legend-aai')).toBeVisible();
  expect(await page.evaluate(() => window.vl.volChart.panes().length)).toBe(3);
  await expectLegendsPlaced(page);
  await page.uncheck('[data-layer="aai"]');
  expect(await page.evaluate(() => window.vl.volChart.panes().length)).toBe(2);
  await page.uncheck('[data-layer="compare"]');
  await expect(page.locator('#time-wrap')).toBeHidden();
  await page.check('[data-layer="compare"]');
  await expect(page.locator('#time-wrap')).toBeVisible();

  await page.click('#theme-btn');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.click('#theme-btn');

  await page.click('#top-sessions li:first-child');
  await expect(page).toHaveURL(/#RELIANCE\/2026-05-29/);
  await page.click('#scanner tr[data-sym="TECHM"]');
  await expect(page).toHaveURL(/#TECHM\//);
  await page.click('#prev-day');
  await expect(page.locator('#legend-vol')).toContainText('TECHM');
});

test('snapshot downloads a PNG', async ({ page }) => {
  await open(page, 'SBIN/2026-06-03');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
  expect(dl.suggestedFilename()).toBe('VolumeLens_SBIN_2026-06-03.png');
});

test('shows a clear error and recovers when data cannot load', async ({ page }) => {
  let fail = true;
  await page.route('**/data/index.json', (r) => (fail ? r.fulfill({ status: 503, body: '' }) : r.continue()));
  await page.goto('/?debug');
  await expect(page.locator('#state-overlay')).toContainText('Could not load');
  errors = errors.filter((e) => !e.includes('503'));       // the failed request itself is expected
  fail = false;
  await page.click('#retry');
  await page.waitForFunction(() => window.vl && window.vl.state.day);
  await expect(page.locator('#state-overlay')).toHaveClass(/hidden/);
});

for (const [w, h] of [[1920, 1080], [1366, 768], [1024, 768]]) {
  test(`layout holds at ${w}x${h} in both themes`, async ({ page }, info) => {
    await page.setViewportSize({ width: w, height: h });
    await open(page, 'SBIN/2026-06-03');
    for (const theme of ['dark', 'light']) {
      if ((await page.getAttribute('html', 'data-theme')) !== theme) await page.click('#theme-btn');
      const r = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        legendInside: (() => {
          const c = document.getElementById('vol-wrap').getBoundingClientRect();
          return [...document.querySelectorAll('#vol-wrap .legend:not([hidden])')].every((l) => { const b = l.getBoundingClientRect(); return b.left >= c.left && b.right <= c.right + 1 && b.top >= c.top; });
        })(),
      }));
      expect(r.overflow).toBeLessThanOrEqual(0);
      expect(r.legendInside).toBe(true);
      await expectLegendsPlaced(page);
      await page.waitForTimeout(450);                       // let fades and theme transitions finish
      await page.screenshot({ path: `test-results/screens/${info.project.name}-${w}x${h}-${theme}.png` });
    }
  });
}

test('accessibility: no serious or critical WCAG 2 AA issues', async ({ page }) => {
  await open(page, 'SBIN/2026-06-03');
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('canvas').analyze();
  const bad = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} × ${v.help}`)).toEqual([]);
});
