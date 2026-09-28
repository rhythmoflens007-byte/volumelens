/* VolumeLens front end: two linked Lightweight Charts instances.
 * Time chart (5-minute candles) on top; volume chart below with three panes:
 * volume candles, fill time + VPIN, absorption. Data comes from data/<SYMBOL>/<date>.json. */
(() => {
  'use strict';
  const LWC = window.LightweightCharts;

  // bar row layout written by run.py
  const B = { T: 0, START: 1, O: 2, H: 3, L: 4, C: 5, FILL: 6, FILLS: 7, BASE: 8, PACE: 9, SPEED: 10, ZONE: 11, VPIN: 12, AAI: 13, AAIS: 14, PROB: 15 };
  const FAST = 2, WATCH = 1;

  const THEMES = {
    dark: { bg: '#131722', text: '#d1d4dc', muted: '#787b86', grid: '#1e222d', border: '#2a2e39', neutral: '#434651', smooth: '#d1d4dc' },
    light: { bg: '#ffffff', text: '#131722', muted: '#787b86', grid: '#f0f3fa', border: '#e0e3eb', neutral: '#c3c6ce', smooth: '#131722' },
  };
  const C = { up: '#089981', down: '#f23645', fast: '#ff9800', watch: '#b8741a', vpin: '#2962ff', aai: '#ab47bc', shade: 'rgba(255,152,0,0.13)', hover: 'rgba(41,98,255,0.18)' };

  const $ = (id) => document.getElementById(id);
  const state = { index: null, symbol: null, date: null, day: null, theme: 'dark', crosshairLock: false, rangeLock: false, activeAlert: null, cursor: null };
  const fmt = (v, d = 2) => (v == null ? '–' : Number(v).toFixed(d));
  const inr = (v) => Number(v).toLocaleString('en-IN');
  const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);   // times are stored as IST-as-UTC

  // ---------- charts ----------
  const baseOptions = () => {
    const th = THEMES[state.theme];
    return {
      autoSize: true,
      layout: { background: { type: 'solid', color: th.bg }, textColor: th.text, fontSize: 11, panes: { separatorColor: th.border, separatorHoverColor: th.border, enableResize: true } },
      grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
      rightPriceScale: { borderColor: th.border },
      leftPriceScale: { borderColor: th.border },
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
    if (state.day) render();
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
    renderWatchlist();
    renderResults();
    const [hs, hd] = decodeURIComponent(location.hash.slice(1)).split('/');
    const first = state.index.stocks.find((s) => s.symbol === hs) || state.index.stocks.find((s) => s.symbol === 'RELIANCE') || state.index.stocks[0];
    await load(first.symbol, hd);
  }

  async function load(symbol, date) {
    const stock = state.index.stocks.find((s) => s.symbol === symbol);
    if (!stock) return;
    const dates = stock.dates.map((d) => d.date);
    date = dates.includes(date) ? date : pickDefaultDate(stock);
    state.symbol = symbol; state.date = date; state.activeAlert = null; state.cursor = null;
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
    render();
    renderWatchlist();
  }

  // open on the most recent day that has at least one alert, so first-time visitors see the idea
  function pickDefaultDate(stock) {
    const withAlerts = stock.dates.filter((d) => d.alerts > 0);
    return (withAlerts.length ? withAlerts[withAlerts.length - 1] : stock.dates[stock.dates.length - 1]).date;
  }

  // ---------- render ----------
  function render() {
    const d = state.day, th = THEMES[state.theme];
    const bars = d.bars;

    tCandles.setData(d.candles.map(([t, o, h, l, c]) => ({ time: t, open: o, high: h, low: l, close: c })));
    tVol.setData(d.candles.map(([t, o, , , c, v]) => ({ time: t, value: v, color: c >= o ? 'rgba(8,153,129,0.35)' : 'rgba(242,54,69,0.35)' })));
    renderZoneShading();
    tHover.setData([]);
    highlighted = null;

    vCandles.setData(bars.map((r) => {
      const fast = r[B.SPEED] === FAST;
      const col = fast ? C.fast : r[B.C] >= r[B.O] ? C.up : C.down;
      return { time: r[B.T], open: r[B.O], high: r[B.H], low: r[B.L], close: r[B.C], color: col, wickColor: col };
    }));
    vFill.setData(bars.map((r) => {
      const cap = r[B.BASE] ? Math.min(r[B.FILL], 4 * r[B.BASE]) : r[B.FILL];
      const col = r[B.SPEED] === FAST ? C.fast : r[B.SPEED] === WATCH ? C.watch : th.neutral;
      return { time: r[B.T], value: cap, color: col };
    }));
    vFillS.setData(bars.map((r) => ({ time: r[B.T], value: r[B.FILLS] })));
    vBase.setData(bars.filter((r) => r[B.BASE] != null).map((r) => ({ time: r[B.T], value: r[B.BASE] })));
    vVpin.setData(bars.filter((r) => r[B.VPIN] != null).map((r) => ({ time: r[B.T], value: r[B.VPIN] })));
    vAai.setData(bars.filter((r) => r[B.AAIS] != null).map((r) => ({ time: r[B.T], value: Math.max(-1.5, r[B.AAIS]) })));
    markers.setMarkers(d.alerts.map((a) => ({ time: a.t, position: 'aboveBar', shape: 'arrowDown', color: C.vpin })));

    $('bar-size').textContent = `${inr(d.barSize)} sh`;
    const stock = state.index.stocks.find((s) => s.symbol === d.symbol);
    $('status-data').textContent = `${d.symbol} · ${d.date} · NSE 1-minute data · ${bars.length} volume candles · data as of ${stock.dates[stock.dates.length - 1].date} close`;

    renderAlerts();
    timeChart.timeScale().fitContent();
    volChart.timeScale().fitContent();
    updateLegends(null);
    requestAnimationFrame(placeLegends);
  }

  function renderZoneShading() {
    const d = state.day;
    if (!$('zones-toggle').checked) { tShade.setData([]); return; }
    const zoned = new Set();
    for (const r of d.bars) {
      if (r[B.SPEED] !== FAST) continue;
      for (const [t] of d.candles) if (t + 300 > r[B.START] && t < r[B.T]) zoned.add(t);
    }
    tShade.setData(d.candles.map(([t]) => (zoned.has(t) ? { time: t, value: 1, color: C.shade } : { time: t })));
  }

  // ---------- legends ----------
  function kv(k, v, cls = '') { return `<span class="k">${k}</span> <span class="v ${cls}">${v}</span>`; }

  function updateLegends(barIdx, candleIdx) {
    const d = state.day;
    if (!d) return;
    const bars = d.bars;
    const r = bars[barIdx ?? bars.length - 1];
    const c = d.candles[candleIdx ?? d.candles.length - 1];
    if (c) {
      const cls = c[4] >= c[1] ? 'up' : 'down';
      $('legend-time').innerHTML = `<span class="title">${d.symbol} · 5m · time</span>` +
        kv('O', fmt(c[1]), cls) + kv('H', fmt(c[2]), cls) + kv('L', fmt(c[3]), cls) + kv('C', fmt(c[4]), cls) + kv('Vol', inr(c[5]));
    }
    if (!r) return;
    const cls = r[B.C] >= r[B.O] ? 'up' : 'down';
    const speed = r[B.SPEED] === FAST ? ['Fast inflow', 'fast'] : r[B.SPEED] === WATCH ? ['Watch', ''] : ['Normal', ''];
    $('legend-vol').innerHTML = `<span class="title">Volume candles · ${inr(d.barSize)} sh</span>` +
      kv('O', fmt(r[B.O]), cls) + kv('H', fmt(r[B.H]), cls) + kv('L', fmt(r[B.L]), cls) + kv('C', fmt(r[B.C]), cls) +
      kv('', `${hhmm(r[B.START])}–${hhmm(r[B.T])}`) + kv('', speed[0], speed[1]);
    const ratio = r[B.BASE] ? r[B.FILL] / r[B.BASE] : null;
    $('legend-fill').innerHTML = `<span class="title">Fill time</span>` + kv('', `${fmt(r[B.FILL], 1)} min`) +
      kv('normal', `${fmt(r[B.BASE], 1)} min`) + kv('pace', ratio == null ? '–' : `${fmt(r[B.PACE], 2)}×`, r[B.SPEED] === FAST ? 'fast' : '') +
      kv('VPIN', fmt(r[B.VPIN], 2), 'blue');
    const a = r[B.AAIS];
    $('legend-aai').innerHTML = `<span class="title">Absorption</span>` + kv('', fmt(a, 2)) +
      kv('', a == null ? '' : a > 0.6 ? 'price held despite volume' : a < -0.5 ? 'price moved more than usual' : 'normal response');
  }

  function placeLegends() {
    const panes = volChart.panes();
    let top = 0;
    const ids = ['legend-vol', 'legend-fill', 'legend-aai'];
    panes.forEach((p, i) => {
      $(ids[i]).style.top = `${top + 6}px`;
      top += p.getHeight() + 1;
    });
  }

  // ---------- linking the two charts ----------
  const barIndexByTime = (t) => state.day.bars.findIndex((r) => r[B.T] === t);
  const candleIndexByTime = (t) => state.day.candles.findIndex((c) => c[0] === t);

  // Shade the 5-minute candles covered by the hovered volume candle. Updating series data
  // re-fires crosshair events, so this only redraws when the hovered bar changes.
  let highlighted = null;
  function highlightCandlesFor(r) {
    const key = r ? r[B.T] : null;
    if (key === highlighted) return;
    highlighted = key;
    tHover.setData(!r ? [] : state.day.candles.map(([t]) =>
      (t + 300 > r[B.START] && t < r[B.T]) ? { time: t, value: 1, color: C.hover } : { time: t }));
  }

  function candleContaining(ts) {
    const cs = state.day.candles;
    for (let i = cs.length - 1; i >= 0; i--) if (cs[i][0] <= ts) return i;
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
    if (i < 0) return;
    state.cursor = i;
    const r = state.day.bars[i];
    const ci = candleContaining(r[B.T] - 1);
    highlightCandlesFor(r);
    timeChart.setCrosshairPosition(r[B.C], state.day.candles[ci][0], tCandles);
    updateLegends(i, ci);
  }));

  timeChart.subscribeCrosshairMove(guarded((p) => {
    if (p.time == null) { volChart.clearCrosshairPosition(); highlightCandlesFor(null); updateLegends(null); return; }
    const ci = candleIndexByTime(p.time);
    const i = state.day.bars.findIndex((r) => r[B.T] >= p.time && r[B.T] < p.time + 300);
    highlightCandlesFor(null);
    if (i >= 0) volChart.setCrosshairPosition(state.day.bars[i][B.C], state.day.bars[i][B.T], vCandles);
    else volChart.clearCrosshairPosition();
    updateLegends(i >= 0 ? i : null, ci);
  }));

  // Keep both charts on the same stretch of the day. The charts have different x axes
  // (5-minute candles vs volume candles), so ranges are converted index -> time -> index here.
  // Whichever chart the user moved leads; the follower's echo event is ignored briefly.
  let leader = null, leaderUntil = 0;
  const follows = (who) => leader && leader !== who && performance.now() < leaderUntil;
  const lead = (who) => { leader = who; leaderUntil = performance.now() + 150; };
  const clampIdx = (x, n) => Math.max(0, Math.min(n - 1, x));

  volChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!state.day || !range || follows('vol')) return;
    const bars = state.day.bars, cs = state.day.candles;
    const a = bars[clampIdx(Math.ceil(range.from), bars.length)], b = bars[clampIdx(Math.floor(range.to), bars.length)];
    const c0 = candleContaining(a[B.START]), c1 = candleContaining(b[B.T] - 1);
    const pad = (range.to - range.from) > bars.length ? 2 : 0.5;
    lead('vol');
    timeChart.timeScale().setVisibleLogicalRange({ from: c0 - pad, to: Math.min(cs.length - 1, c1) + pad });
  });
  timeChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!state.day || !range || follows('time')) return;
    const bars = state.day.bars, cs = state.day.candles;
    const t0 = cs[clampIdx(Math.ceil(range.from), cs.length)][0];
    const t1 = cs[clampIdx(Math.floor(range.to), cs.length)][0] + 300;
    let i0 = bars.findIndex((r) => r[B.T] > t0);
    let i1 = bars.length - 1;
    while (i1 > 0 && bars[i1][B.START] >= t1) i1--;
    if (i0 < 0 || i1 < i0) return;
    lead('time');
    volChart.timeScale().setVisibleLogicalRange({ from: i0 - 0.5, to: i1 + 0.5 });
  });

  // ---------- sidebar ----------
  function renderWatchlist() {
    $('watchlist').innerHTML = state.index.stocks.map((s) => {
      const cls = s.change >= 0 ? 'up' : 'down';
      return `<tr data-sym="${s.symbol}" class="${s.symbol === state.symbol ? 'active' : ''}"><td>${s.symbol}</td><td>${fmt(s.last)}</td><td class="${cls}">${s.change >= 0 ? '+' : ''}${fmt(s.change)}</td></tr>`;
    }).join('');
  }
  $('watchlist').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) load(tr.dataset.sym);
  });

  function renderAlerts() {
    const d = state.day;
    $('alert-count').textContent = d.alerts.length ? `${d.alerts.length} today` : '';
    if (!d.alerts.length) {
      $('alerts').innerHTML = '<li class="empty">No alerts on this day. Days with alerts are marked ● in the date list.</li>';
      return;
    }
    $('alerts').innerHTML = d.alerts.map((a, k) =>
      `<li data-k="${k}"><div class="row1"><span class="kind">${a.kind}</span><span class="time">${hhmm(a.t)} · score ${Math.round(a.prob * 100)}</span></div>` +
      `<ul class="reasons">${a.reasons.map((x) => `<li>${x}</li>`).join('')}</ul></li>`).join('');
  }
  $('alerts').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-k]');
    if (!li) return;
    focusAlert(Number(li.dataset.k));
  });

  function focusAlert(k) {
    const a = state.day.alerts[k];
    document.querySelectorAll('#alerts > li').forEach((el) => el.classList.toggle('active', Number(el.dataset.k) === k));
    const n = state.day.bars.length;
    volChart.timeScale().setVisibleLogicalRange({ from: Math.max(-0.5, a.i - 20), to: Math.min(n - 0.5, a.i + 12) });
    focusBar(a.i);
  }

  function focusBar(i) {
    const r = state.day.bars[i];
    if (!r) return;
    state.cursor = i;
    volChart.setCrosshairPosition(r[B.C], r[B.T], vCandles);
  }

  function renderResults() {
    const r = state.index.results;
    const rows = [['Time chart (5-min volume)', 'time_chart'], ['VPIN (rebuilt)', 'vpin'], ['Volume bars only', 'volume_bars'], ['VolumeLens', 'volumelens']];
    $('results').innerHTML = '<thead><tr><th>Method</th><th>AUC</th><th>Caught</th></tr></thead><tbody>' +
      rows.map(([label, k]) => `<tr class="${k === 'volumelens' ? 'ours' : ''}"><td>${label}</td><td>${fmt(r.auc[k], 3)}</td><td>${Math.round(r.catch_rate[k] * 100)}%</td></tr>`).join('') + '</tbody>';
    const wins = Object.values(r.per_stock).filter((s) => s.auc_volumelens > s.auc_vpin).length;
    $('results-note').textContent = `${r.rows.toLocaleString('en-IN')} volume candles on ${r.test_days.length} unseen trading days. Big move = 30-min range over 2× normal (base rate ${Math.round(r.base_rate * 100)}%). "Caught" compares methods at the same number of alerts. Beats VPIN on ${wins} of ${Object.keys(r.per_stock).length} stocks.`;
  }

  // ---------- toolbar ----------
  function fillDates(stock) {
    const sel = $('date-select');
    sel.innerHTML = stock.dates.map((d) => `<option value="${d.date}">${d.date}${d.alerts ? '  ●' : ''}</option>`).join('');
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

  $('zones-toggle').addEventListener('change', () => state.day && renderZoneShading());
  $('theme-btn').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('vl-theme', state.theme); } catch (e) { /* storage blocked */ }
    applyTheme();
  });
  $('help-btn').addEventListener('click', () => $('help').showModal());

  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof Element && e.target.matches('input, select');
    if (!state.day || typing || $('help').open) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const n = state.day.bars.length;
      const i = Math.max(0, Math.min(n - 1, (state.cursor ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1)));
      focusBar(i);
    } else if (e.key === 'Escape') {
      timeChart.timeScale().fitContent(); volChart.timeScale().fitContent();
    }
  });

  // ---------- resizable split between the two charts ----------
  const resizer = $('resizer'), timeWrap = $('time-wrap');
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    const total = timeWrap.parentElement.getBoundingClientRect();
    const move = (ev) => {
      const pct = Math.min(70, Math.max(18, ((ev.clientY - total.top) / total.height) * 100));
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
