/* VolumeLens terminal.
 *
 * Main chart: volume candles (one candle per fixed number of shares) with a fill-time strip,
 * optional absorption pane. Compare chart: a normal time chart (1-30 min) built in the browser
 * from 1-minute candles. Everything is drawn up to a cursor (state.upto), so replay and the
 * normal view share one render path and replay can only ever show what was known at the time.
 * Data: data/index.json and data/<SYMBOL>/<date>.json, written by run.py. */

import { B, URGENT, WATCH, $, clamp, fmt, inr, hhmm, hhmmss, shortDate, shares, easeInOut, reducedMotion, store } from './util.js?v=24';
import { TIMEFRAMES, aggregate } from './timeframe.js?v=24';
import { createTools } from './tools.js?v=24';

const LWC = window.LightweightCharts;

const THEMES = {
  dark: {
    bg: '#0b0d12', text: '#8b92a0', grid: '#141821', line: '#222835', neutral: '#363c49', smooth: '#e3e6ec',
    up: '#1fa37a', down: '#e5484d', accent: '#ff9800', watch: '#9a6414', blue: '#4c7dff', aai: '#b07cff',
    volUp: 'rgba(31,163,122,0.28)', volDown: 'rgba(229,72,77,0.28)', shade: 'rgba(255,152,0,0.12)', hover: 'rgba(76,125,255,0.16)',
    cross: '#5b6270', label: '#2a303c', draw: '#e3e6ec', zoneFill: 'rgba(76,125,255,0.10)', zoneLine: 'rgba(76,125,255,0.6)',
  },
  light: {
    bg: '#f6f7f9', text: '#5b6270', grid: '#eceff3', line: '#e2e5ea', neutral: '#c9ced6', smooth: '#11141b',
    up: '#0f8a63', down: '#d93036', accent: '#e07c00', watch: '#e8b46b', blue: '#2f5fe0', aai: '#7c4dff',
    volUp: 'rgba(15,138,99,0.22)', volDown: 'rgba(217,48,54,0.22)', shade: 'rgba(224,124,0,0.12)', hover: 'rgba(47,95,224,0.14)',
    cross: '#8a909c', label: '#5b6270', draw: '#11141b', zoneFill: 'rgba(47,95,224,0.08)', zoneLine: 'rgba(47,95,224,0.55)',
  },
};

const state = {
  index: null, symbol: null, date: null, day: null,
  theme: store('vl:theme') || 'dark',
  tf: store('vl:tf') || 5,
  magnet: false,
  layers: Object.assign({ compare: true, shade: true, vpin: true, aai: false }, store('vl:layers') || {}),
  upto: 0, cursor: null, candles: [], burst: null,
  replay: false, playing: false, timer: null,
  crosshairLock: false,
};
const th = () => THEMES[state.theme];
const span = () => state.tf * 60;

// ---------------------------------------------------------------- charts
function chartOptions() {
  const t = th();
  const line = { color: t.cross, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: t.label };
  return {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: t.bg }, textColor: t.text, fontSize: 11,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace", attributionLogo: false,
      panes: { separatorColor: t.line, separatorHoverColor: t.line, enableResize: true },
    },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    rightPriceScale: { borderColor: t.line, minimumWidth: 78, scaleMargins: { top: 0.08, bottom: 0.06 } },
    timeScale: { borderColor: t.line, timeVisible: true, secondsVisible: false, rightOffset: 6, minBarSpacing: 0.4 },
    crosshair: { mode: state.magnet ? LWC.CrosshairMode.Magnet : LWC.CrosshairMode.Normal, vertLine: line, horzLine: line },
    localization: { priceFormatter: (p) => p.toFixed(2) },
  };
}
const candleColors = () => ({ upColor: th().up, downColor: th().down, wickUpColor: th().up, wickDownColor: th().down, borderVisible: false });

const volChart = LWC.createChart($('vol-chart'), chartOptions());
const vCandles = volChart.addSeries(LWC.CandlestickSeries, candleColors(), 0);
const vFill = volChart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom', formatter: (v) => `${v.toFixed(1)}m` } }, 1);
const vFillS = volChart.addSeries(LWC.LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, 1);
const vBase = volChart.addSeries(LWC.LineSeries, { lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, 1);
const vVpin = volChart.addSeries(LWC.LineSeries, {
  lineWidth: 1.5, priceScaleId: 'vpin', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }),
}, 1);
volChart.priceScale('vpin', 1).applyOptions({ scaleMargins: { top: 0.15, bottom: 0.05 }, visible: false });
let vAai = null;
const markers = LWC.createSeriesMarkers(vCandles, []);

const timeChart = LWC.createChart($('time-chart'), chartOptions());
const tShade = timeChart.addSeries(LWC.HistogramSeries, { priceScaleId: 'shade', priceLineVisible: false, lastValueVisible: false });
const tHover = timeChart.addSeries(LWC.HistogramSeries, { priceScaleId: 'shade', priceLineVisible: false, lastValueVisible: false });
const tVol = timeChart.addSeries(LWC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
const tCandles = timeChart.addSeries(LWC.CandlestickSeries, candleColors());
timeChart.priceScale('shade').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
timeChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });

