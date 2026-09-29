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
  await page.goto(`/terminal.html?debug${hash ? `#${hash}` : ''}`);
  await page.waitForFunction(() => window.vl && window.vl.state.symbol && window.vl.bars().length && document.getElementById('state-overlay').classList.contains('hidden'));
  await page.waitForTimeout(300);
  return Date.now() - t0;
}
const settle = (page, ms = 600) => page.waitForTimeout(ms);

/** The compare chart must cover the same stretch of time as the main chart (within one candle). */
async function expectInSync(page) {
  const r = await page.evaluate(() => {
    const { volChart, timeChart, state, bars } = window.vl;
    const b = bars(), cs = state.candles, span = state.tf * 60;
    const clamp = (x, n) => Math.max(0, Math.min(n - 1, x));
    const vr = volChart.timeScale().getVisibleLogicalRange(), tr = timeChart.timeScale().getVisibleLogicalRange();
    const tStart = b[clamp(Math.ceil(vr.from), b.length)][1], tEnd = b[clamp(Math.floor(vr.to), b.length)][0];
    const c0 = cs[clamp(Math.ceil(tr.from), cs.length)][0], c1 = cs[clamp(Math.floor(tr.to), cs.length)][0] + span;
    return { ok: c0 <= tStart + span && c1 >= tEnd - span, tStart, tEnd, c0, c1 };
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

/** Each legend must sit at the top of its own pane. */
async function expectLegendsPlaced(page) {
  const r = await page.evaluate(() => {
    const panes = window.vl.volChart.panes().map((p) => p.getHeight());
    return { expected: panes[0] + 1 + 8, urg: parseFloat(document.getElementById('legend-urg').style.top) };
  });
  expect(Math.abs(r.urg - r.expected)).toBeLessThanOrEqual(2);
}
const visibleRange = (page) => page.evaluate(() => window.vl.volChart.timeScale().getVisibleLogicalRange());
const mainChart = (page) => page.locator('#vol-chart');

test('opens a continuous chart on the latest session, fast', async ({ page }) => {
  const ms = await open(page);
  expect(ms).toBeLessThan(4000);
  await expect(page).toHaveURL(/#RELIANCE/);
  await expect(page.locator('#day-score')).toHaveText(/\d+%/);
  await expect(page.locator('#dw dt')).toHaveCount(9);
  await expect(page.locator('#size-chip')).toHaveText(/\d/);
  await expect(page.locator('#legend-urg')).toContainText('Urgency Index');
  const s = await page.evaluate(() => ({ loaded: window.vl.state.series.sessions.length, starts: window.vl.state.view.starts.length }));
  expect(s.loaded).toBe(10);
  expect(s.starts).toBe(10);
  await expectLegendsPlaced(page);
});

test('earlier sessions stream in when scrolling left, without jumping', async ({ page }) => {
  await open(page);
  const box = await mainChart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + 150);
  for (let k = 0; k < 25; k++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(30); }   // zoom out to the left edge
  await page.waitForFunction(() => window.vl.state.series.sessions.length > 10, null, { timeout: 8000 });
  await settle(page, 800);
  const r = await visibleRange(page);
  expect(r.to - r.from).toBeGreaterThan(50);
  await expectInSync(page);
});

test('ranges, go to session and densities keep the view consistent', async ({ page }) => {
  await open(page);
  await page.click('#ranges button[data-range="5"]');
  await settle(page);
  const r5 = await visibleRange(page);
  const starts = await page.evaluate(() => window.vl.state.view.starts.map((s) => s.index));
  expect(Math.round(r5.from + 1)).toBe(starts.at(-5));
  await expectInSync(page);

  await page.selectOption('#session-select', '2026-07-15');
  await page.waitForFunction(() => document.getElementById('day-label').textContent.includes('15 Jul'), null, { timeout: 8000 });
  await settle(page);                                                    // let the glide finish
  await expectInSync(page);

  for (const d of ['fine', 'coarse', 'standard']) {
    await page.click(`#density button[data-v="${d}"]`);
    await settle(page, 400);
    const size = await page.evaluate(() => window.vl.state.view.starts.at(-1).size);
    expect(size).toBeGreaterThan(0);
    await expect(page.locator('#legend-vol')).toContainText(/Volume (Bricks|Candles) · 1 (brick|candle) =/);       // the legend names the box size
    expect(await page.evaluate(() => window.vl.state.density)).toBe(d);
    await expect(page.locator('#day-label')).toContainText('15 Jul');           // same place in time
  }
  await page.click('#ranges button[data-range="all"]');
  await page.waitForFunction(() => window.vl.state.series.complete, null, { timeout: 15000 });
  await settle(page);
  await expectInSync(page);
});

test('every time frame rebuilds the compare chart and stays in sync', async ({ page }) => {
  await open(page);
  for (const tf of [1, 3, 5, 15, 30]) {
    await page.click(`#tf button[data-v="${tf}"]`);
    await expect(page.locator('#legend-time')).toContainText(`RELIANCE · ${tf}m`);
    await settle(page, 300);
    await expectInSync(page);
  }
});

test('zoom, pan and fit keep both charts aligned', async ({ page }) => {
  await open(page);
  const box = await mainChart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + 150);
  for (let k = 0; k < 8; k++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(40); }
  await settle(page, 400);
  await expectInSync(page);
  await expectLegendsPlaced(page);
  await page.mouse.move(box.x + box.width * 0.2, box.y + 150);            // drag right = back in time
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + 150, { steps: 8 });
  await page.mouse.up();
  await settle(page, 900);
  await expectInSync(page);
  await expect(page.locator('#go-latest')).toBeVisible();
  await page.click('#go-latest');
  await settle(page);
  await expect(page.locator('#go-latest')).toBeHidden();
  await expectInSync(page);
});

test('drawing tools: fast two-click shapes, horizontal line on both charts, undo, clear', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { localStorage.removeItem('vl:shapes:RELIANCE'); localStorage.removeItem('vl:hlines:RELIANCE'); });
  const box = await mainChart(page).boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + fy];
  const shapes = () => page.evaluate(() => JSON.parse(localStorage.getItem('vl:shapes:RELIANCE') || '[]'));
  await page.keyboard.press('z');
  await page.mouse.click(...at(0.2, 80));
  await page.mouse.click(...at(0.45, 180));
  await page.keyboard.press('t');
  await page.mouse.click(...at(0.1, 200));
  await page.mouse.click(...at(0.7, 90));
  const s = await shapes();
  expect(s.map((x) => x.type)).toEqual(['zone', 'trend']);
  expect(s[0].a.t).toBeGreaterThan(1.7e9);                    // anchored to time, not position
  await page.keyboard.press('h');
  await page.mouse.click(...at(0.5, 120));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vl:hlines:RELIANCE')))).toHaveLength(1);
  await page.keyboard.press('m');
  await page.mouse.click(...at(0.3, 100));
  await page.mouse.click(...at(0.6, 160));
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vl:hlines:RELIANCE')))).toHaveLength(0);
  await page.click('#clear');
  expect(await shapes()).toEqual([]);
  await page.keyboard.press('v');
  await expect(page.locator('.tool[data-tool="cursor"]')).toHaveClass(/active/);
});

