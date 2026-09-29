/* VolumeLens front end.
 * Two linked Lightweight Charts: a 5-minute time chart on top, and below it volume candles,
 * fill time + VPIN, and absorption. Everything is drawn up to a cursor (`state.upto`), so the
 * replay mode and the normal view share one render path. Data: data/index.json and
 * data/<SYMBOL>/<date>.json, written by run.py. */
(() => {
  'use strict';
  const LWC = window.LightweightCharts;

  // bar row layout written by run.py
  const B = { T: 0, START: 1, O: 2, H: 3, L: 4, C: 5, FILL: 6, FILLS: 7, BASE: 8, PACE: 9, SPEED: 10, ZONE: 11, VPIN: 12, AAI: 13, AAIS: 14, PROB: 15 };
  const URGENT = 2, WATCH = 1;
  const CANDLE_SEC = 300;

  const THEMES = {
    dark: { bg: '#131722', text: '#d1d4dc', muted: '#787b86', grid: '#1e222d', border: '#2a2e39', neutral: '#434651', smooth: '#d1d4dc' },
    light: { bg: '#ffffff', text: '#131722', muted: '#787b86', grid: '#f0f3fa', border: '#e0e3eb', neutral: '#c3c6ce', smooth: '#131722' },
  };
  const C = { up: '#089981', down: '#f23645', urgent: '#ff9800', watch: '#b8741a', vpin: '#2962ff', aai: '#ab47bc', shade: 'rgba(255,152,0,0.13)', hover: 'rgba(41,98,255,0.18)' };

  const $ = (id) => document.getElementById(id);
  const state = {
    index: null, symbol: null, date: null, day: null, theme: 'dark',
    upto: 0,                  // number of volume bars currently drawn
    cursor: null,             // bar under the crosshair / keyboard focus
    replay: false, playing: false, timer: null,
    crosshairLock: false,
  };
  const fmt = (v, d = 2) => (v == null ? '–' : Number(v).toFixed(d));
  const inr = (v) => Number(v).toLocaleString('en-IN');
  const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);          // times are IST-as-UTC
  const hhmmss = (t) => new Date(t * 1000).toISOString().slice(11, 19);
  const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // ---------- charts ----------
  const baseOptions = () => {
    const th = THEMES[state.theme];
    return {
      autoSize: true,
      layout: { background: { type: 'solid', color: th.bg }, textColor: th.text, fontSize: 11, panes: { separatorColor: th.border, separatorHoverColor: th.border, enableResize: true } },
      grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
      rightPriceScale: { borderColor: th.border },
      timeScale: { borderColor: th.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      localization: { priceFormatter: (p) => p.toFixed(2) },
    };
  };

  const timeChart = LWC.createChart($('time-chart'), baseOptions());
  const tShade = timeChart.addSeries(LWC.HistogramSeries, { priceScaleId: 'shade', priceLineVisible: false, lastValueVisible: false });
  const tHover = timeChart.addSeries(LWC.HistogramSeries, { priceScaleId: 'shade', priceLineVisible: false, lastValueVisible: false });
  const tVol = timeChart.addSeries(LWC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
  const tCandles = timeChart.addSeries(LWC.CandlestickSeries, { upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down });
  timeChart.priceScale('shade').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
  timeChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });

  const volChart = LWC.createChart($('vol-chart'), baseOptions());
  const vCandles = volChart.addSeries(LWC.CandlestickSeries, { upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down }, 0);
  const vFill = volChart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom', formatter: (v) => v.toFixed(1) + 'm' } }, 1);
  const vFillS = volChart.addSeries(LWC.LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, 1);
  const vBase = volChart.addSeries(LWC.LineSeries, { lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, 1);
  const vVpin = volChart.addSeries(LWC.LineSeries, { color: C.vpin, lineWidth: 2, priceScaleId: 'vpin', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }) }, 1);
  const vAai = volChart.addSeries(LWC.BaselineSeries, {
    baseValue: { type: 'price', price: 0 }, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    topLineColor: C.aai, topFillColor1: 'rgba(171,71,188,0.28)', topFillColor2: 'rgba(171,71,188,0.04)',
    bottomLineColor: '#787b86', bottomFillColor1: 'rgba(120,123,134,0.04)', bottomFillColor2: 'rgba(120,123,134,0.2)',
    autoscaleInfoProvider: () => ({ priceRange: { minValue: -1.5, maxValue: 1 } }),
  }, 2);
  vAai.createPriceLine({ price: 1, color: C.aai, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false });
  const markers = LWC.createSeriesMarkers(vCandles, []);
  volChart.panes()[0].setStretchFactor(3);
  volChart.panes()[1].setStretchFactor(1.6);
  volChart.panes()[2].setStretchFactor(1.1);
  volChart.priceScale('vpin', 1).applyOptions({ scaleMargins: { top: 0.2, bottom: 0.05 }, visible: false });

  function applyTheme() {
    const th = THEMES[state.theme];
    document.documentElement.dataset.theme = state.theme;
    $('theme-btn').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
    for (const ch of [timeChart, volChart]) ch.applyOptions(baseOptions());
    vFillS.applyOptions({ color: th.smooth });
    vBase.applyOptions({ color: th.muted });
    if (state.day) draw();
  }

  // ---------- data ----------
  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  async function init() {
    try {
      state.index = await getJSON('data/index.json');
    } catch (e) {
      $('status-data').textContent = 'Could not load data/index.json';
      return;
    }
    renderProof();
    renderTopSessions();
    const [hs, hd] = decodeURIComponent(location.hash.slice(1)).split('/');
    const byScore = allSessions()[0];
    const stock = state.index.stocks.find((s) => s.symbol === hs);
    if (stock) await load(stock.symbol, hd);
    else await load(byScore.symbol, byScore.date);       // first visit: open the most urgent session
  }

  async function load(symbol, date) {
    const stock = state.index.stocks.find((s) => s.symbol === symbol);
    if (!stock) return;
    exitReplay(false);
    const dates = stock.dates.map((d) => d.date);
    date = dates.includes(date) ? date : dates[dates.length - 1];
    state.symbol = symbol; state.date = date; state.cursor = null;
    $('symbol-input').value = symbol;
    fillDates(stock);
    history.replaceState(null, '', `#${symbol}/${date}`);
    $('status-data').textContent = `Loading ${symbol} ${date}…`;
    try {
      state.day = await getJSON(`data/${symbol}/${date}.json`);
    } catch (e) {
      $('status-data').textContent = `Could not load ${symbol} ${date}`;
      return;
    }
    state.upto = state.day.bars.length;
    draw();
    fitDay();
    renderScanner();
    const last = stock.dates[stock.dates.length - 1].date;
    $('status-data').textContent = `${symbol} · ${date} · NSE 1-minute data · ${state.day.bars.length} volume candles of ${inr(state.day.barSize)} shares · data as of ${last} close`;
  }

  // ---------- drawing (everything up to state.upto) ----------
  const visibleBars = () => state.day.bars.slice(0, state.upto);
  const lastVisibleTime = () => (state.upto ? state.day.bars[state.upto - 1][B.T] : 0);
  // a 5-minute candle is shown only once it is complete, so replay never shows the future
  const visibleCandles = () => (state.replay
    ? state.day.candles.filter(([t]) => t + CANDLE_SEC <= lastVisibleTime())
    : state.day.candles);

  function draw() {
    const d = state.day, th = THEMES[state.theme];
    const bars = visibleBars(), candles = visibleCandles();

    tCandles.setData(candles.map(([t, o, h, l, c]) => ({ time: t, open: o, high: h, low: l, close: c })));
    tVol.setData(candles.map(([t, o, , , c, v]) => ({ time: t, value: v, color: c >= o ? 'rgba(8,153,129,0.35)' : 'rgba(242,54,69,0.35)' })));
    drawShading(bars, candles);
    tHover.setData([]);
    highlighted = null;

    vCandles.setData(bars.map((r) => {
      const col = r[B.SPEED] === URGENT ? C.urgent : r[B.C] >= r[B.O] ? C.up : C.down;
      return { time: r[B.T], open: r[B.O], high: r[B.H], low: r[B.L], close: r[B.C], color: col, wickColor: col };
    }));
    vFill.setData(bars.map((r) => {
      const cap = r[B.BASE] ? Math.min(r[B.FILL], 4 * r[B.BASE]) : r[B.FILL];
      const col = r[B.SPEED] === URGENT ? C.urgent : r[B.SPEED] === WATCH ? C.watch : th.neutral;
      return { time: r[B.T], value: cap, color: col };
    }));
    vFillS.setData(bars.map((r) => ({ time: r[B.T], value: r[B.FILLS] })));
    vBase.setData(bars.filter((r) => r[B.BASE] != null).map((r) => ({ time: r[B.T], value: r[B.BASE] })));
    vVpin.setData(bars.filter((r) => r[B.VPIN] != null).map((r) => ({ time: r[B.T], value: r[B.VPIN] })));
    vAai.setData(bars.filter((r) => r[B.AAIS] != null).map((r) => ({ time: r[B.T], value: Math.max(-1.5, r[B.AAIS]) })));
    const alerts = d.alerts.filter((a) => a.i < state.upto);
    markers.setMarkers(alerts.map((a) => ({ time: a.t, position: 'aboveBar', shape: 'arrowDown', color: C.vpin })));

    $('bar-size').textContent = `${inr(d.barSize)} sh`;
    renderDayCard(bars, d);
    renderAlerts(alerts);
    updateLegends(null);
    requestAnimationFrame(placeLegends);
  }

  function drawShading(bars, candles) {
    if (!$('zones-toggle').checked) { tShade.setData([]); return; }
    const urgentCandles = new Set();
    for (const r of bars) {
      if (r[B.SPEED] !== URGENT) continue;
      for (const [t] of candles) if (t + CANDLE_SEC > r[B.START] && t < r[B.T]) urgentCandles.add(t);
    }
    tShade.setData(candles.map(([t]) => (urgentCandles.has(t) ? { time: t, value: 1, color: C.shade } : { time: t })));
  }

  function fitDay() {
    lockSync(() => { timeChart.timeScale().fitContent(); volChart.timeScale().fitContent(); });
  }

  // ---------- urgency summary (computed from the bars on screen, so it follows the replay) ----------
  function urgencyOf(bars, candles) {
    if (!bars.length) return null;
    const urgent = bars.map((r) => r[B.SPEED] === URGENT);
    const score = (100 * urgent.filter(Boolean).length) / bars.length;   // every bar holds the same shares
    let best = null;
    for (let i = 0; i < bars.length; i++) {
      if (!urgent[i]) continue;
      let j = i;
      while (j + 1 < bars.length && urgent[j + 1]) j++;
      if (!best || j - i + 1 > best.bars) best = { bars: j - i + 1, i, j };
      i = j;
    }
    if (best) {
      const start = bars[best.i][B.START], end = bars[best.j][B.T];
      best.from = start; best.to = end;
      best.minutes = Math.max(1, Math.round((end - start) / 60));
      best.candles = candles.filter(([t]) => t + CANDLE_SEC > start && t < end).length || 1;
    }
    return { score, best };
  }

  function renderDayCard(bars, d) {
    const u = urgencyOf(bars, d.candles);
    $('day-label').textContent = `${d.symbol} · ${shortDate(d.date)}${state.replay ? ` · until ${hhmm(lastVisibleTime())}` : ''}`;
    $('day-score').textContent = u ? `${Math.round(u.score)}%` : '–';
    if (!u || !u.best) { $('day-burst').textContent = 'No urgent burst so far.'; return; }
    const b = u.best;
    $('day-burst').innerHTML = `Biggest burst: <b>${b.bars} urgent candles in ${b.minutes} min</b> (${hhmm(b.from)}–${hhmm(b.to)}). ` +
      `A 5-minute chart shows it as <b>${b.candles} candle${b.candles > 1 ? 's' : ''}</b>.`;
  }

  // ---------- legends ----------
  function kv(k, v, cls = '') { return `<span class="k">${k}</span> <span class="v ${cls}">${v}</span>`; }

  function updateLegends(barIdx, candleIdx) {
    const d = state.day;
    if (!d) return;
    const bars = visibleBars(), candles = visibleCandles();
    const r = bars[barIdx ?? bars.length - 1];
    const c = candles[candleIdx ?? candles.length - 1];
    $('legend-time').innerHTML = `<span class="title">${d.symbol} · 5m · time</span>` + (c
      ? kv('O', fmt(c[1]), c[4] >= c[1] ? 'up' : 'down') + kv('H', fmt(c[2]), c[4] >= c[1] ? 'up' : 'down') +
        kv('L', fmt(c[3]), c[4] >= c[1] ? 'up' : 'down') + kv('C', fmt(c[4]), c[4] >= c[1] ? 'up' : 'down') + kv('Vol', inr(c[5]))
      : kv('', 'waiting for the first 5-minute candle to complete'));
    if (!r) return;
    const cls = r[B.C] >= r[B.O] ? 'up' : 'down';
    const speed = r[B.SPEED] === URGENT ? ['Urgent', 'urgent'] : r[B.SPEED] === WATCH ? ['Watch', ''] : ['Normal', ''];
    $('legend-vol').innerHTML = `<span class="title">Volume candles · ${inr(d.barSize)} sh</span>` +
      kv('O', fmt(r[B.O]), cls) + kv('H', fmt(r[B.H]), cls) + kv('L', fmt(r[B.L]), cls) + kv('C', fmt(r[B.C]), cls) +
      kv('', `${hhmm(r[B.START])}–${hhmm(r[B.T])}`) + kv('', speed[0], speed[1]);
    $('legend-fill').innerHTML = `<span class="title">Fill time</span>` + kv('', `${fmt(r[B.FILL], 1)} min`) +
      kv('normal', `${fmt(r[B.BASE], 1)} min`) + kv('pace', r[B.PACE] == null ? '–' : `${fmt(r[B.PACE], 2)}×`, r[B.SPEED] === URGENT ? 'urgent' : '') +
      kv('VPIN', fmt(r[B.VPIN], 2), 'blue');
    const a = r[B.AAIS];
    $('legend-aai').innerHTML = `<span class="title">Absorption</span>` + kv('', fmt(a, 2)) +
      kv('', a == null ? '' : a > 0.6 ? 'price held despite volume' : a < -0.5 ? 'price moved more than usual' : 'normal response');
  }

  function placeLegends() {
    let top = 0;
    const ids = ['legend-vol', 'legend-fill', 'legend-aai'];
    volChart.panes().forEach((p, i) => {
      $(ids[i]).style.top = `${top + 6}px`;
      top += p.getHeight() + 1;
    });
  }

  // ---------- linking the two charts ----------
  const barIndexByTime = (t) => state.day.bars.findIndex((r) => r[B.T] === t);
  const candleIndexByTime = (t) => visibleCandles().findIndex((c) => c[0] === t);

  // Shade the 5-minute candles covered by the hovered volume candle. Setting series data
  // re-fires crosshair events, so this only redraws when the hovered bar changes.
  let highlighted = null;
  function highlightCandlesFor(r) {
    const key = r ? r[B.T] : null;
    if (key === highlighted) return;
    highlighted = key;
    tHover.setData(!r ? [] : visibleCandles().map(([t]) =>
      (t + CANDLE_SEC > r[B.START] && t < r[B.T]) ? { time: t, value: 1, color: C.hover } : { time: t }));
  }

  function candleContaining(ts, candles = state.day.candles) {
    for (let i = candles.length - 1; i >= 0; i--) if (candles[i][0] <= ts) return i;
    return 0;
  }

  // One flag guards both handlers: anything they change on the other chart fires that
  // chart's crosshair event synchronously, and it must not bounce back.
  const guarded = (fn) => (p) => {
    if (!state.day || state.crosshairLock) return;
    state.crosshairLock = true;
    try { fn(p); } finally { state.crosshairLock = false; }
  };

  volChart.subscribeCrosshairMove(guarded((p) => {
    if (p.time == null) { highlightCandlesFor(null); timeChart.clearCrosshairPosition(); updateLegends(null); return; }
    const i = barIndexByTime(p.time);
    if (i < 0 || i >= state.upto) return;
    state.cursor = i;
    const r = state.day.bars[i];
    const candles = visibleCandles();
    highlightCandlesFor(r);
    if (candles.length) {
      const ci = candleContaining(r[B.T] - 1, candles);
      timeChart.setCrosshairPosition(r[B.C], candles[ci][0], tCandles);
      updateLegends(i, ci);
    } else {
      updateLegends(i);
    }
  }));

  timeChart.subscribeCrosshairMove(guarded((p) => {
    if (p.time == null) { volChart.clearCrosshairPosition(); highlightCandlesFor(null); updateLegends(null); return; }
    const ci = candleIndexByTime(p.time);
    const i = state.day.bars.findIndex((r, k) => k < state.upto && r[B.T] >= p.time && r[B.T] < p.time + CANDLE_SEC);
    highlightCandlesFor(null);
    if (i >= 0) volChart.setCrosshairPosition(state.day.bars[i][B.C], state.day.bars[i][B.T], vCandles);
    else volChart.clearCrosshairPosition();
    updateLegends(i >= 0 ? i : null, ci);
  }));

  // Keep both charts on the same stretch of the day. The x axes differ (5-minute candles vs
  // volume candles), so ranges are converted index -> time -> index. The chart the user moved
  // leads; the follower's echo is ignored briefly. Replay pins both ranges to the full day.
  let leader = null, leaderUntil = 0;
  const follows = (who) => leader && leader !== who && performance.now() < leaderUntil;
  const lead = (who) => { leader = who; leaderUntil = performance.now() + 150; };
  let syncOff = false;
  const lockSync = (fn) => { syncOff = true; try { fn(); } finally { requestAnimationFrame(() => { syncOff = false; }); } };

  volChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!state.day || !range || syncOff || state.replay || follows('vol')) return;
    const bars = state.day.bars, cs = state.day.candles;
    const a = bars[clamp(Math.ceil(range.from), 0, bars.length - 1)], b = bars[clamp(Math.floor(range.to), 0, bars.length - 1)];
    const c0 = candleContaining(a[B.START]), c1 = candleContaining(b[B.T] - 1);
    lead('vol');
    timeChart.timeScale().setVisibleLogicalRange({ from: c0 - 0.5, to: Math.min(cs.length - 1, c1) + 0.5 });
  });
  timeChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!state.day || !range || syncOff || state.replay || follows('time')) return;
    const bars = state.day.bars, cs = state.day.candles;
    const t0 = cs[clamp(Math.ceil(range.from), 0, cs.length - 1)][0];
    const t1 = cs[clamp(Math.floor(range.to), 0, cs.length - 1)][0] + CANDLE_SEC;
    const i0 = bars.findIndex((r) => r[B.T] > t0);
    let i1 = bars.length - 1;
    while (i1 > 0 && bars[i1][B.START] >= t1) i1--;
    if (i0 < 0 || i1 < i0) return;
    lead('time');
    volChart.timeScale().setVisibleLogicalRange({ from: i0 - 0.5, to: i1 + 0.5 });
  });

  // ---------- replay ----------
  function enterReplay() {
    if (!state.day || state.replay) return;
    state.replay = true;
    $('replay-btn').classList.add('on');
    $('replay-bar').hidden = false;
    const scrub = $('rp-scrub');
    scrub.max = String(state.day.bars.length);
    stepTo(1);
    pinFullDay();
  }

  function exitReplay(redraw = true) {
    if (!state.replay) return;
    pause();
    state.replay = false;
    $('replay-btn').classList.remove('on');
    $('replay-bar').hidden = true;
    if (redraw && state.day) {
      state.upto = state.day.bars.length;
      draw();
      fitDay();
    }
  }

  // show the whole session's width so bars arrive left to right, like a live day
  function pinFullDay() {
    const n = state.day.bars.length, m = state.day.candles.length;
    lockSync(() => {
      volChart.timeScale().setVisibleLogicalRange({ from: -1, to: n + 1 });
      timeChart.timeScale().setVisibleLogicalRange({ from: -1, to: m + 1 });
    });
  }

  function stepTo(k) {
    const n = state.day.bars.length;
    state.upto = clamp(k, 1, n);
    state.cursor = state.upto - 1;
    draw();
    pinFullDay();
    $('rp-scrub').value = String(state.upto);
    const t = lastVisibleTime();
    $('rp-clock').textContent = `${hhmmss(t)} · candle ${state.upto}/${n}`;
    if (state.upto >= n) pause();
  }

  // Market pace: each candle waits as long as it took to fill, scaled by the chosen speed,
  // so urgent bursts visibly rush in and quiet stretches crawl.
  function scheduleNext() {
    const speed = Number($('rp-speed').value);               // market minutes per real second
    const r = state.day.bars[state.upto];                   // the bar about to appear
    const delay = r ? clamp((r[B.FILL] / speed) * 1000, 25, 1500) : 0;
    state.timer = setTimeout(() => {
      stepTo(state.upto + 1);
      if (state.playing) scheduleNext();
    }, delay);
  }
  function play() {
    if (!state.replay) enterReplay();
    if (state.upto >= state.day.bars.length) stepTo(1);
    state.playing = true;
    $('rp-play').innerHTML = '&#10074;&#10074;';
    $('rp-play').setAttribute('aria-label', 'Pause');
    scheduleNext();
  }
  function pause() {
    state.playing = false;
    clearTimeout(state.timer);
    $('rp-play').innerHTML = '&#9654;';
    $('rp-play').setAttribute('aria-label', 'Play');
  }
  const togglePlay = () => (state.playing ? pause() : play());

  $('replay-btn').addEventListener('click', () => (state.replay ? exitReplay() : enterReplay()));
  $('rp-play').addEventListener('click', togglePlay);
  $('rp-back').addEventListener('click', () => { pause(); stepTo(state.upto - 1); });
  $('rp-fwd').addEventListener('click', () => { pause(); stepTo(state.upto + 1); });
  $('rp-exit').addEventListener('click', () => exitReplay());
  $('rp-scrub').addEventListener('input', (e) => { pause(); stepTo(Number(e.target.value)); });

  // ---------- sidebar ----------
  function allSessions() {
    return state.index.stocks.flatMap((s) => s.dates.map((d) => ({ symbol: s.symbol, ...d })))
      .sort((a, b) => b.urgency_score - a.urgency_score);
  }

  function renderScanner() {
    const rows = state.index.stocks.map((s) => ({ s, d: s.dates[s.dates.length - 1] }))
      .sort((a, b) => b.d.urgency_score - a.d.urgency_score);
    const top = Math.max(...rows.map((x) => x.d.urgency_score), 1);
    $('scanner').innerHTML = rows.map(({ s, d }) => {
      const burst = d.burst ? `${d.burst.bars} in ${d.burst.minutes}m` : '–';
      const cls = s.change >= 0 ? 'up' : 'down';
      return `<tr data-sym="${s.symbol}" data-date="${d.date}" class="${s.symbol === state.symbol ? 'active' : ''}" title="${s.symbol}, ${d.date}">` +
        `<td>${s.symbol}</td>` +
        `<td><span class="urgency-cell">${Math.round(d.urgency_score)}%<span class="meter"><i style="width:${(100 * d.urgency_score) / top}%"></i></span></span></td>` +
        `<td>${burst}</td><td class="${cls}">${s.change >= 0 ? '+' : ''}${fmt(s.change)}</td></tr>`;
    }).join('');
  }
  $('scanner').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-sym]');
    if (tr) load(tr.dataset.sym, tr.dataset.date);
  });

  function renderTopSessions() {
    $('top-sessions').innerHTML = allSessions().slice(0, 6).map((x) =>
      `<li data-sym="${x.symbol}" data-date="${x.date}"><span>${x.symbol} <span class="when">· ${shortDate(x.date)}${x.burst ? ` · burst ${x.burst.from}` : ''}</span></span>` +
      `<span class="pct">${Math.round(x.urgency_score)}%</span></li>`).join('');
  }
  $('top-sessions').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-sym]');
    if (li) load(li.dataset.sym, li.dataset.date);
  });

  function renderAlerts(alerts) {
    $('alert-count').textContent = alerts.length ? `${alerts.length}` : '';
    if (!alerts.length) {
      $('alerts').innerHTML = `<li class="empty">${state.replay ? 'No alert yet in this replay.' : 'No alerts on this day. Days with alerts are marked ● in the date list.'}</li>`;
      return;
    }
    $('alerts').innerHTML = alerts.map((a, k) =>
      `<li data-k="${k}"><div class="row1"><span class="kind">${a.kind}</span><span class="time">${hhmm(a.t)} · score ${Math.round(a.prob * 100)}</span></div>` +
      `<ul class="reasons">${a.reasons.map((x) => `<li>${x}</li>`).join('')}</ul></li>`).join('');
  }
  $('alerts').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-k]');
    if (!li || state.replay) return;
    const a = state.day.alerts[Number(li.dataset.k)];
    document.querySelectorAll('#alerts > li').forEach((el) => el.classList.toggle('active', el === li));
    const n = state.day.bars.length;
    volChart.timeScale().setVisibleLogicalRange({ from: Math.max(-0.5, a.i - 20), to: Math.min(n - 0.5, a.i + 12) });
    focusBar(a.i);
  });

  function focusBar(i) {
    const r = state.day.bars[i];
    if (!r) return;
    state.cursor = i;
    volChart.setCrosshairPosition(r[B.C], r[B.T], vCandles);
  }

  function renderProof() {
    const r = state.index.results, u = r.urgency;
    const pct = (x) => `${Math.round(x * 100)}%`;
    $('proof').innerHTML = `After an urgent candle, a big move (30-min range over 2× normal) followed <b>${pct(u.all_day.urgent)}</b> of the time, ` +
      `vs ${pct(u.all_day.other)} after other candles: <b>${u.all_day.lift.toFixed(1)}×</b>. Outside the opening hour: <b>${u.after_10_30.lift.toFixed(1)}×</b>. ` +
      `The lift stays ${u.lift_range[0].toFixed(1)}–${u.lift_range[1].toFixed(1)}× for every urgency threshold from ${u.thresholds[0]} to ${u.thresholds[1]}. ` +
      `Urgency does not predict direction.`;
    const rows = [['VPIN (rebuilt)', 'vpin'], ['Volume bars only', 'volume_bars'], ['Time chart: volume spike', 'time_chart'], ['Time chart: 30-min range', 'recent_volatility'], ['VolumeLens alerts', 'volumelens']];
    const wins = Object.values(r.per_stock).filter((s) => s.auc_volumelens > s.auc_vpin).length;
    $('results').innerHTML = `<caption>Walk-forward, ${r.test_days.length} unseen days · beats VPIN on ${wins}/${Object.keys(r.per_stock).length} stocks</caption>` +
      '<thead><tr><th>Method</th><th>AUC</th><th>Caught</th></tr></thead><tbody>' +
      rows.map(([label, k]) => `<tr class="${k === 'volumelens' ? 'ours' : ''}"><td>${label}</td><td>${fmt(r.auc[k], 3)}</td><td>${Math.round(r.catch_rate[k] * 100)}%</td></tr>`).join('') + '</tbody>';
  }

  // ---------- toolbar ----------
  function fillDates(stock) {
    const sel = $('date-select');
    sel.innerHTML = stock.dates.map((d) => `<option value="${d.date}">${d.date} · ${Math.round(d.urgency_score)}%${d.alerts ? ' ●' : ''}</option>`).join('');
    sel.value = state.date;
    const i = stock.dates.findIndex((d) => d.date === state.date);
    $('prev-day').disabled = i <= 0;
    $('next-day').disabled = i >= stock.dates.length - 1;
  }
  $('date-select').addEventListener('change', (e) => load(state.symbol, e.target.value));
  function stepDay(dir) {
    const stock = state.index.stocks.find((s) => s.symbol === state.symbol);
    const i = stock.dates.findIndex((d) => d.date === state.date) + dir;
    if (i >= 0 && i < stock.dates.length) load(state.symbol, stock.dates[i].date);
  }
  $('prev-day').addEventListener('click', () => stepDay(-1));
  $('next-day').addEventListener('click', () => stepDay(1));

  const symInput = $('symbol-input'), symList = $('symbol-list');
  let symActive = 0;
  function showSymbols() {
    const q = symInput.value.trim().toUpperCase();
    const hits = state.index.stocks.filter((s) => s.symbol.includes(q));
    symActive = Math.min(symActive, Math.max(0, hits.length - 1));
    symList.innerHTML = hits.map((s, i) => `<li data-sym="${s.symbol}" class="${i === symActive ? 'active' : ''}"><span>${s.symbol}</span><span class="muted">${s.dates.length} days</span></li>`).join('') || '<li class="muted">No match</li>';
    symList.hidden = false;
  }
  symInput.addEventListener('focus', () => { symInput.select(); symActive = 0; showSymbols(); });
  symInput.addEventListener('input', () => { symActive = 0; showSymbols(); });
  symInput.addEventListener('keydown', (e) => {
    const items = [...symList.querySelectorAll('li[data-sym]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      symActive = (symActive + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
      showSymbols();
    } else if (e.key === 'Enter' && items[symActive]) {
      symList.hidden = true; symInput.blur(); load(items[symActive].dataset.sym);
    } else if (e.key === 'Escape') {
      symList.hidden = true; symInput.value = state.symbol; symInput.blur();
    }
  });
  symList.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-sym]');
    if (li) { e.preventDefault(); symList.hidden = true; symInput.blur(); load(li.dataset.sym); }
  });
  symInput.addEventListener('blur', () => { setTimeout(() => { symList.hidden = true; symInput.value = state.symbol || ''; }, 100); });

  $('zones-toggle').addEventListener('change', () => state.day && drawShading(visibleBars(), visibleCandles()));
  $('theme-btn').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('vl-theme', state.theme); } catch (e) { /* storage blocked */ }
    applyTheme();
  });
  $('help-btn').addEventListener('click', () => $('help').showModal());

  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof Element && e.target.matches('input:not([type=range]), select');
    if (!state.day || typing || $('help').open) return;
    const n = state.day.bars.length;
    if (e.key === 'r' || e.key === 'R') {
      state.replay ? exitReplay() : enterReplay();
    } else if (e.key === ' ' && state.replay) {
      e.preventDefault(); togglePlay();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (state.replay) { pause(); stepTo(state.upto + dir); }
      else focusBar(clamp((state.cursor ?? n - 1) + dir, 0, n - 1));
    } else if (e.key === 'Escape') {
      state.replay ? exitReplay() : fitDay();
    }
  });

  // ---------- resizable split between the two charts ----------
  const resizer = $('resizer'), timeWrap = $('time-wrap');
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    const total = timeWrap.parentElement.getBoundingClientRect();
    const move = (ev) => {
      const pct = clamp(((ev.clientY - total.top) / total.height) * 100, 18, 70);
      timeWrap.style.flexBasis = `${pct}%`;
    };
    const up = () => { resizer.classList.remove('dragging'); resizer.removeEventListener('pointermove', move); resizer.removeEventListener('pointerup', up); requestAnimationFrame(placeLegends); };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });
  new ResizeObserver(() => requestAnimationFrame(placeLegends)).observe($('vol-wrap'));

  try { state.theme = localStorage.getItem('vl-theme') || 'dark'; } catch (e) { state.theme = 'dark'; }
  applyTheme();
  init();
})();