const tools = createTools({
  volChart, vCandles, tCandles,
  getDay: () => state.day,
  colors: th,
  onToolChange: (t) => {
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('vol-wrap').style.cursor = t === 'cursor' ? '' : 'crosshair';
  },
});

function setPaneLayout() {
  const panes = volChart.panes();
  panes[0]?.setStretchFactor(4);
  panes[1]?.setStretchFactor(1.3);
  panes[2]?.setStretchFactor(1.1);
}
setPaneLayout();

function setAbsorption(on) {
  if (on && !vAai) {
    vAai = volChart.addSeries(LWC.BaselineSeries, {
      baseValue: { type: 'price', price: 0 }, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: -1.5, maxValue: 1 } }),
    }, 2);
    vAai.createPriceLine({ price: 1, color: th().aai, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false });
    styleAai();
  } else if (!on && vAai) {
    volChart.removeSeries(vAai);
    vAai = null;
    if (volChart.panes().length > 2) volChart.removePane(2);
  }
  setPaneLayout();
  $('legend-aai').hidden = !on;
}
function styleAai() {
  if (!vAai) return;
  const t = th();
  vAai.applyOptions({
    topLineColor: t.aai, topFillColor1: `${t.aai}40`, topFillColor2: `${t.aai}08`,
    bottomLineColor: t.text, bottomFillColor1: 'rgba(120,123,134,0.04)', bottomFillColor2: 'rgba(120,123,134,0.18)',
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('theme-btn').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  for (const ch of [volChart, timeChart]) ch.applyOptions(chartOptions());
  vCandles.applyOptions(candleColors());
  tCandles.applyOptions(candleColors());
  vFillS.applyOptions({ color: th().smooth });
  vBase.applyOptions({ color: th().text });
  vVpin.applyOptions({ color: th().blue });
  styleAai();
  tools.recolor();
  if (state.day) draw();
}

// ---------------------------------------------------------------- data
async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function overlay(kind, message) {
  const el = $('state-overlay');
  if (!kind) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = kind === 'loading'
    ? '<div class="skeleton"></div>'
    : `<div class="message"><div>${message}</div><button class="btn" id="retry">Try again</button></div>`;
  if (kind === 'error') $('retry').onclick = () => (state.index ? load(state.symbol, state.date) : init());
}

async function init() {
  overlay('loading');
  try {
    state.index = await getJSON('data/index.json');
  } catch (e) {
    overlay('error', 'Could not load the market data. Check your connection.');
    $('status-data').textContent = 'Data unavailable';
    return;
  }
  renderProof();
  renderTopSessions();
  const [hs, hd] = decodeURIComponent(location.hash.slice(1)).split('/');
  const stock = state.index.stocks.find((s) => s.symbol === hs);
  const top = allSessions()[0];
  await load(stock ? stock.symbol : top.symbol, stock ? hd : top.date);   // first visit: most urgent session
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
  overlay('loading');
  try {
    state.day = await getJSON(`data/${symbol}/${date}.json`);
  } catch (e) {
    overlay('error', `Could not load ${symbol} for ${date}.`);
    return;
  }
  state.upto = state.day.bars.length;
  tools.load(symbol, date);
  hideUnfold();
  draw();
  fitDay();
  renderScanner();
  overlay(null);
  const last = stock.dates[stock.dates.length - 1].date;
  $('status-data').textContent = `${symbol} · ${date} · NSE 1-minute data · ${state.day.bars.length} volume candles of ${inr(state.day.barSize)} shares · data to ${last}`;
}

// ---------------------------------------------------------------- drawing (everything up to state.upto)
const visibleBars = () => state.day.bars.slice(0, state.upto);
const lastVisibleTime = () => (state.upto ? state.day.bars[state.upto - 1][B.T] : 0);

function draw() {
  const d = state.day, t = th();
  const bars = visibleBars();
  state.candles = aggregate(d.minutes, state.tf, state.replay ? lastVisibleTime() : Infinity);
  const candles = state.candles;

  tCandles.setData(candles.map(([time, o, h, l, c]) => ({ time, open: o, high: h, low: l, close: c })));
  tVol.setData(candles.map(([time, o, , , c, v]) => ({ time, value: v, color: c >= o ? t.volUp : t.volDown })));
  drawShading(bars, candles);
  tHover.setData([]);
  highlighted = null;

  vCandles.setData(bars.map((r) => {
    const col = r[B.SPEED] === URGENT ? t.accent : r[B.C] >= r[B.O] ? t.up : t.down;
    return { time: r[B.T], open: r[B.O], high: r[B.H], low: r[B.L], close: r[B.C], color: col, wickColor: col };
  }));
  vFill.setData(bars.map((r) => ({
    time: r[B.T],
    value: r[B.BASE] ? Math.min(r[B.FILL], 4 * r[B.BASE]) : r[B.FILL],     // cap rare 20-minute bars so the strip stays readable
    color: r[B.SPEED] === URGENT ? t.accent : r[B.SPEED] === WATCH ? t.watch : t.neutral,
  })));
  vFillS.setData(bars.map((r) => ({ time: r[B.T], value: r[B.FILLS] })));
  vBase.setData(bars.filter((r) => r[B.BASE] != null).map((r) => ({ time: r[B.T], value: r[B.BASE] })));
  vVpin.setData(bars.filter((r) => r[B.VPIN] != null).map((r) => ({ time: r[B.T], value: r[B.VPIN] })));
  vVpin.applyOptions({ visible: state.layers.vpin });
  if (vAai) vAai.setData(bars.filter((r) => r[B.AAIS] != null).map((r) => ({ time: r[B.T], value: Math.max(-1.5, r[B.AAIS]) })));

  const alerts = d.alerts.filter((a) => a.i < state.upto);
  markers.setMarkers(alerts.map((a) => ({ time: a.t, position: 'aboveBar', shape: 'arrowDown', color: t.blue })));

  $('bar-size').textContent = inr(d.barSize);
  renderDayCard(bars, d);
  renderAlerts(alerts);
  updateLegends(null);
  requestAnimationFrame(placeLegends);
}

function drawShading(bars, candles) {
  if (!state.layers.shade) { tShade.setData([]); return; }
  const s = span(), hit = new Set();
  for (const r of bars) {
    if (r[B.SPEED] !== URGENT) continue;
    for (const [time] of candles) if (time + s > r[B.START] && time < r[B.T]) hit.add(time);
  }
  tShade.setData(candles.map(([time]) => (hit.has(time) ? { time, value: 1, color: th().shade } : { time })));
}

function fitDay() {
  quietSync(() => { volChart.timeScale().fitContent(); timeChart.timeScale().fitContent(); });
}

// ---------------------------------------------------------------- urgency summary (follows the replay)
function urgencyOf(bars) {
  if (!bars.length) return null;
  const urgent = bars.map((r) => r[B.SPEED] === URGENT);
  const score = (100 * urgent.filter(Boolean).length) / bars.length;     // every candle holds the same shares
  let best = null;
  for (let i = 0; i < bars.length; i++) {
    if (!urgent[i]) continue;
    let j = i;
    while (j + 1 < bars.length && urgent[j + 1]) j++;
    if (!best || j - i + 1 > best.n) best = { n: j - i + 1, i, j };
    i = j;
  }
  if (best) {
    best.from = bars[best.i][B.START]; best.to = bars[best.j][B.T];
    best.minutes = Math.max(1, Math.round((best.to - best.from) / 60));
    best.timeCandles = Math.max(1, aggregate(state.day.minutes, 5).filter(([t]) => t + 300 > best.from && t < best.to).length);
  }
  return { score, best };
}

function renderDayCard(bars, d) {
  const u = urgencyOf(bars);
  state.burst = u && u.best;
  $('day-label').textContent = `${d.symbol} · ${shortDate(d.date)}${state.replay ? ` · to ${hhmm(lastVisibleTime())}` : ''}`;
  $('day-score').textContent = u ? `${Math.round(u.score)}%` : '–';
  const b = state.burst;
  $('day-burst').innerHTML = !b ? (state.replay ? 'No urgent burst yet.' : 'No urgent burst this session.')
    : `Largest burst: <b>${b.n} urgent candle${b.n > 1 ? 's' : ''} in ${b.minutes} min</b>, ${hhmm(b.from)}–${hhmm(b.to)}. ` +
      `A 5-minute chart shows it as <b>${b.timeCandles} candle${b.timeCandles > 1 ? 's' : ''}</b>. Click to focus.`;
}

// ---------------------------------------------------------------- legends
const kv = (k, v, cls = '') => `<span class="k">${k}</span> <span class="v ${cls}">${v}</span>`;

function updateLegends(barIdx, candleIdx) {
  const d = state.day;
  if (!d) return;
  const bars = visibleBars(), candles = state.candles;
  const r = bars[barIdx ?? bars.length - 1];
  const c = candles[candleIdx ?? candles.length - 1];
  const cc = c && (c[4] >= c[1] ? 'up' : 'down');
  $('legend-time').innerHTML = `<span class="title">${d.symbol} · ${state.tf}m</span>` + (c
    ? kv('O', fmt(c[1]), cc) + kv('H', fmt(c[2]), cc) + kv('L', fmt(c[3]), cc) + kv('C', fmt(c[4]), cc) + kv('Vol', inr(c[5])) + (c[6] ? '' : kv('', 'forming'))
    : kv('', 'waiting for the first minute to finish'));
  if (!r) return;
  const cls = r[B.C] >= r[B.O] ? 'up' : 'down';
  const speed = r[B.SPEED] === URGENT ? ['Urgent', 'urgent'] : r[B.SPEED] === WATCH ? ['Watch', ''] : ['Normal', ''];
  $('legend-vol').innerHTML = `<span class="title">${d.symbol} · ${inr(d.barSize)} sh candles</span>` +
    kv('O', fmt(r[B.O]), cls) + kv('H', fmt(r[B.H]), cls) + kv('L', fmt(r[B.L]), cls) + kv('C', fmt(r[B.C]), cls) +
    kv('', `${hhmm(r[B.START])}–${hhmm(r[B.T])}`) + kv('', speed[0], speed[1]);
  $('legend-fill').innerHTML = `<span class="title">Fill time</span>` + kv('', `${fmt(r[B.FILL], 1)}m`) +
    kv('normal', `${fmt(r[B.BASE], 1)}m`) + kv('pace', r[B.PACE] == null ? '–' : `${fmt(r[B.PACE], 2)}×`, r[B.SPEED] === URGENT ? 'urgent' : '') +
    (state.layers.vpin ? kv('VPIN', fmt(r[B.VPIN], 2), 'blue') : '');
  const a = r[B.AAIS];
  $('legend-aai').innerHTML = `<span class="title">Absorption</span>` + kv('', fmt(a, 2)) +
    kv('', a == null ? '' : a > 0.6 ? 'price held on heavy volume' : a < -0.5 ? 'price moved more than usual' : 'normal response');
}

// keep each legend pinned to the top of its pane, whatever the pane sizes
function placeLegends() {
  let top = 0;
  const ids = ['legend-vol', 'legend-fill', 'legend-aai'];
  volChart.panes().forEach((p, i) => {
    if (ids[i]) $(ids[i]).style.top = `${top + 8}px`;
    top += p.getHeight() + 1;
  });
}

// ---------------------------------------------------------------- linking the two charts
const barIndexByTime = (t) => state.day.bars.findIndex((r) => r[B.T] === t);
const candleIndexByTime = (t) => state.candles.findIndex((c) => c[0] === t);
function candleContaining(ts) {
  const cs = state.candles;
  for (let i = cs.length - 1; i >= 0; i--) if (cs[i][0] <= ts) return i;
  return 0;
}

// shade the time candles covered by the hovered volume candle (only redraws when it changes,
// because setting series data re-fires crosshair events)
let highlighted = null;
function highlightCandlesFor(r) {
  const key = r ? r[B.T] : null;
  if (key === highlighted) return;
  highlighted = key;
  const s = span();
  tHover.setData(!r ? [] : state.candles.map(([time]) =>
    (time + s > r[B.START] && time < r[B.T]) ? { time, value: 1, color: th().hover } : { time }));
}

// one flag guards both handlers: what they change on the other chart fires its crosshair
// event synchronously, and that must not bounce back
const guarded = (fn) => (p) => {
  if (!state.day || state.crosshairLock) return;
  state.crosshairLock = true;
  try { fn(p); } finally { state.crosshairLock = false; }
};

volChart.subscribeCrosshairMove(guarded((p) => {
  placeLegends();
  if (p.time == null) { highlightCandlesFor(null); timeChart.clearCrosshairPosition(); updateLegends(null); return; }
  const i = barIndexByTime(p.time);
  if (i < 0 || i >= state.upto) return;
  state.cursor = i;
  const r = state.day.bars[i];
  highlightCandlesFor(r);
  if (state.candles.length) {
    const ci = candleContaining(r[B.T] - 1);
    timeChart.setCrosshairPosition(r[B.C], state.candles[ci][0], tCandles);
    updateLegends(i, ci);
  } else updateLegends(i);
}));

timeChart.subscribeCrosshairMove(guarded((p) => {
  if (p.time == null) { volChart.clearCrosshairPosition(); highlightCandlesFor(null); updateLegends(null); return; }
  const ci = candleIndexByTime(p.time);
  const s = span();
  const i = state.day.bars.findIndex((r, k) => k < state.upto && r[B.T] > p.time && r[B.T] <= p.time + s);
  highlightCandlesFor(null);
  if (i >= 0) volChart.setCrosshairPosition(state.day.bars[i][B.C], state.day.bars[i][B.T], vCandles);
  else volChart.clearCrosshairPosition();
  updateLegends(i >= 0 ? i : null, ci);
}));

// Keep both charts on the same stretch of the day. The x axes differ (time candles vs volume
// candles), so ranges are converted index -> time -> index. The chart the user moved leads;
// the follower's echo is ignored briefly. Replay pins both to the full session.
let leader = null, leaderUntil = 0, syncOff = false;
const follows = (who) => leader && leader !== who && performance.now() < leaderUntil;
const lead = (who) => { leader = who; leaderUntil = performance.now() + 150; };
function quietSync(fn) { syncOff = true; try { fn(); } finally { requestAnimationFrame(() => { syncOff = false; }); } }

volChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
  requestAnimationFrame(placeLegends);
  if (!syncOff && !follows('vol')) syncCompareToMain(range);
});
/** Point the compare chart at the stretch of the day the main chart shows. */
function syncCompareToMain(range = volChart.timeScale().getVisibleLogicalRange()) {
  if (!state.day || !range || state.replay || !state.candles.length) return;
  const bars = state.day.bars, cs = state.candles;
  const a = bars[clamp(Math.ceil(range.from), 0, bars.length - 1)];
  const b = bars[clamp(Math.floor(range.to), 0, bars.length - 1)];
  const c0 = candleContaining(a[B.START]), c1 = candleContaining(b[B.T] - 1);
  lead('vol');
  timeChart.timeScale().setVisibleLogicalRange({ from: c0 - 0.5, to: Math.min(cs.length - 1, c1) + 0.5 });
}
timeChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
  if (!state.day || !range || syncOff || state.replay || follows('time') || !state.candles.length) return;
  const bars = state.day.bars, cs = state.candles;
  const t0 = cs[clamp(Math.ceil(range.from), 0, cs.length - 1)][0];
  const t1 = cs[clamp(Math.floor(range.to), 0, cs.length - 1)][0] + span();
  const i0 = bars.findIndex((r) => r[B.T] > t0);
  let i1 = bars.length - 1;
  while (i1 > 0 && bars[i1][B.START] >= t1) i1--;
  if (i0 < 0 || i1 < i0) return;
  lead('time');
  volChart.timeScale().setVisibleLogicalRange({ from: i0 - 0.5, to: i1 + 0.5 });
});