test('replay shows only what was known at the time, then restores the session', async ({ page }) => {
  await open(page);
  const n = await page.evaluate(() => window.vl.bars().length);
  await page.keyboard.press('r');
  await expect(page.locator('#replay-bar')).toBeVisible();
  await page.selectOption('#rp-speed', '30');
  await page.keyboard.press(' ');
  await page.waitForTimeout(1500);
  await page.keyboard.press(' ');
  const s = await page.evaluate(() => {
    const st = window.vl.state, b = window.vl.bars(), now = b[st.upto - 1][0];
    return { upto: st.upto, i0: st.replay.i0, now, lastCandle: st.candles.at(-1)?.[0] ?? 0,
      seriesLen: window.vl.volChart.panes().length, alertsAhead: st.view.alerts.filter((a) => a.i < st.upto && a.t > now).length };
  });
  expect(s.upto).toBeGreaterThan(s.i0 + 1);
  expect(s.upto).toBeLessThan(n);
  expect(s.lastCandle).toBeLessThanOrEqual(s.now);
  expect(s.alertsAhead).toBe(0);
  const clock = await page.locator('#rp-clock').textContent();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#rp-clock')).not.toHaveText(clock);
  await page.keyboard.press('Escape');
  await expect(page.locator('#replay-bar')).toBeHidden();
  expect(await page.evaluate(() => window.vl.state.upto)).toBe(n);
  await settle(page);
  await expectInSync(page);
});