/** Glide the main chart to show bars i0..i1 (smoothly unless reduced motion is on). */
function glideTo(i0, i1) {
  const pad = Math.max(6, Math.round((i1 - i0) * 0.35));
  const target = { from: i0 - pad, to: i1 + pad };
  const ts = volChart.timeScale();
  const start = ts.getVisibleLogicalRange();
  if (!start || reducedMotion()) { ts.setVisibleLogicalRange(target); return; }
  const t0 = performance.now(), ms = 480;
  const step = (now) => {
    const k = easeInOut(Math.min(1, (now - t0) / ms));
    ts.setVisibleLogicalRange({ from: start.from + (target.from - start.from) * k, to: start.to + (target.to - start.to) * k });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- Unfold
// Click a time candle: the main chart glides to the volume candles that formed inside it.
timeChart.subscribeClick((p) => {
  if (!state.day || p.time == null || state.replay) return;
  unfold(p.time);
});

function unfold(t0) {
  const s = span(), bars = state.day.bars;
  const idx = [];
  bars.forEach((r, k) => { if (k < state.upto && r[B.T] > t0 && r[B.START] < t0 + s) idx.push(k); });
  if (!idx.length) { showUnfold(`No volume candle completed inside the ${state.tf}-minute candle at ${hhmm(t0)}.`); return; }
  const i0 = idx[0], i1 = idx[idx.length - 1];
  const urgent = idx.filter((k) => bars[k][B.SPEED] === URGENT).length;
  glideTo(i0, i1);
  tools.flash(i0, i1);
  showUnfold(`The <b>${state.tf}-minute candle ${hhmm(t0)}–${hhmm(t0 + s)}</b> unfolds into <b>${idx.length} volume candle${idx.length > 1 ? 's' : ''}</b>` +
    (urgent ? `, <b>${urgent} urgent</b>` : ', none urgent') + ` · about ${shares(idx.length * state.day.barSize)} shares`);
}

let unfoldTimer = null;
function showUnfold(html) {
  const card = $('unfold-card');
  card.innerHTML = `<span>${html}</span><button class="icon-btn" aria-label="Close"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>`;
  card.hidden = false;
  card.querySelector('button').onclick = hideUnfold;
  clearTimeout(unfoldTimer);
  unfoldTimer = setTimeout(hideUnfold, 7000);
}
function hideUnfold() { $('unfold-card').hidden = true; }

$('day-burst').addEventListener('click', () => {
  const b = state.burst;
  if (!b || state.replay) return;
  glideTo(b.i, b.j);
  tools.flash(b.i, b.j);
});

// ---------------------------------------------------------------- replay
function enterReplay() {
  if (!state.day || state.replay) return;
  state.replay = true;
  tools.escape();
  hideUnfold();
  $('replay-btn').classList.add('on');
  $('replay-bar').hidden = false;
  $('rp-scrub').max = String(state.day.bars.length);
  stepTo(1);
}

function exitReplay(redraw = true) {
  if (!state.replay) return;
  pause();
  state.replay = false;
  $('replay-btn').classList.remove('on');
  $('replay-bar').hidden = true;
  if (redraw && state.day) { state.upto = state.day.bars.length; draw(); fitDay(); }
}

// bars arrive left to right across the whole session's width, like a live day
function pinFullSession() {
  const n = state.day.bars.length;
  const m = aggregate(state.day.minutes, state.tf).length;
  quietSync(() => {
    volChart.timeScale().setVisibleLogicalRange({ from: -1, to: n + 1 });
    timeChart.timeScale().setVisibleLogicalRange({ from: -1, to: m + 1 });
  });
}

function stepTo(k) {
  const n = state.day.bars.length;
  state.upto = clamp(k, 1, n);
  state.cursor = state.upto - 1;
  draw();
  pinFullSession();
  $('rp-scrub').value = String(state.upto);
  $('rp-clock').textContent = `${hhmmss(lastVisibleTime())} · ${state.upto}/${n}`;
  if (state.upto >= n) pause();
}

// market pace: each candle waits as long as it took to fill, scaled by the speed,
// so urgent bursts rush in and quiet stretches crawl
function scheduleNext() {
  const speed = Number($('rp-speed').value);
  const r = state.day.bars[state.upto];
  const delay = r ? clamp((r[B.FILL] / speed) * 1000, 25, 1500) : 0;
  state.timer = setTimeout(() => { stepTo(state.upto + 1); if (state.playing) scheduleNext(); }, delay);
}
const PLAY = '<path d="M4.5 3v10l8.5-5z" class="fill"/>', PAUSE = '<path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" class="fill"/>';
function play() {
  if (!state.replay) enterReplay();
  if (state.upto >= state.day.bars.length) stepTo(1);
  state.playing = true;
  $('rp-play-icon').innerHTML = PAUSE;
  $('rp-play').setAttribute('aria-label', 'Pause');
  scheduleNext();
}
function pause() {
  state.playing = false;
  clearTimeout(state.timer);
  $('rp-play-icon').innerHTML = PLAY;
  $('rp-play').setAttribute('aria-label', 'Play');
}
const togglePlay = () => (state.playing ? pause() : play());

$('replay-btn').addEventListener('click', () => (state.replay ? exitReplay() : enterReplay()));
$('rp-play').addEventListener('click', togglePlay);
$('rp-back').addEventListener('click', () => { pause(); stepTo(state.upto - 1); });
$('rp-fwd').addEventListener('click', () => { pause(); stepTo(state.upto + 1); });
$('rp-exit').addEventListener('click', () => exitReplay());
$('rp-scrub').addEventListener('input', (e) => { pause(); stepTo(Number(e.target.value)); });

// ---------------------------------------------------------------- sidebar
function allSessions() {
  return state.index.stocks.flatMap((s) => s.dates.map((d) => ({ symbol: s.symbol, ...d })))
    .sort((a, b) => b.urgency_score - a.urgency_score);
}

function renderScanner() {
  const rows = state.index.stocks.map((s) => ({ s, d: s.dates[s.dates.length - 1] }))
    .sort((a, b) => b.d.urgency_score - a.d.urgency_score);
  const top = Math.max(1, ...rows.map((x) => x.d.urgency_score));
  $('scanner').innerHTML = rows.map(({ s, d }) => {
    const cls = s.change >= 0 ? 'up' : 'down';
    return `<tr data-sym="${s.symbol}" data-date="${d.date}" class="${s.symbol === state.symbol ? 'active' : ''}" title="${s.symbol} · ${d.date}">` +
      `<td>${s.symbol}</td>` +
      `<td><span class="meter-cell">${Math.round(d.urgency_score)}%<span class="meter"><i style="width:${(100 * d.urgency_score) / top}%"></i></span></span></td>` +
      `<td>${d.burst ? `${d.burst.bars}·${d.burst.minutes}m` : '–'}</td>` +
      `<td class="${cls}">${s.change >= 0 ? '+' : ''}${fmt(s.change)}</td></tr>`;
  }).join('');
}
$('scanner').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-sym]'); if (tr) load(tr.dataset.sym, tr.dataset.date); });

function renderTopSessions() {
  $('top-sessions').innerHTML = allSessions().slice(0, 6).map((x) =>
    `<li data-sym="${x.symbol}" data-date="${x.date}"><span>${x.symbol} <span class="when">${shortDate(x.date)}${x.burst ? ` · ${x.burst.from}` : ''}</span></span>` +
    `<span class="pct">${Math.round(x.urgency_score)}%</span></li>`).join('');
}
$('top-sessions').addEventListener('click', (e) => { const li = e.target.closest('li[data-sym]'); if (li) load(li.dataset.sym, li.dataset.date); });

function renderAlerts(alerts) {
  $('alert-count').textContent = alerts.length ? String(alerts.length) : '';
  if (!alerts.length) {
    $('alerts').innerHTML = `<li class="empty">${state.replay ? 'No alert yet.' : 'No alerts this session. Sessions with alerts are marked ● in the session list.'}</li>`;
    return;
  }
  $('alerts').innerHTML = alerts.map((a, k) =>
    `<li data-k="${k}"><div class="row1"><span class="kind">${a.kind}</span><span class="time">${hhmm(a.t)} · ${Math.round(a.prob * 100)}</span></div>` +
    `<ul class="reasons">${a.reasons.map((x) => `<li>${x}</li>`).join('')}</ul></li>`).join('');
}
$('alerts').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-k]');
  if (!li || state.replay) return;
  const a = state.day.alerts[Number(li.dataset.k)];
  document.querySelectorAll('#alerts > li').forEach((el) => el.classList.toggle('active', el === li));
  glideTo(a.i - 12, a.i + 6);
  tools.flash(a.i, a.i);
  state.cursor = a.i;
});

function renderProof() {
  const r = state.index.results, u = r.urgency;
  const pct = (x) => `${Math.round(x * 100)}%`;
  $('proof').innerHTML = `After an urgent candle, a large move followed <b>${pct(u.all_day.urgent)}</b> of the time, against ${pct(u.all_day.other)} ` +
    `after other candles: <b>${u.all_day.lift.toFixed(1)}×</b>. Outside the opening hour, <b>${u.after_10_30.lift.toFixed(1)}×</b>. ` +
    `Stable at ${u.lift_range[0].toFixed(1)}–${u.lift_range[1].toFixed(1)}× for every threshold from ${u.thresholds[0]} to ${u.thresholds[1]}. Urgency does not predict direction.`;
  const rows = [['VPIN', 'vpin'], ['Fill pace alone', 'volume_bars'], ['Time: volume spike', 'time_chart'], ['Time: 30-min range', 'recent_volatility'], ['VolumeLens alerts', 'volumelens']];
  const wins = Object.values(r.per_stock).filter((s) => s.auc_volumelens > s.auc_vpin).length;
  $('results').innerHTML = `<caption>Walk-forward on ${r.test_days.length} unseen sessions · beats VPIN on ${wins} of ${Object.keys(r.per_stock).length} stocks</caption>` +
    '<thead><tr><th>Signal</th><th>AUC</th><th>Caught</th></tr></thead><tbody>' +
    rows.map(([label, k]) => `<tr class="${k === 'volumelens' ? 'ours' : ''}"><td>${label}</td><td>${fmt(r.auc[k], 3)}</td><td>${Math.round(r.catch_rate[k] * 100)}%</td></tr>`).join('') + '</tbody>';
}