test('unfold: clicking a time candle reveals the volume candles inside it', async ({ page }) => {
  await open(page);
  const box = await page.locator('#time-chart').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await expect(page.locator('#unfold-card')).toBeVisible();
  await expect(page.locator('#unfold-card')).toContainText(/holds|No volume candle/);
  await settle(page, 900);
  await expectInSync(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#unfold-card')).toBeHidden();
});

test('layers, theme, scanner and session list', async ({ page }) => {
  await open(page);
  await page.click('#layers summary');
  await page.check('[data-layer="fill"]');
  await page.check('[data-layer="aai"]');
  expect(await page.evaluate(() => window.vl.volChart.panes().length)).toBe(4);
  await expect(page.locator('#legend-fill')).toBeVisible();
  await expectLegendsPlaced(page);
  await page.uncheck('[data-layer="fill"]');
  await page.uncheck('[data-layer="aai"]');
  expect(await page.evaluate(() => window.vl.volChart.panes().length)).toBe(2);
  await page.check('[data-layer="hollow"]');
  await page.uncheck('[data-layer="hollow"]');
  await page.uncheck('[data-layer="compare"]');
  await expect(page.locator('#time-wrap')).toBeHidden();
  await page.check('[data-layer="compare"]');
  await expect(page.locator('#time-wrap')).toBeVisible();
  await page.click('#theme-btn');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.click('#theme-btn');
  await page.click('#scanner tr[data-sym="SBIN"]');
  await page.waitForFunction(() => window.vl.state.symbol === 'SBIN' && document.getElementById('state-overlay').classList.contains('hidden'));
  await expect(page.locator('#legend-vol')).toContainText('SBIN');
  await page.click('#top-sessions li:first-child');
  await page.waitForFunction(() => document.getElementById('state-overlay').classList.contains('hidden'));
  await settle(page);
  await expectInSync(page);
});

test('chart types: Volume Bricks follow the Renko rule, candles and line draw the same bars', async ({ page }) => {
  await open(page);
  await expect(page.locator('#ctype button.on')).toHaveText('Bricks');                  // bricks are the default
  const bricks = await page.evaluate(() => {
    const { volChart, bars } = window.vl, b = bars();
    const data = volChart.panes()[0].getSeries()[0].data();
    let continuous = true;
    for (let k = 1; k < b.length; k++) {
      const sameSession = b[k][15] === b[k - 1][15];
      if (sameSession && data[k].open !== b[k - 1][5]) continuous = false;              // brick starts at the previous close
      if (data[k].close !== b[k][5] || data[k].high !== Math.max(data[k].open, data[k].close)) continuous = false;
    }
    return { continuous, n: data.length, bars: b.length };
  });
  expect(bricks.continuous).toBe(true);
  expect(bricks.n).toBe(bricks.bars);
  await expect(page.locator('#legend-vol')).toContainText('Volume Bricks · 1 brick =');

  await page.click('#ctype button[data-v=candles]');
  const candles = await page.evaluate(() => {
    const { volChart, bars } = window.vl, b = bars(), d = volChart.panes()[0].getSeries()[0].data();
    return d.every((p, k) => p.open === b[k][2] && p.high === b[k][3] && p.low === b[k][4] && p.close === b[k][5]);
  });
  expect(candles).toBe(true);

  await page.click('#ctype button[data-v=line]');
  const line = await page.evaluate(() => {
    const { volChart, bars } = window.vl, s = volChart.panes()[0].getSeries().find((x) => x.seriesType() === 'Area');
    return { visible: s.options().visible, n: s.data().length, bars: bars().length };
  });
  expect(line).toEqual({ visible: true, n: line.bars, bars: line.bars });
  await expect(page.locator('#status-data')).toContainText('Urgency Line');

  await page.reload();                                                                   // remembered
  await page.waitForFunction(() => window.vl && window.vl.bars().length);
  await expect(page.locator('#ctype button.on')).toHaveText('Line');
  await page.click('#ctype button[data-v=bricks]');
  await expectLegendsPlaced(page);
});

test('chart settings: colour modes, thresholds, clock overlays, scales, saved and reset', async ({ page }) => {
  await open(page);
  const urgentShare = () => page.evaluate(() => { const b = window.vl.bars(); return b.filter((r) => r[12] === 2).length / b.length; });
  const lastColor = () => page.evaluate(() => {
    const b = window.vl.bars(), k = b.findIndex((r) => r[11] >= 90);
    return window.vl.state.settings.colorBy + ':' + (k >= 0 ? k : -1);
  });
  const base = await urgentShare();

  await page.keyboard.press(',');
  await expect(page.locator('#settings')).toBeVisible();
  await expect(page.locator('#set-size-note')).toContainText('1 candle =');

  await page.click('[data-tab=style]');
  await page.check('input[data-set=colorBy][value=heat]');
  expect(await lastColor()).toMatch(/^heat:/);

  await page.click('[data-tab=urgency]');
  await page.locator('input[data-set=urgent]').fill('80');
  await expect(page.locator('#out-urgent')).toHaveText('80');
  const strict = await urgentShare();
  expect(strict).toBeLessThan(base);                                  // a higher threshold flags fewer candles

  await page.click('[data-tab=clock]');
  await page.check('input[data-set=ribbon]');
  await page.selectOption('select[data-set=bandMin]', '60');

  await page.click('[data-tab=scales]');
  await page.check('input[data-set=scale][value=log]');
  expect(await page.evaluate(() => window.vl.volChart.priceScale('right', 0).options().mode)).toBe(1);

  await page.click('[data-tab=candles]');
  await page.check('input[name=density][value=fine]');
  await expect(page.locator('#density button.on')).toHaveText('Small');
  await page.click('#settings button[value=done]');
  await expect(page.locator('#settings')).toBeHidden();

  await page.reload();                                                 // remembered in this browser
  await page.waitForFunction(() => window.vl && window.vl.bars().length);
  const s = await page.evaluate(() => window.vl.state.settings);
  expect(s).toMatchObject({ colorBy: 'heat', urgent: 80, ribbon: true, bandMin: 60, scale: 'log' });
  expect(await page.evaluate(() => window.vl.bars().every((r) => (r[12] === 2) === (r[11] != null && r[11] >= 80)))).toBe(true);

  await page.keyboard.press(',');
  await page.click('#settings-reset');
  await page.click('#settings button[value=done]');
  expect(await page.evaluate(() => window.vl.state.settings)).toMatchObject({ colorBy: 'both', urgent: 60, watch: 30, scale: 'normal', ribbon: false });
  await expect(page.locator('#density button.on')).toHaveText('Medium');
  expect(await urgentShare()).toBeCloseTo(base, 3);                   // defaults restore the engine's classes exactly
  await expectLegendsPlaced(page);
});

test('snapshot downloads a PNG', async ({ page }) => {
  await open(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
  expect(dl.suggestedFilename()).toMatch(/^VolumeLens_RELIANCE_2026-\d\d-\d\d\.png$/);
});

test('shows a clear error and recovers when data cannot load', async ({ page }) => {
  let fail = true;
  await page.route('**/data/index.json', (r) => (fail ? r.fulfill({ status: 503, body: '' }) : r.continue()));
  await page.goto('/terminal.html?debug');
  await expect(page.locator('#state-overlay')).toContainText('Could not load');
  errors = errors.filter((e) => !e.includes('503'));
  fail = false;
  await page.click('#retry');
  await page.waitForFunction(() => window.vl && window.vl.state.symbol && window.vl.bars().length);
});

for (const [w, h] of [[1920, 1080], [1366, 768], [1024, 768]]) {
  test(`layout holds at ${w}x${h} in both themes`, async ({ page }, info) => {
    await page.setViewportSize({ width: w, height: h });
    await open(page);
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
      await page.waitForTimeout(450);
      await page.screenshot({ path: `test-results/screens/${info.project.name}-${w}x${h}-${theme}.png` });
    }
  });
}

test('phone (390x844, opened from the QR code): chart first, no sideways scroll, everything reachable', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const r = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      chartTop: box('vol-wrap').top, chartH: box('vol-wrap').height, chartW: box('vol-wrap').width,
      toolbarBottom: document.querySelector('.toolbar').getBoundingClientRect().bottom,
      railHidden: getComputedStyle(document.querySelector('.rail')).display === 'none',
      scanner: document.querySelectorAll('#scanner tr').length,
    };
  });
  expect(r.overflow).toBeLessThanOrEqual(0);
  expect(r.railHidden).toBe(true);
  expect(r.chartTop).toBeLessThan(200);                   // the chart is on the first screen
  expect(r.chartH).toBeGreaterThan(300);
  expect(r.chartW).toBeGreaterThanOrEqual(388);
  expect(r.scanner).toBeGreaterThan(5);
  await expect(page.locator('#scanner')).toBeAttached();
  await page.locator('#results').scrollIntoViewIfNeeded();
  await expect(page.locator('#results')).toBeInViewport();
  await page.screenshot({ path: `test-results/screens/${info.project.name}-phone.png`, fullPage: true });
});