// ---------------------------------------------------------------- toolbar
function fillDates(stock) {
  const sel = $('date-select');
  sel.innerHTML = stock.dates.map((d) => `<option value="${d.date}">${d.date}  ${String(Math.round(d.urgency_score)).padStart(2)}%${d.alerts ? ' ●' : ''}</option>`).join('');
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
  symList.innerHTML = hits.map((s, i) => `<li data-sym="${s.symbol}" class="${i === symActive ? 'active' : ''}"><span>${s.symbol}</span><span class="muted">${s.dates.length} sessions</span></li>`).join('') || '<li class="muted">No match</li>';
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
symInput.addEventListener('blur', () => setTimeout(() => { symList.hidden = true; symInput.value = state.symbol || ''; }, 120));

// time frames
$('tf').innerHTML = TIMEFRAMES.map((m) => `<button data-tf="${m}" aria-pressed="${m === state.tf}" class="${m === state.tf ? 'on' : ''}">${m}m</button>`).join('');
$('tf').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tf]');
  if (!b) return;
  state.tf = Number(b.dataset.tf);
  store('vl:tf', state.tf);
  document.querySelectorAll('#tf button').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
  if (!state.day) return;
  draw();
  if (state.replay) pinFullSession();
  else syncCompareToMain();          // the compare chart has a new number of candles
});

// layers
function applyLayers() {
  const L = state.layers;
  document.querySelectorAll('[data-layer]').forEach((c) => { c.checked = !!L[c.dataset.layer]; });
  $('time-wrap').hidden = !L.compare;
  $('resizer').hidden = !L.compare;
  setAbsorption(L.aai);
  store('vl:layers', L);
  if (state.day) { draw(); requestAnimationFrame(placeLegends); }
}
document.querySelectorAll('[data-layer]').forEach((c) => c.addEventListener('change', () => {
  state.layers[c.dataset.layer] = c.checked;
  applyLayers();
}));
$('compare-close').addEventListener('click', () => { state.layers.compare = false; applyLayers(); });
document.addEventListener('click', (e) => { const m = $('layers'); if (m.open && !m.contains(e.target)) m.open = false; });

// tools
document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => tools.setTool(b.dataset.tool)));
function toggleMagnet() {
  state.magnet = !state.magnet;
  $('magnet').classList.toggle('active', state.magnet);
  for (const ch of [volChart, timeChart]) ch.applyOptions({ crosshair: { mode: state.magnet ? LWC.CrosshairMode.Magnet : LWC.CrosshairMode.Normal } });
}
$('magnet').addEventListener('click', toggleMagnet);
$('undo').addEventListener('click', () => tools.undo());
$('clear').addEventListener('click', () => tools.clear());
$('snapshot').addEventListener('click', snapshot);
$('fullscreen').addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen?.();
}