test('smoothness: zooming and panning do not slow the frame rate', async ({ page }) => {
  await open(page);
  const measure = (n) => page.evaluate((count) => new Promise((done) => {
    const f = []; const tick = (t) => { f.push(t); if (f.length < count) requestAnimationFrame(tick); else done(f); };
    requestAnimationFrame(tick);
  }), n);
  const stats = (f) => { const g = f.slice(1).map((t, i) => t - f[i]).sort((x, y) => x - y); return { median: g[Math.floor(g.length / 2)], p95: g[Math.floor(g.length * 0.95)] }; };
  const idle = stats(await measure(60));                 // this browser's own frame rate at rest
  const box = await mainChart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + 150);
  const busy = measure(240);
  for (let k = 0; k < 20; k++) { await page.mouse.wheel(0, k < 10 ? -200 : 200); await page.waitForTimeout(25); }
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + 150, { steps: 30 });
  await page.mouse.up();
  const s = stats(await busy);
  console.log(`frames: idle median ${idle.median.toFixed(1)} ms, while interacting median ${s.median.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms`);
  expect(s.median).toBeLessThanOrEqual(idle.median * 1.25 + 1);   // interaction keeps the browser's full frame rate
  expect(s.p95).toBeLessThan(Math.max(50, idle.median * 2.5));     // no visible stutter
});

test('accessibility: no serious or critical WCAG 2 AA issues', async ({ page }) => {
  await open(page);
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('canvas').analyze();
  const bad = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} × ${v.help}`)).toEqual([]);
});