/** Save both charts as one PNG with a caption. */
function snapshot() {
  if (!state.day) return;
  const main = volChart.takeScreenshot();
  const comp = state.layers.compare ? timeChart.takeScreenshot() : null;
  const scale = main.width / $('vol-wrap').clientWidth;
  const head = Math.round(44 * scale), foot = Math.round(26 * scale);
  const compH = comp ? Math.round(comp.height * (main.width / comp.width)) : 0;
  const out = document.createElement('canvas');
  out.width = main.width;
  out.height = head + main.height + compH + foot;
  const g = out.getContext('2d');
  const t = th();
  g.fillStyle = t.bg; g.fillRect(0, 0, out.width, out.height);
  g.drawImage(main, 0, head);
  if (comp) g.drawImage(comp, 0, head + main.height, main.width, compH);
  const d = state.day, u = urgencyOf(visibleBars());
  g.fillStyle = state.theme === 'dark' ? '#e3e6ec' : '#11141b';
  g.font = `600 ${15 * scale}px "IBM Plex Sans", sans-serif`;
  g.fillText(`VolumeLens · ${d.symbol} · ${shortDate(d.date)} ${d.date.slice(0, 4)}`, 16 * scale, 28 * scale);
  g.fillStyle = t.accent;
  g.font = `500 ${12 * scale}px "JetBrains Mono", monospace`;
  g.textAlign = 'right';
  g.fillText(`urgency ${Math.round(u.score)}% · candles of ${inr(d.barSize)} shares`, out.width - 16 * scale, 28 * scale);
  g.textAlign = 'left';
  g.fillStyle = t.text;
  g.font = `400 ${11 * scale}px "IBM Plex Sans", sans-serif`;
  g.fillText('Volume candles: one candle per fixed number of shares. Amber = urgent. Educational, not investment advice. Charting by TradingView Lightweight Charts.', 16 * scale, out.height - 9 * scale);
  const a = document.createElement('a');
  a.download = `VolumeLens_${d.symbol}_${d.date}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
}

$('theme-btn').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  store('vl:theme', state.theme);
  applyTheme();
});
$('help-btn').addEventListener('click', () => $('help').showModal());

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof Element && e.target.matches('input:not([type=range]):not([type=checkbox]), select');
  if (typing || $('help').open || !state.day) return;
  const k = e.key, n = state.day.bars.length;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); tools.undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const toolKeys = { v: 'cursor', h: 'hline', t: 'trend', z: 'zone', m: 'measure' };
  if (toolKeys[k.toLowerCase()] && !state.replay) { tools.setTool(toolKeys[k.toLowerCase()]); return; }
  switch (k) {
    case 'g': case 'G': toggleMagnet(); break;
    case 's': case 'S': snapshot(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'r': case 'R': state.replay ? exitReplay() : enterReplay(); break;
    case '?': $('help').showModal(); break;
    case ' ': if (state.replay) { e.preventDefault(); togglePlay(); } break;
    case 'ArrowRight': case 'ArrowLeft': {
      e.preventDefault();
      const dir = k === 'ArrowRight' ? 1 : -1;
      if (state.replay) { pause(); stepTo(state.upto + dir); break; }
      const i = clamp((state.cursor ?? n - 1) + dir, 0, n - 1);
      state.cursor = i;
      const r = state.day.bars[i];
      volChart.setCrosshairPosition(r[B.C], r[B.T], vCandles);
      break;
    }
    case 'Escape':
      if (tools.escape()) break;
      if (!$('unfold-card').hidden) { hideUnfold(); break; }
      state.replay ? exitReplay() : fitDay();
      break;
    default:
  }
});

// ---------------------------------------------------------------- resizable split
const resizer = $('resizer'), timeWrap = $('time-wrap');
resizer.addEventListener('pointerdown', (e) => {
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  const box = $('stage').getBoundingClientRect();
  const move = (ev) => { timeWrap.style.flexBasis = `${clamp(((box.bottom - ev.clientY) / box.height) * 100, 16, 60)}%`; };
  const up = () => {
    resizer.classList.remove('dragging');
    resizer.removeEventListener('pointermove', move);
    resizer.removeEventListener('pointerup', up);
    requestAnimationFrame(placeLegends);
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up);
});
new ResizeObserver(() => requestAnimationFrame(placeLegends)).observe($('vol-wrap'));
document.addEventListener('pointerup', () => requestAnimationFrame(placeLegends));   // pane separators dragged

// read-only handles for the automated browser tests (only with ?debug in the URL)
if (new URLSearchParams(location.search).has('debug')) window.vl = { volChart, timeChart, state };

applyTheme();
applyLayers();
init();
