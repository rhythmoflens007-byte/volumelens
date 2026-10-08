/* VolumeLens terminal.
 *
 * Main chart: one continuous series of volume candles across every loaded session, with the
 * Urgency Index pane below (and optional fill-time/VPIN and absorption panes). Compare chart: a
 * normal 1-30 minute time chart built from 1-minute candles. Everything is drawn up to a cursor
 * (state.upto) so replay can only ever show what was known at that moment.
 *
 * Smoothness rules: the chart engine owns zoom and pan; the chart the user touches leads and the
 * other follows once per frame; hover never rewrites series data (overlays are primitives); replay
 * appends with series.update(). */

import { B, URGENT, WATCH, URGENT_INDEX, WATCH_INDEX, $, clamp, fmt, inr, hhmm, hhmmss, shortDate, dayLabel, shares,
  easeInOut, reducedMotion, store, perFrame, lastAtOrBefore, level, TH, mix } from './util.js?v=51';
import { TIMEFRAMES, aggregate } from './timeframe.js?v=51';
import { loadIndex, Series } from './data.js?v=51';
import { createTools } from './tools.js?v=51';
import { SessionSeparators, CompareBands, ClockOverlay, BrickOverlay } from './overlays.js?v=51';
import { initAnalyst } from './analyst.js?v=51';

const LWC = window.LightweightCharts;

const THEMES = {
  dark: {
    bg: '#0b0d12', text: '#8b92a0', grid: '#131720', line: '#222835', neutral: '#3a404d', smooth: '#e3e6ec',
    up: '#1fa37a', down: '#e5484d', accent: '#ff9800', watch: '#8a5a12', blue: '#4c7dff', aai: '#b07cff',
    volUp: 'rgba(31,163,122,0.28)', volDown: 'rgba(229,72,77,0.28)', shade: 'rgba(255,152,0,0.11)', hover: 'rgba(76,125,255,0.16)',
    cross: '#5b6270', label: '#2a303c', draw: '#e3e6ec', zoneFill: 'rgba(76,125,255,0.10)', zoneLine: 'rgba(76,125,255,0.6)',
    separator: 'rgba(139,146,160,0.28)', chip: 'rgba(23,27,36,0.9)', chipText: '#9aa1ae', watermark: 'rgba(139,146,160,0.07)',
    band: 'rgba(139,146,160,0.055)', bandText: 'rgba(139,146,160,0.55)', calm: '#4a505d', hot: '#ff5a1f',
  },
  light: {
    bg: '#f6f7f9', text: '#5b6270', grid: '#eceff3', line: '#e2e5ea', neutral: '#c9ced6', smooth: '#11141b',
    up: '#0f8a63', down: '#d93036', accent: '#e07c00', watch: '#eab676', blue: '#2f5fe0', aai: '#7c4dff',
    volUp: 'rgba(15,138,99,0.22)', volDown: 'rgba(217,48,54,0.22)', shade: 'rgba(224,124,0,0.12)', hover: 'rgba(47,95,224,0.14)',
    cross: '#8a909c', label: '#5b6270', draw: '#11141b', zoneFill: 'rgba(47,95,224,0.08)', zoneLine: 'rgba(47,95,224,0.55)',
    separator: 'rgba(91,98,112,0.3)', chip: 'rgba(255,255,255,0.92)', chipText: '#4b5260', watermark: 'rgba(91,98,112,0.07)',
    band: 'rgba(91,98,112,0.06)', bandText: 'rgba(91,98,112,0.7)', calm: '#aab0ba', hot: '#d84315',
  },
};
const DENSITY_LABEL = { fine: 'Small', standard: 'Medium', coarse: 'Large' };
const CHART_TYPES = { bricks: 'Bricks', candles: 'Candles', line: 'Line' };
const TYPE_NAME = { bricks: 'Volume Bricks', candles: 'Volume Candles', line: 'Urgency Line' };
const DEFAULT_SETTINGS = { chartType: 'bricks', forming: true, colorBy: 'both', bands: false, bandMin: 30, ribbon: false, badges: false, scale: 'normal', urgent: 60, watch: 30 };

const state = {
  index: null, symbol: null, series: null,
  density: store('vl:density') || 'standard',
  tf: store('vl:tf') || 5,
  theme: store('vl:theme') || 'dark',
  magnet: false,
  layers: Object.assign({ compare: true, shade: true, fill: false, aai: false, flow: true, hollow: false }, store('vl:layers') || {}),
  view: { bars: [], minutes: [], alerts: [], starts: [] },
  candles: [], upto: 0, cursor: null, burst: null,
  replay: null, playing: false, timer: null,
  crosshairLock: false, loadingEarlier: false, forming: null, brickPts: null,
  settings: Object.assign({}, DEFAULT_SETTINGS, store('vl:settings:v2') || {}),
};
TH.urgent = state.settings.urgent; TH.watch = state.settings.watch;
const th = () => THEMES[state.theme];
const span = () => state.tf * 60;
const bars = () => state.view.bars;

// ================================================================ charts
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
    rightPriceScale: { borderColor: t.line, minimumWidth: 78, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: t.line, timeVisible: true, secondsVisible: false, rightOffset: 8, minBarSpacing: 0.05, barSpacing: 7 },
    crosshair: { mode: state.magnet ? LWC.CrosshairMode.Magnet : LWC.CrosshairMode.Normal, vertLine: line, horzLine: line },
    kineticScroll: { mouse: true, touch: true },
    handleScroll: { vertTouchDrag: false },    // on phones a vertical swipe scrolls the page, not the chart
  };
}
const candleOptions = () => ({ upColor: th().up, downColor: th().down, wickUpColor: th().up, wickDownColor: th().down,
  borderVisible: state.layers.hollow || state.settings.colorBy === 'heat', borderUpColor: th().up, borderDownColor: th().down });
/** Main series: bricks have no wicks and always a border; the line type hides the candles (they stay as the anchor for tools and markers). */
const mainOptions = () => {
  const type = state.settings.chartType;
  return { ...candleOptions(), wickVisible: type === 'candles', lastValueVisible: type === 'candles', priceLineVisible: type === 'candles' };
};

/** Urgency heat: calm grey, then watch amber, then urgent orange, hotter towards 100. */
function heat(u, ribbon = false) {
  const t = th();
  if (u == null || u < TH.watch) return ribbon ? t.grid : t.calm;
  if (u < TH.urgent) return mix(t.watch, t.accent, (u - TH.watch) / Math.max(1, TH.urgent - TH.watch));
  return mix(t.accent, t.hot, (u - TH.urgent) / Math.max(1, 100 - TH.urgent));
}

const volChart = LWC.createChart($('vol-chart'), chartOptions());
const vCandles = volChart.addSeries(LWC.CandlestickSeries, mainOptions(), 0);
const vLine = volChart.addSeries(LWC.AreaSeries, { lineWidth: 2, lineType: LWC.LineType.Simple, priceLineVisible: false, lastValueVisible: false,
  crosshairMarkerVisible: false, visible: false }, 0);
const clock = new ClockOverlay(th);
vCandles.attachPrimitive(clock);                // first, so session labels paint over it
const brickFx = new BrickOverlay(th);           // urgency glow behind bricks and the forming brick
vCandles.attachPrimitive(brickFx);
const vUrg = volChart.addSeries(LWC.HistogramSeries, {
  priceLineVisible: false, lastValueVisible: false, base: 0,
  priceFormat: { type: 'custom', formatter: (v) => v.toFixed(0), minMove: 1 },
  autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
}, 1);
let urgLines = [];
const markers = LWC.createSeriesMarkers(vCandles, []);
const separators = new SessionSeparators(th);
vCandles.attachPrimitive(separators);
const urgSeparators = new SessionSeparators(th, false);
vUrg.attachPrimitive(urgSeparators);
let watermark = null;
let optional = {};                        // series in the optional panes, rebuilt by setPanes()

const timeChart = LWC.createChart($('time-chart'), chartOptions());
const tVol = timeChart.addSeries(LWC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
const tCandles = timeChart.addSeries(LWC.CandlestickSeries, candleOptions());
timeChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
const bands = new CompareBands(th);
tCandles.attachPrimitive(bands);

const tools = createTools({
  volChart, vCandles, tCandles, getBars: bars, colors: th,
  onToolChange: (t) => {
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('vol-wrap').style.cursor = t === 'cursor' ? '' : 'crosshair';
  },
});

/** Urgency pane furniture: labelled threshold lines. */
function styleUrgency() {
  const t = th();
  for (const l of urgLines) vUrg.removePriceLine(l);
  urgLines = [
    vUrg.createPriceLine({ price: TH.urgent, color: t.accent, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: 'Urgent' }),
    vUrg.createPriceLine({ price: TH.watch, color: t.text, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: 'Watch' }),
  ];
}

/** Rebuild the optional panes (fill time + VPIN, absorption) in a fixed order. */
function setPanes() {
  for (const s of Object.values(optional)) volChart.removeSeries(s);
  optional = {};
  while (volChart.panes().length > 2) volChart.removePane(volChart.panes().length - 1);
  let pane = 2;
  if (state.layers.fill) {
    optional.fill = volChart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom', formatter: (v) => `${v.toFixed(1)}m` } }, pane);
    optional.fillS = volChart.addSeries(LWC.LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, pane);
    optional.base = volChart.addSeries(LWC.LineSeries, { lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, pane);
    optional.vpin = volChart.addSeries(LWC.LineSeries, { lineWidth: 1.5, priceScaleId: 'vpin', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }) }, pane);
    volChart.priceScale('vpin', pane).applyOptions({ scaleMargins: { top: 0.15, bottom: 0.05 }, visible: false });
    pane++;
  }
  if (state.layers.aai) {
    optional.aai = volChart.addSeries(LWC.BaselineSeries, { baseValue: { type: 'price', price: 0 }, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: -1.5, maxValue: 1 } }) }, pane);
    pane++;
  }
  if (state.layers.flow) {
    optional.flowNet = volChart.addSeries(LWC.HistogramSeries, { priceScaleId: 'flownet', priceLineVisible: false, lastValueVisible: false,
      autoscaleInfoProvider: (base) => {                     // zero centred, fits the visible bars, opening spikes clip
        const r = base()?.priceRange, m = clamp(Math.max(Math.abs(r?.minValue ?? 0), Math.abs(r?.maxValue ?? 0)), 0.15, 0.35);
        return { priceRange: { minValue: -m, maxValue: m } };
      } }, pane);
    volChart.priceScale('flownet', pane).applyOptions({ visible: false, scaleMargins: { top: 0.58, bottom: 0.03 } });
    optional.flowCvd = volChart.addSeries(LWC.LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
      priceFormat: { type: 'volume' } }, pane);
    volChart.priceScale('right', pane).applyOptions({ scaleMargins: { top: 0.3, bottom: 0.44 } });   // below the legend
  }
  const panes = volChart.panes();
  panes[0].setStretchFactor(4.2);
  panes[1].setStretchFactor(1.2);
  for (let k = 2; k < panes.length; k++) panes[k].setStretchFactor(1.1);
  if (state.layers.flow) panes.at(-1).setStretchFactor(1.7);
  styleOptional();
  $('legend-fill').hidden = !state.layers.fill;
  $('legend-aai').hidden = !state.layers.aai;
  $('legend-flow').hidden = !state.layers.flow;
}
function styleOptional() {
  const t = th();
  optional.fillS?.applyOptions({ color: t.smooth });
  optional.base?.applyOptions({ color: t.text });
  optional.vpin?.applyOptions({ color: t.blue });
  optional.aai?.applyOptions({ topLineColor: t.aai, topFillColor1: `${t.aai}40`, topFillColor2: `${t.aai}08`,
    bottomLineColor: t.text, bottomFillColor1: 'rgba(120,123,134,0.04)', bottomFillColor2: 'rgba(120,123,134,0.18)' });
  optional.flowCvd?.applyOptions({ color: t.smooth });
}

// ================================================================ flow: accumulation / distribution
// Net flow = (buy - sell) / volume over the last FLOW_BARS volume candles of the session, with the
// buy share estimated per minute (bulk volume classification). Cumulative delta resets each session.
// A stretch is called accumulation (distribution) when net flow leans to buyers (sellers) while
// the absorption index says price moved less than that volume normally moves it. Backward-looking only.
const FLOW_BARS = 10, FLOW_LEAN = 0.08, FLOW_ABSORBED = 0.25;
const delta = (r) => 2 * (r[B.BUY] ?? r[B.VOL] / 2) - r[B.VOL];
/** Flow reading of candle k, given the reading of candle k-1 (for the running cumulative delta). */
function flowStep(b, k, prev) {
  const r = b[k], s = r[B.SESSION];
  const cvd = (k > 0 && prev && b[k - 1][B.SESSION] === s ? prev.cvd : 0) + delta(r);
  let num = 0, den = 0;
  for (let j = k; j >= 0 && j > k - FLOW_BARS && b[j][B.SESSION] === s; j--) { num += delta(b[j]); den += b[j][B.VOL]; }
  const net = den ? num / den : 0;
  const absorbed = r[B.AAIS] != null && r[B.AAIS] >= FLOW_ABSORBED;
  return { cvd, net, kind: absorbed && net >= FLOW_LEAN ? 'acc' : absorbed && net <= -FLOW_LEAN ? 'dist' : null };
}
function flowPoint(r, f) {
  const t = th();
  return {
    flowNet: { time: r[B.T], value: f.net, color: f.kind === 'acc' ? t.up : f.kind === 'dist' ? t.down : f.net >= 0 ? t.volUp : t.volDown },
    flowCvd: { time: r[B.T], value: f.cvd },
  };
}
function flowPoints(vb) {
  const f = [];
  for (let k = 0; k < vb.length; k++) f.push(flowStep(vb, k, f[k - 1]));
  state.flow = f;
  const pts = vb.map((r, k) => flowPoint(r, f[k]));
  return { flowNet: pts.map((p) => p.flowNet), flowCvd: pts.map((p) => p.flowCvd) };
}

function setWatermark() {
  const lines = [{ text: state.symbol || '', color: th().watermark, fontSize: 64, fontStyle: '600' },
    { text: `${TYPE_NAME[state.settings.chartType].toLowerCase()} · ${DENSITY_LABEL[state.density].toLowerCase()} box`, color: th().watermark, fontSize: 16 }];
  if (watermark) watermark.applyOptions({ lines });
  else watermark = LWC.createTextWatermark(volChart.panes()[0], { horzAlign: 'center', vertAlign: 'center', lines });
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('theme-btn').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  for (const ch of [volChart, timeChart]) ch.applyOptions(chartOptions());
  vCandles.applyOptions(mainOptions());
  tCandles.applyOptions(candleOptions());
  styleLine();
  styleUrgency();
  styleOptional();
  tools.recolor();
  if (state.symbol) { setWatermark(); draw(); }
}

// ================================================================ points for series
const CLEAR = 'rgba(0,0,0,0)';
/** One point of the main series for bar k, drawn as the chosen chart type. */
function mainPoint(k) {
  const b = bars(), r = b[k], type = state.settings.chartType;
  if (type === 'candles') return candlePoint(r);
  if (type === 'line') return { time: r[B.T], open: r[B.O], high: r[B.H], low: r[B.L], close: r[B.C], color: CLEAR, borderColor: CLEAR, wickColor: CLEAR };
  // Volume Brick: from the previous brick's close to this close (Renko grammar), no wick.
  const prev = k > 0 && b[k - 1][B.SESSION] === r[B.SESSION] ? b[k - 1][B.C] : r[B.O];
  const t = th(), by = state.settings.colorBy, up = r[B.C] >= prev, u = r[B.UIDX];
  const dir = up ? t.up : t.down;
  let body = dir, edge = dir;
  if (by === 'heat') { body = heat(u); edge = body; }
  else if (by === 'both') {
    const f = u == null ? 0 : clamp((u - TH.watch) / Math.max(1, TH.urgent - TH.watch), 0, 1);
    body = mix(t.bg, dir, 0.34 + 0.66 * f);                 // calm bricks recede, urgent bricks are full strength
    edge = r[B.SPEED] === URGENT ? t.accent : mix(t.bg, dir, 0.5 + 0.5 * f);
  }
  const lo = Math.min(prev, r[B.C]), hi = Math.max(prev, r[B.C]);
  return { time: r[B.T], open: prev, high: hi, low: lo, close: r[B.C], color: CLEAR, borderColor: CLEAR, wickColor: CLEAR, body, edge };
}
function linePoint(r) { return { time: r[B.T], value: r[B.C] }; }
function styleLine() {
  const t = th(), on = state.settings.chartType === 'line';
  vLine.applyOptions({ visible: on, topColor: `${t.accent}26`, bottomColor: `${t.accent}00`, lineColor: t.smooth });
}
/** Colour the line by urgency, segment by segment. */
function lineData(vb) {
  const t = th();
  return vb.map((r) => ({ ...linePoint(r), lineColor: r[B.UIDX] == null ? t.text : r[B.SPEED] === URGENT ? heat(r[B.UIDX]) : r[B.SPEED] === WATCH ? t.watch : t.text }));
}

function candlePoint(r) {
  const t = th(), by = state.settings.colorBy, up = r[B.C] >= r[B.O];
  let col = up ? t.up : t.down, hollowUp = state.layers.hollow && up;
  if (by === 'heat') { col = heat(r[B.UIDX]); hollowUp = up; }          // direction shown by hollow (up) vs filled (down)
  else if (by === 'both' && r[B.SPEED] === URGENT) { col = t.accent; hollowUp = false; }
  return { time: r[B.T], open: r[B.O], high: r[B.H], low: r[B.L], close: r[B.C], color: hollowUp ? 'rgba(0,0,0,0)' : col, borderColor: col, wickColor: col };
}
function urgencyPoint(r) {
  const t = th(), u = r[B.UIDX];
  return u == null ? { time: r[B.T] } : { time: r[B.T], value: Math.max(1, u), color: u >= TH.urgent ? t.accent : u >= TH.watch ? t.watch : t.neutral };
}
function optionalPoints(r) {
  const t = th(), out = {};
  if (optional.fill) {
    out.fill = { time: r[B.T], value: r[B.BASE] ? Math.min(r[B.FILL], 4 * r[B.BASE]) : r[B.FILL],
      color: r[B.SPEED] === URGENT ? t.accent : r[B.SPEED] === WATCH ? t.watch : t.neutral };
    out.fillS = r[B.FILLS] == null ? { time: r[B.T] } : { time: r[B.T], value: r[B.FILLS] };
    out.base = r[B.BASE] == null ? { time: r[B.T] } : { time: r[B.T], value: r[B.BASE] };
    out.vpin = r[B.VPIN] == null ? { time: r[B.T] } : { time: r[B.T], value: r[B.VPIN] };
  }
  if (optional.aai) out.aai = r[B.AAIS] == null ? { time: r[B.T] } : { time: r[B.T], value: Math.max(-1.5, r[B.AAIS]) };
  return out;
}
const candlePointT = ([time, o, h, l, c]) => ({ time, open: o, high: h, low: l, close: c });
const volPointT = ([time, o, , , c, v]) => ({ time, value: v, color: c >= o ? th().volUp : th().volDown });

// ================================================================ draw (everything up to state.upto)
const visible = () => bars().slice(0, state.upto);
const lastTime = () => (state.upto ? bars()[state.upto - 1][B.T] : 0);

function draw() {
  const vb = visible();
  const pts = vb.map((r, k) => mainPoint(k));
  vCandles.setData(pts.map(({ body, edge, ...pt }) => pt));
  state.brickPts = pts;
  vLine.setData(state.settings.chartType === 'line' ? lineData(vb) : []);
  vUrg.setData(vb.map(urgencyPoint));
  if (Object.keys(optional).length) {
    const cols = {};
    for (const r of vb) for (const [k, p] of Object.entries(optionalPoints(r))) (cols[k] ||= []).push(p);
    if (optional.flowNet) Object.assign(cols, flowPoints(vb));
    for (const [k, s] of Object.entries(optional)) s.setData(cols[k] || []);
  }
  drawCompare();
  drawMarkers();
  setClock();
  const starts = state.view.starts.filter((s) => s.index < state.upto).map((s) => ({ ...s, score: sessionMeta(s.date)?.urgency_score }));
  separators.set(starts);
  urgSeparators.set(starts);
  onViewChanged(true);
}

function drawMarkers() {
  const alerts = state.view.alerts.filter((a) => a.i < state.upto);
  markers.setMarkers(alerts.map((a) => ({ time: a.t, position: 'aboveBar', shape: 'arrowDown', color: th().blue })));
}

function drawCompare() {
  state.candles = aggregate(state.view.minutes, state.tf, state.replay ? lastTime() : Infinity);
  tCandles.setData(state.candles.map(candlePointT));
  tVol.setData(state.candles.map(volPointT));
  shadeCompare();
}

/** Mark compare candles that contain urgent volume candles. */
function shadeCompare() {
  if (!state.layers.shade) { bands.setUrgent([]); return; }
  const cs = state.candles, hit = new Set(), key = (c) => c[0];
  const b = bars();
  for (let k = 0; k < state.upto; k++) {
    const r = b[k];
    if (r[B.SPEED] !== URGENT) continue;
    const c0 = lastAtOrBefore(cs, r[B.START], key), c1 = lastAtOrBefore(cs, r[B.T] - 1, key);
    for (let j = Math.max(0, c0); j <= c1; j++) hit.add(j);
  }
  bands.setUrgent([...hit]);
}

/** Replay step forward: append one candle to every series instead of redrawing. */
function appendBar(k) {
  const r = bars()[k];
  const pt = mainPoint(k);
  const { body, edge, ...plain } = pt;
  vCandles.update(plain);
  if (state.brickPts) state.brickPts[k] = pt;
  if (state.settings.chartType === 'line') vLine.update(lineData([r])[0]);
  vUrg.update(urgencyPoint(r));
  for (const [key, p] of Object.entries(optionalPoints(r))) optional[key].update(p);
  if (optional.flowNet) {
    const f = flowStep(bars(), k, state.flow?.[k - 1]);
    (state.flow ||= [])[k] = f;
    for (const [key, p] of Object.entries(flowPoint(r, f))) optional[key].update(p);
  }
  const before = state.candles.length;
  state.candles = aggregate(state.view.minutes, state.tf, lastTime());
  for (let j = Math.max(0, before - 1); j < state.candles.length; j++) {
    tCandles.update(candlePointT(state.candles[j]));
    tVol.update(volPointT(state.candles[j]));
  }
  shadeCompare();
  setClock();
  if (state.view.alerts.some((a) => a.i === k)) drawMarkers();
}

function setClock() {
  const b = bars(), st = state.view.starts;
  clock.set(b, state.upto, state.settings, (k) => st[b[k][B.SESSION]]?.size, heat);
  const bricks = state.settings.chartType === 'bricks';
  setLastPrice();
  brickFx.set({
    bricks: bricks ? (state.brickPts || []).slice(0, state.upto) : [],
    glow: bricks && state.settings.colorBy !== 'direction' ? urgentRuns() : [],
    forming: bricks && state.settings.forming && !state.replay && state.upto === b.length ? state.forming : null,
    lastClose: state.upto ? b[state.upto - 1][B.C] : null, index: state.upto,
  });
}
/** Brick and line types hide the series' own last-price label, so draw one price line instead. */
let lastPriceLine = null;
function setLastPrice() {
  if (lastPriceLine) { vCandles.removePriceLine(lastPriceLine); lastPriceLine = null; }
  if (state.settings.chartType === 'candles' || !state.upto) return;
  const r = bars()[state.upto - 1], t = th();
  const col = state.settings.chartType === 'bricks' && state.brickPts?.[state.upto - 1]?.edge || (r[B.C] >= r[B.O] ? t.up : t.down);
  lastPriceLine = vCandles.createPriceLine({ price: r[B.C], color: col, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: '' });
}
/** Urgent bricks as index ranges, for the glow. */
function urgentRuns() {
  const b = bars(), out = [];
  for (let k = 0; k < state.upto; k++) {
    if (b[k][B.SPEED] !== URGENT) continue;
    const prev = k > 0 && b[k - 1][B.SESSION] === b[k][B.SESSION] ? b[k - 1][B.C] : b[k][B.O];
    out.push({ k, lo: Math.min(prev, b[k][B.C]), hi: Math.max(prev, b[k][B.C]) });
  }
  return out;
}

// ================================================================ loading
async function openStock(symbol, date = null) {
  const meta = state.index.stocks.find((s) => s.symbol === symbol);
  if (!meta) return;
  exitReplay(false);
  overlay('loading');
  state.symbol = symbol;
  state.series = new Series(symbol, meta.sessions);
  state.cursor = null;
  shownSession = null;
  $('symbol-input').value = symbol;
  try {
    await state.series.loadLatest(10);
    if (date) await state.series.ensureFrom(date);
  } catch (e) {
    overlay('error', `Could not load ${symbol}.`);
    return;
  }
  tools.load(symbol);
  rebuild();
  setWatermark();
  fillSessions();
  if (date) await goToSession(date, false); else showLatest(false);
  overlay(null);
  renderScanner();
  history.replaceState(null, '', `#${symbol}${date ? `/${date}` : ''}`);
  connectLive(symbol);
}

/** Rebuild the continuous arrays for the current density (and keep the same time in view). */
function rebuild(keep = null) {
  state.rebuilding = true;                   // no history loading while the view is being rebuilt
  state.view = state.series.build(state.density);
  applyThresholds();
  state.upto = bars().length;
  draw();
  if (keep) restoreTimeRange(keep);
  setTimeout(() => { state.rebuilding = false; }, 250);
}

/** Custom thresholds re-classify candles from their Urgency Index; the defaults keep the engine's classes. */
function applyThresholds() {
  const s = state.settings;
  if (s.urgent === DEFAULT_SETTINGS.urgent && s.watch === DEFAULT_SETTINGS.watch) return;
  for (const r of bars()) { const u = r[B.UIDX]; r[B.SPEED] = u == null ? 0 : u >= TH.urgent ? URGENT : u >= TH.watch ? WATCH : 0; }
}

function visibleTimeRange() {
  const r = volChart.timeScale().getVisibleLogicalRange(), b = bars();
  if (!r || !b.length) return null;
  return { t0: b[clamp(Math.ceil(r.from), 0, b.length - 1)][B.START], t1: b[clamp(Math.floor(r.to), 0, b.length - 1)][B.T] };
}
function restoreTimeRange({ t0, t1 }) {
  const b = bars(), key = (r) => r[B.T];
  const i0 = Math.max(0, lastAtOrBefore(b, t0, key) + 1), i1 = Math.max(i0, lastAtOrBefore(b, t1, key));
  setMainRange(i0 - 0.5, i1 + 0.5);
}

// older history streams in when the user scrolls near the left edge
async function loadEarlierIfNeeded(range) {
  if (!range || state.replay || state.loadingEarlier || state.rebuilding || !state.series || state.series.complete || range.from > 30) return;
  state.loadingEarlier = true;
  $('history-chip').hidden = false;
  try {
    const added = await state.series.loadEarlier(10);
    if (added && !state.replay) {
      const keep = visibleTimeRange();            // keep the same moments in view, by time
      rebuild(keep);
      fillSessions();
    }
  } catch (e) { /* network hiccup: try again on the next scroll */ }
  state.loadingEarlier = false;
  $('history-chip').hidden = true;
}

// ================================================================ live
// Today's session streams from the live server (live/server.py) as Server-Sent Events, in the same
// format as the history files, so a live update is just a replaced last session.
const live = { url: '', source: null, symbol: null, retry: null };

async function liveConfig() {
  const q = new URLSearchParams(location.search).get('live');
  if (q != null) return q.replace(/\/$/, '');
  try { return ((await (await fetch('live.json', { cache: 'no-cache' })).json()).url || '').replace(/\/$/, ''); }
  catch (e) { return ''; }
}

/** NSE cash market: Monday–Friday, 09:15–15:30 IST (exchange holidays are not known here). */
function marketOpen(now = new Date()) {
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
  const m = ist.getHours() * 60 + ist.getMinutes(), d = ist.getDay();
  return d >= 1 && d <= 5 && m >= 555 && m < 930;
}

/** Badge text: LIVE only while the market is open; a replay always says REPLAY with its market time. */
function showLiveState(mode, lastMinute) {
  const at = lastMinute ? ` ${hhmm(lastMinute)}` : '';
  if (mode === 'simulated') setLiveBadge('sim', lastMinute ? `REPLAY · market time${at}` : 'REPLAY · connected');
  else if (marketOpen()) setLiveBadge('on', lastMinute ? `LIVE${at}` : 'LIVE · waiting for 09:30');
  else setLiveBadge('off', `MARKET CLOSED${lastMinute ? ` · last${at}` : ''}`);
}

function setLiveBadge(kind, text) {
  const el = $('live-badge');
  el.hidden = !kind;
  el.className = `live-badge ${kind || ''}`;
  el.querySelector('span').textContent = text || '';
}

function connectLive(symbol) {
  if (live.source) live.source.close();
  clearTimeout(live.retry);
  live.source = null;
  if (!live.url) return;
  live.symbol = symbol;
  const src = new EventSource(`${live.url}/stream?symbol=${encodeURIComponent(symbol)}`);
  live.source = src;
  src.onopen = async () => {                // connected: say so before the first candle arrives (candles start at 09:30)
    let mode = 'live';
    try { mode = (await (await fetch(`${live.url}/status`, { cache: 'no-store' })).json()).mode; } catch (e) { /* keep default */ }
    if (live.source !== src || /\d\d:\d\d/.test($('live-badge').textContent)) return;
    showLiveState(mode, null);
  };
  src.onmessage = (e) => { try { onLive(JSON.parse(e.data)); } catch (err) { /* ignore a malformed frame */ } };
  src.onerror = () => {
    if (live.source !== src) return;
    setLiveBadge('off', 'Reconnecting…');
    if (src.readyState === EventSource.CLOSED) live.retry = setTimeout(() => connectLive(symbol), 5000);
  };
}

/** The brick being filled right now: shares since the last complete brick, as a share of the box. */
function formingBrick(p) {
  const rows = p.bars[state.density], size = p.size[state.density], last = rows.at(-1);
  if (!last || !size) return null;
  const after = p.minutes.filter((m) => m[0] >= last[B.T]);
  const f = p.live?.forming;
  const vol = after.reduce((a, m) => a + m[5], 0) + (f ? f[5] : 0);
  const price = f ? f[4] : (after.at(-1) || p.minutes.at(-1))[4];
  const now = f ? f[0] + 60 : (p.minutes.at(-1)[0] + 60);
  return { frac: Math.min(1, vol / size), price, minutes: Math.max(0, Math.round((now - last[B.T]) / 60)) };
}

function onLive(p) {
  if (p.symbol !== state.symbol || !state.series || !p.bars?.standard?.length) return;
  showLiveState(p.live?.mode, p.minutes.at(-1)?.[0]);
  const stock = state.index.stocks.find((s) => s.symbol === p.symbol);
  const lastMin = p.minutes.at(-1);
  if (stock && lastMin && p.live) {
    const prev = stock.sessions.filter((d) => d.date < p.date).at(-1);
    stock.last = lastMin[4];
    if (prev?.close) stock.change = (100 * (lastMin[4] - prev.close)) / prev.close;
  }
  const range = volChart.timeScale().getVisibleLogicalRange();
  const atEdge = !range || range.to >= state.upto - 2;        // following the latest candle
  const keep = atEdge ? null : visibleTimeRange();
  state.series.upsertLive(p);
  state.forming = formingBrick(p);
  renderScanner();
  if (state.replay) return;                                  // replay keeps its own frozen view
  rebuild(keep);
  fillSessions();
  if (atEdge && range) {                                     // same zoom, newest candle at the right
    const to = state.upto - 1 + 4;
    setMainRange(to - (range.to - range.from), to);
  }
}

function overlay(kind, message) {
  const el = $('state-overlay');
  if (!kind) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = kind === 'loading' ? '<div class="skeleton"></div>'
    : `<div class="message"><div>${message}</div><button class="btn" id="retry">Try again</button></div>`;
  if (kind === 'error') $('retry').onclick = () => (state.index ? openStock(state.symbol) : init());
}

async function init() {
  overlay('loading');
  try {
    state.index = await loadIndex();
  } catch (e) {
    overlay('error', 'Could not load the market data. Check your connection.');
    $('status-data').textContent = 'Data unavailable';
    return;
  }
  live.url = await liveConfig();
  renderProof();
  renderTopSessions();
  const [hs, hd] = decodeURIComponent(location.hash.slice(1)).split('/');
  const stock = state.index.stocks.find((s) => s.symbol === hs);
  await openStock(stock ? stock.symbol : 'RELIANCE', stock ? hd : null);
}

// ================================================================ view ranges and navigation
function setMainRange(from, to) { lead('vol'); volChart.timeScale().setVisibleLogicalRange({ from, to }); syncCompare(); }

function sessionBounds(date) {
  const s = state.view.starts, k = s.findIndex((x) => x.date === date);
  if (k < 0) return null;
  return { i0: s[k].index, i1: (k + 1 < s.length ? s[k + 1].index : bars().length) - 1 };
}

function showLatest(animate = true) { showSessions(1, animate); }

function showSessions(n, animate = true) {
  const s = state.view.starts;
  const first = s[Math.max(0, s.length - n)];
  if (!first) return;
  const to = bars().length - 1 + 4;
  if (animate) glide(first.index - 1, to); else setMainRange(first.index - 1, to);
}

async function showAll() {
  overlay('loading');
  await state.series.ensureFrom(state.series.dates[0]);
  rebuild();
  fillSessions();
  overlay(null);
  lead('vol');
  volChart.timeScale().fitContent();
  requestAnimationFrame(syncCompare);
}

async function goToSession(date, animate = true) {
  if (state.series.loadedFrom > date) { await state.series.ensureFrom(date); rebuild(); fillSessions(); }
  const b = sessionBounds(date);
  if (!b) return;
  if (animate) glide(b.i0 - 1, b.i1 + 0.5); else setMainRange(b.i0 - 1, b.i1 + 0.5);
}

/** Smoothly move the main chart to show candles from..to. */
function glide(from, to) {
  const ts = volChart.timeScale(), start = ts.getVisibleLogicalRange();
  if (!start || reducedMotion()) { setMainRange(from, to); return; }
  const t0 = performance.now(), ms = 460;
  let done = false;
  const step = (now) => {
    if (done) return;
    const k = easeInOut(Math.min(1, (now - t0) / ms));
    lead('vol');
    ts.setVisibleLogicalRange({ from: start.from + (from - start.from) * k, to: start.to + (to - start.to) * k });
    if (k < 1) requestAnimationFrame(step); else { done = true; syncCompare(); }
  };
  requestAnimationFrame(step);
  setTimeout(() => { if (!done) { done = true; setMainRange(from, to); } }, ms + 120);   // frames paused: land anyway
}

// ================================================================ linking the charts
// The chart the user is touching leads; the other one follows once per frame.
let leader = null, leaderUntil = 0;
const lead = (who, ms = 350) => { leader = who; leaderUntil = performance.now() + ms; };
const leading = (who) => leader === who && performance.now() < leaderUntil;
for (const [id, who] of [['vol-wrap', 'vol'], ['time-wrap', 'time']]) {
  const el = $(id);
  el.addEventListener('pointerdown', () => lead(who, 60000), { passive: true });
  el.addEventListener('pointermove', (e) => { if (e.buttons) lead(who, 60000); }, { passive: true });
  el.addEventListener('wheel', () => lead(who), { passive: true });
  el.addEventListener('touchstart', () => lead(who, 60000), { passive: true });
}
window.addEventListener('pointerup', () => { if (leader) leaderUntil = performance.now() + 450; });

/** Point the compare chart at the stretch of time the main chart shows. */
function syncCompare() {
  const r = volChart.timeScale().getVisibleLogicalRange(), b = bars(), cs = state.candles;
  if (!r || !b.length || !cs.length || !state.layers.compare) return;
  const lastI = b.length - 1;
  const tAt = (i, col) => (i < 0 ? b[0][B.START] + i * 60 : i > lastI ? b[lastI][B.T] + (i - lastI) * 60 : b[Math.round(i)][col]);
  const t0 = tAt(Math.ceil(r.from), B.START), t1 = tAt(Math.floor(r.to), B.T);
  const key = (c) => c[0];
  const c0 = lastAtOrBefore(cs, t0, key), c1 = Math.max(0, lastAtOrBefore(cs, t1 - 1, key));
  const extra = r.to > lastI ? ((r.to - lastI) * 60) / span() : 0;
  timeChart.timeScale().setVisibleLogicalRange({ from: Math.max(-1, c0) - 0.5, to: c1 + 0.5 + extra });
}
/** Point the main chart at the stretch of time the compare chart shows. */
function syncMain() {
  const r = timeChart.timeScale().getVisibleLogicalRange(), b = bars(), cs = state.candles;
  if (!r || !b.length || !cs.length) return;
  const t0 = cs[clamp(Math.ceil(r.from), 0, cs.length - 1)][0];
  const t1 = cs[clamp(Math.floor(r.to), 0, cs.length - 1)][0] + span();
  const key = (x) => x[B.T];
  const i0 = lastAtOrBefore(b, t0, key) + 1, i1 = lastAtOrBefore(b, t1, key);
  if (i1 < i0) return;
  volChart.timeScale().setVisibleLogicalRange({ from: i0 - 0.5, to: i1 + 0.5 });
}

const onMainRange = perFrame((range) => {
  placeLegends();
  if (!state.replay && !leading('time')) syncCompare();
  onViewChanged();
  updateGoLatest(range);
  loadEarlierIfNeeded(range);
});
volChart.timeScale().subscribeVisibleLogicalRangeChange(onMainRange);
timeChart.timeScale().subscribeVisibleLogicalRangeChange(perFrame(() => { if (!state.replay && leading('time')) syncMain(); }));

// crosshair: move both charts' crosshairs together (guarded so the echo does not bounce back)
const guarded = (fn) => (p) => {
  if (!state.symbol || state.crosshairLock) return;
  state.crosshairLock = true;
  try { fn(p); } finally { state.crosshairLock = false; }
};
const barIndexByTime = (t) => lastAtOrBefore(bars(), t, (r) => r[B.T]);

volChart.subscribeCrosshairMove(guarded((p) => {
  if (p.time == null) { bands.setHover(null); timeChart.clearCrosshairPosition(); state.cursor = null; showDetails(null); return; }
  const i = barIndexByTime(p.time);
  if (i < 0 || i >= state.upto) return;
  state.cursor = i;
  const r = bars()[i], cs = state.candles, key = (c) => c[0];
  const c0 = lastAtOrBefore(cs, r[B.START], key), c1 = lastAtOrBefore(cs, r[B.T] - 1, key);
  bands.setHover(c1 >= 0 ? { i0: Math.max(0, c0), i1: c1 } : null);
  if (c1 >= 0) timeChart.setCrosshairPosition(r[B.C], cs[c1][0], tCandles);
  showDetails(i, c1);
}));

timeChart.subscribeCrosshairMove(guarded((p) => {
  bands.setHover(null);
  if (p.time == null) { volChart.clearCrosshairPosition(); showDetails(null); return; }
  const cs = state.candles, ci = lastAtOrBefore(cs, p.time, (c) => c[0]);
  const b = bars();
  let i = lastAtOrBefore(b, p.time + span(), (r) => r[B.T]);
  if (i >= 0 && b[i][B.T] <= p.time) i = -1;
  if (i >= state.upto) i = state.upto - 1;
  if (i >= 0) volChart.setCrosshairPosition(b[i][B.C], b[i][B.T], vCandles); else volChart.clearCrosshairPosition();
  showDetails(i >= 0 ? i : null, ci);
}));

// ================================================================ legends, data window, session card
const kv = (k, v, cls = '') => `<span class="k">${k}</span> <span class="v ${cls}">${v}</span>`;
const sessionMeta = (date) => state.index.stocks.find((s) => s.symbol === state.symbol)?.sessions.find((m) => m.date === date);

const showDetails = perFrame((barIdx, candleIdx) => {
  if (!state.symbol || !state.upto) return;
  const b = bars();
  const r = b[barIdx ?? state.upto - 1];
  const cs = state.candles, c = cs[candleIdx ?? cs.length - 1];
  const start = state.view.starts[r[B.SESSION]];
  const cc = c && (c[4] >= c[1] ? 'up' : 'down'), rc = r[B.C] >= r[B.O] ? 'up' : 'down';
  const [lv, lcls] = level(r[B.UIDX]);
  const unit = state.settings.chartType === 'bricks' ? 'brick' : 'candle';
  $('legend-vol').innerHTML = `<span class="title">${state.symbol} · ${TYPE_NAME[state.settings.chartType]} · 1 ${unit} = ${shares(start.size)} sh</span>` +
    kv('O', fmt(r[B.O]), rc) + kv('H', fmt(r[B.H]), rc) + kv('L', fmt(r[B.L]), rc) + kv('C', fmt(r[B.C]), rc) +
    kv('', `${shortDate(start.date)} ${hhmm(r[B.START])}–${hhmm(r[B.T])}`) +
    kv('filled in', `${fmt(r[B.FILL], 0)} min`) + (r[B.BASE] != null ? kv('normal', `${fmt(r[B.BASE], 1)} min`) : '');
  $('legend-urg').innerHTML = `<span class="title">Urgency Index</span>` + kv('', fmt(r[B.UIDX], 0), lcls) + kv('', lv, lcls);
  if (state.layers.fill) $('legend-fill').innerHTML = `<span class="title">Fill time</span>` + kv('', `${fmt(r[B.FILL], 1)}m`) + kv('normal', `${fmt(r[B.BASE], 1)}m`) + kv('VPIN', fmt(r[B.VPIN], 2), 'blue');
  if (state.layers.aai) $('legend-aai').innerHTML = `<span class="title">Absorption</span>` + kv('', fmt(r[B.AAIS], 2));
  if (state.layers.flow) {
    const f = state.flow?.[barIdx ?? state.upto - 1];
    const tag = f?.kind === 'acc' ? kv('', 'Accumulation · net buying, price held', 'up') : f?.kind === 'dist' ? kv('', 'Distribution · net selling, price held', 'down') : '';
    $('legend-flow').innerHTML = `<span class="title">Flow</span>` + (f ? kv('net', `${f.net >= 0 ? '+' : ''}${fmt(f.net * 100, 0)}%`, f.net >= 0 ? 'up' : 'down') + kv('cum. delta', shares(f.cvd)) + tag : '');
  }
  $('legend-time').innerHTML = `<span class="title">${state.symbol} · ${state.tf}m</span>` + (c
    ? kv('O', fmt(c[1]), cc) + kv('H', fmt(c[2]), cc) + kv('L', fmt(c[3]), cc) + kv('C', fmt(c[4]), cc) + kv('Vol', inr(c[5])) + (c[6] ? '' : kv('', 'forming'))
    : kv('', 'waiting for the first minute'));
  const mult = r[B.VOL] / start.size;
  $('dw').innerHTML = [
    ['Session', dayLabel(start.date)],
    ['Time', `${hhmm(r[B.START])}–${hhmm(r[B.T])}`],
    ['Open · Close', `${fmt(r[B.O])} · ${fmt(r[B.C])}`],
    ['High · Low', `${fmt(r[B.H])} · ${fmt(r[B.L])}`],
    ['Shares', `${shares(r[B.VOL])} <span class="muted">${fmt(mult, 1)}× size</span>`],
    ['Candle size', `${inr(start.size)}`],
    ['Fill time', `${fmt(r[B.FILL], 0)} min <span class="muted">normal ${fmt(r[B.BASE], 1)}</span>`],
    ['Urgency', `<span class="${lcls}">${fmt(r[B.UIDX], 0)} · ${lv}</span>`],
    ['VPIN', fmt(r[B.VPIN], 2)],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('size-chip').textContent = inr(start.size);
  placeLegends();
});

function placeLegends() {
  const ids = ['legend-vol', 'legend-urg', ...(state.layers.fill ? ['legend-fill'] : []), ...(state.layers.aai ? ['legend-aai'] : []), ...(state.layers.flow ? ['legend-flow'] : [])];
  let top = 0;
  volChart.panes().forEach((p, i) => { if (ids[i]) $(ids[i]).style.top = `${top + 8}px`; top += p.getHeight() + 1; });
}

/** The session in view: the one at the right edge of the main chart. */
let shownSession = null;
function onViewChanged(force = false) {
  const r = volChart.timeScale().getVisibleLogicalRange();
  if (!r || !state.upto) return;
  const i = clamp(Math.floor(r.to), 0, state.upto - 1);
  const k = bars()[i][B.SESSION];
  const date = state.view.starts[k].date;
  if (force || date !== shownSession || state.replay) { shownSession = date; renderSessionCard(k); }
  if (state.cursor == null) showDetails(null);
}

function renderSessionCard(k) {
  const s = state.view.starts[k];
  const i1 = k + 1 < state.view.starts.length ? state.view.starts[k + 1].index : bars().length;
  const rows = bars().slice(s.index, Math.min(i1, state.upto));
  const total = rows.reduce((a, r) => a + r[B.VOL], 0);
  const score = total ? (100 * rows.filter((r) => r[B.SPEED] === URGENT).reduce((a, r) => a + r[B.VOL], 0)) / total : 0;
  let best = null;
  for (let a = 0; a < rows.length; a++) {
    if (rows[a][B.SPEED] !== URGENT) continue;
    let z = a;
    while (z + 1 < rows.length && rows[z + 1][B.SPEED] === URGENT) z++;
    if (!best || z - a > best.z - best.a) best = { a, z };
    a = z;
  }
  $('day-label').textContent = `${state.symbol} · ${dayLabel(s.date)}${state.replay ? ` · to ${hhmm(lastTime())}` : ''}`;
  $('day-score').textContent = `${Math.round(score)}%`;
  $('day-size').textContent = `${rows.length} candles of ${inr(s.size)} shares`;
  if (!best) { $('day-burst').innerHTML = ''; state.burst = null; }
  else {
    const f = rows[best.a], l = rows[best.z], n = best.z - best.a + 1;
    const minutes = Math.max(1, Math.round((l[B.T] - f[B.START]) / 60));
    const tc = Math.max(1, Math.ceil((l[B.T] - Math.floor(f[B.START] / 300) * 300) / 300));
    state.burst = { i0: s.index + best.a, i1: s.index + best.z, t0: f[B.START], t1: l[B.T] };
    $('day-burst').innerHTML = `Largest burst: <b>${n} urgent candle${n > 1 ? 's' : ''} in ${minutes} min</b>, ${hhmm(f[B.START])}–${hhmm(l[B.T])}, ` +
      `${shares(rows.slice(best.a, best.z + 1).reduce((x, r) => x + r[B.VOL], 0))} shares. A 5-minute chart shows it as <b>${tc} candle${tc > 1 ? 's' : ''}</b>.`;
  }
  renderAlerts(s.date);
  if ($('session-select').value !== s.date) $('session-select').value = s.date;
}

$('day-burst').addEventListener('click', () => {
  const b = state.burst;
  if (!b || state.replay) return;
  glide(b.i0 - 12, b.i1 + 12);
  tools.flash(b.t0, b.t1);
});

// ================================================================ go to latest
function updateGoLatest(range) {
  $('go-latest').hidden = !(range && state.upto && range.to < state.upto - 3 && !state.replay);
}
$('go-latest').addEventListener('click', () => showLatest());

// ================================================================ Unfold
timeChart.subscribeClick((p) => {
  if (!state.symbol || p.time == null || state.replay) return;
  unfold(p.time);
});
function unfold(t0) {
  const s = span(), b = bars();
  const i0 = lastAtOrBefore(b, t0, (r) => r[B.T]) + 1, i1 = lastAtOrBefore(b, t0 + s, (r) => r[B.T]);
  if (i1 < i0) { showUnfold(`No volume candle completed inside the ${state.tf}-minute candle at ${hhmm(t0)}.`); return; }
  const n = i1 - i0 + 1;
  let urgent = 0, vol = 0;
  for (let k = i0; k <= i1; k++) { if (b[k][B.SPEED] === URGENT) urgent++; vol += b[k][B.VOL]; }
  const pad = Math.max(8, n);
  glide(i0 - pad, i1 + pad);
  tools.flash(b[i0][B.START], b[i1][B.T]);
  showUnfold(`The <b>${state.tf}-minute candle ${hhmm(t0)}–${hhmm(t0 + s)}</b> holds <b>${n} volume candle${n > 1 ? 's' : ''}</b>` +
    (urgent ? `, <b>${urgent} urgent</b>` : ', none urgent') + ` · ${shares(vol)} shares`);
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

// ================================================================ replay (one session, at market pace)
function enterReplay() {
  if (!state.symbol || state.replay) return;
  const date = shownSession || state.view.starts.at(-1).date;
  const bnd = sessionBounds(date);
  if (!bnd) return;
  state.replay = { date, ...bnd };
  tools.escape();
  hideUnfold();
  $('replay-btn').classList.add('on');
  $('replay-bar').hidden = false;
  $('go-latest').hidden = true;
  $('rp-session').textContent = dayLabel(date);
  $('rp-scrub').min = String(bnd.i0 + 1);
  $('rp-scrub').max = String(bnd.i1 + 1);
  stepTo(bnd.i0 + 1, true);
}

function exitReplay(redraw = true) {
  if (!state.replay) return;
  pause();
  const date = state.replay.date;
  state.replay = null;
  $('replay-btn').classList.remove('on');
  $('replay-bar').hidden = true;
  if (redraw && state.symbol) { rebuild(); fillSessions(); goToSession(date, false); }   // picks up live updates made during replay
}

function pinReplayWindow() {
  const { i0, i1 } = state.replay, b = bars();
  volChart.timeScale().setVisibleLogicalRange({ from: i0 - 6, to: i1 + 4 });
  const cs = aggregate(state.view.minutes, state.tf), key = (c) => c[0];
  const c0 = lastAtOrBefore(cs, b[i0][B.START], key), c1 = lastAtOrBefore(cs, b[i1][B.T] - 1, key);
  timeChart.timeScale().setVisibleLogicalRange({ from: c0 - 2, to: c1 + 2 });
}

function stepTo(k, full = false) {
  const { i0, i1 } = state.replay;
  k = clamp(k, i0 + 1, i1 + 1);
  if (!full && k === state.upto + 1) { state.upto = k; appendBar(k - 1); }     // the common case: one candle forward
  else { state.upto = k; draw(); }
  pinReplayWindow();
  state.cursor = null;
  $('rp-scrub').value = String(state.upto);
  $('rp-clock').textContent = `${hhmmss(lastTime())} · ${state.upto - i0}/${i1 - i0 + 1}`;
  renderSessionCard(bars()[state.upto - 1][B.SESSION]);
  showDetails(null);
  if (state.upto >= i1 + 1) pause();
}

// market pace: each candle waits as long as it took to fill, scaled by the chosen speed
function scheduleNext() {
  const r = bars()[state.upto];
  const delay = r ? clamp((r[B.FILL] / Number($('rp-speed').value)) * 1000, 25, 1500) : 0;
  state.timer = setTimeout(() => { stepTo(state.upto + 1); if (state.playing) scheduleNext(); }, delay);
}
const PLAY = '<path d="M4.5 3v10l8.5-5z" class="fill"/>', PAUSE = '<path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" class="fill"/>';
function play() {
  if (!state.replay) enterReplay();
  if (!state.replay) return;
  if (state.upto > state.replay.i1) stepTo(state.replay.i0 + 1, true);
  state.playing = true;
  $('rp-play-icon').innerHTML = PAUSE;
  scheduleNext();
}
function pause() {
  state.playing = false;
  clearTimeout(state.timer);
  $('rp-play-icon').innerHTML = PLAY;
}
const togglePlay = () => (state.playing ? pause() : play());

$('replay-btn').addEventListener('click', () => (state.replay ? exitReplay() : enterReplay()));
$('rp-play').addEventListener('click', togglePlay);
$('rp-back').addEventListener('click', () => { pause(); stepTo(state.upto - 1, true); });
$('rp-fwd').addEventListener('click', () => { pause(); stepTo(state.upto + 1); });
$('rp-exit').addEventListener('click', () => exitReplay());
$('rp-scrub').addEventListener('input', (e) => { pause(); stepTo(Number(e.target.value), true); });

// ================================================================ sidebar
function allSessions() {
  return state.index.stocks.flatMap((s) => s.sessions.map((d) => ({ symbol: s.symbol, ...d })))
    .sort((a, b) => b.urgency_score - a.urgency_score);
}

function renderScanner() {
  const rows = state.index.stocks.map((s) => ({ s, d: s.sessions.at(-1) })).sort((a, b) => b.d.urgency_score - a.d.urgency_score);
  const top = Math.max(1, ...rows.map((x) => x.d.urgency_score));
  $('scanner').innerHTML = rows.map(({ s, d }) => {
    const cls = s.change >= 0 ? 'up' : 'down';
    return `<tr data-sym="${s.symbol}" class="${s.symbol === state.symbol ? 'active' : ''}" title="${s.symbol} · latest session ${d.date}">` +
      `<td>${s.symbol}</td><td><span class="meter-cell">${Math.round(d.urgency_score)}%<span class="meter"><i style="width:${(100 * d.urgency_score) / top}%"></i></span></span></td>` +
      `<td>${fmt(s.last)}</td><td class="${cls}">${s.change >= 0 ? '+' : ''}${fmt(s.change)}%</td></tr>`;
  }).join('');
}
$('scanner').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-sym]'); if (tr) openStock(tr.dataset.sym); });

function renderTopSessions() {
  $('top-sessions').innerHTML = allSessions().slice(0, 8).map((x) =>
    `<li data-sym="${x.symbol}" data-date="${x.date}"><span>${x.symbol} <span class="when">${shortDate(x.date)}${x.burst ? ` · ${x.burst.from}` : ''}</span></span>` +
    `<span class="pct">${Math.round(x.urgency_score)}%</span></li>`).join('');
}
$('top-sessions').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-sym]');
  if (!li || state.replay) return;
  if (li.dataset.sym === state.symbol) goToSession(li.dataset.date);
  else await openStock(li.dataset.sym, li.dataset.date);
});

function renderAlerts(date) {
  const alerts = state.view.alerts.filter((a) => a.date === date && a.i < state.upto);
  $('alert-count').textContent = alerts.length ? String(alerts.length) : '';
  $('alerts').innerHTML = alerts.length ? alerts.map((a) =>
    `<li data-i="${a.i}"><div class="row1"><span class="kind">${a.kind}</span><span class="time">${hhmm(a.t)} · ${Math.round(a.prob * 100)}</span></div>` +
    `<ul class="reasons">${a.reasons.map((x) => `<li>${x}</li>`).join('')}</ul></li>`).join('')
    : `<li class="empty">${state.replay ? 'No alert yet.' : 'No alerts in this session.'}</li>`;
}
$('alerts').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li || state.replay) return;
  const i = Number(li.dataset.i), r = bars()[i];
  glide(i - 20, i + 10);
  tools.flash(r[B.START], r[B.T]);
});

function renderProof() {
  const r = state.index.results, u = r.urgency, pct = (x) => `${Math.round(x * 100)}%`;
  $('proof').innerHTML = `After an urgent candle, a large move followed <b>${pct(u.all_day.urgent)}</b> of the time, against ${pct(u.all_day.other)} after other candles: ` +
    `<b>${u.all_day.lift.toFixed(1)}×</b>. Outside the opening hour, <b>${u.after_10_30.lift.toFixed(1)}×</b>. Stable at ${u.lift_range[0].toFixed(1)}–${u.lift_range[1].toFixed(1)}× ` +
    'across thresholds. Urgency does not predict direction.';
  const rows = [['VPIN', 'vpin'], ['Fill pace alone', 'volume_bars'], ['Time: volume spike', 'time_chart'], ['Time: 30-min range', 'recent_volatility'], ['VolumeLens alerts', 'volumelens']];
  const wins = Object.values(r.per_stock).filter((s) => s.auc_volumelens > s.auc_vpin).length;
  $('results').innerHTML = `<caption>Walk-forward on ${r.test_days.length} unseen sessions, ${state.index.stocks.length} stocks · beats VPIN on ${wins} of ${Object.keys(r.per_stock).length}</caption>` +
    '<thead><tr><th>Signal</th><th>AUC</th><th>Caught</th></tr></thead><tbody>' +
    rows.map(([label, k]) => `<tr class="${k === 'volumelens' ? 'ours' : ''}"><td>${label}</td><td>${fmt(r.auc[k], 3)}</td><td>${Math.round(r.catch_rate[k] * 100)}%</td></tr>`).join('') + '</tbody>';
}

function fillSessions() {
  const meta = state.index.stocks.find((s) => s.symbol === state.symbol).sessions;
  $('session-select').innerHTML = [...meta].reverse().map((d) => `<option value="${d.date}">${d.date}  ${String(Math.round(d.urgency_score)).padStart(2)}%${d.alerts ? ' ●' : ''}</option>`).join('');
  if (shownSession) $('session-select').value = shownSession;
  $('status-data').textContent = `${state.symbol} · ${state.series.sessions.length} of ${meta.length} sessions loaded (${shortDate(state.series.loadedFrom)} – ${shortDate(meta.at(-1).date)}) · NSE 1-minute data · ${TYPE_NAME[state.settings.chartType]}, ${DENSITY_LABEL[state.density].toLowerCase()} box`;
}
$('session-select').addEventListener('change', (e) => { if (!state.replay) goToSession(e.target.value); });

// ================================================================ toolbar
const symInput = $('symbol-input'), symList = $('symbol-list');
let symActive = 0;
function showSymbols() {
  const q = symInput.value.trim().toUpperCase();
  const hits = state.index.stocks.filter((s) => s.symbol.includes(q));
  symActive = Math.min(symActive, Math.max(0, hits.length - 1));
  symList.innerHTML = hits.map((s, i) => `<li data-sym="${s.symbol}" class="${i === symActive ? 'active' : ''}"><span>${s.symbol}</span><span class="muted">${s.sessions.length} sessions</span></li>`).join('') || '<li class="muted">No match</li>';
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
  } else if (e.key === 'Enter' && items[symActive]) { symList.hidden = true; symInput.blur(); openStock(items[symActive].dataset.sym); }
  else if (e.key === 'Escape') { symList.hidden = true; symInput.value = state.symbol; symInput.blur(); }
});
symList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-sym]');
  if (li) { e.preventDefault(); symList.hidden = true; symInput.blur(); openStock(li.dataset.sym); }
});
symInput.addEventListener('blur', () => setTimeout(() => { symList.hidden = true; symInput.value = state.symbol || ''; }, 120));

function segmented(id, items, current, onPick) {
  const el = $(id);
  el.innerHTML = items.map(([v, label]) => `<button data-v="${v}" class="${String(v) === String(current) ? 'on' : ''}" aria-pressed="${String(v) === String(current)}">${label}</button>`).join('');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    el.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    onPick(b.dataset.v);
  });
}
segmented('density', Object.keys(DENSITY_LABEL).map((k) => [k, DENSITY_LABEL[k]]), state.density, (v) => setDensity(v));
segmented('ctype', Object.keys(CHART_TYPES).map((k) => [k, CHART_TYPES[k]]), state.settings.chartType, (v) => {
  state.settings.chartType = v;
  applySettings();
});
function setDensity(v) {
  if (v === state.density) return;
  if (state.replay) exitReplay();
  const keep = visibleTimeRange();
  state.density = v; store('vl:density', v);
  $('density').querySelectorAll('button').forEach((x) => { const on = x.dataset.v === v; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
  rebuild(keep); setWatermark(); fillSessions();
  syncSettingsForm();
}
segmented('tf', TIMEFRAMES.map((m) => [m, `${m}m`]), state.tf, (v) => {
  state.tf = Number(v); store('vl:tf', state.tf);
  drawCompare();
  if (state.replay) pinReplayWindow(); else syncCompare();
  showDetails(state.cursor);
});
$('ranges').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b || state.replay) return;
  if (b.dataset.range === 'all') showAll(); else showSessions(Number(b.dataset.range));
});

// layers
function applyLayers() {
  const L = state.layers;
  document.querySelectorAll('[data-layer]').forEach((c) => { c.checked = !!L[c.dataset.layer]; });
  $('time-wrap').hidden = !L.compare;
  $('resizer').hidden = !L.compare;
  vCandles.applyOptions(mainOptions());
  tCandles.applyOptions(candleOptions());
  setPanes();
  store('vl:layers', L);
  if (state.symbol) { draw(); if (L.compare) requestAnimationFrame(syncCompare); requestAnimationFrame(placeLegends); }
}
document.querySelectorAll('[data-layer]').forEach((c) => c.addEventListener('change', () => { state.layers[c.dataset.layer] = c.checked; applyLayers(); }));
$('compare-close').addEventListener('click', () => { state.layers.compare = false; applyLayers(); });
document.addEventListener('click', (e) => { const m = $('layers'); if (m.open && !m.contains(e.target)) m.open = false; });

// chart settings (gear): one dialog, every change applies at once and is remembered in this browser
const SCALE_MODE = { normal: LWC.PriceScaleMode.Normal, log: LWC.PriceScaleMode.Logarithmic, percent: LWC.PriceScaleMode.Percentage };
function syncSettingsForm() {
  const S = state.settings, f = $('settings');
  f.querySelectorAll('[data-set]').forEach((el) => {
    const v = S[el.dataset.set];
    if (el.type === 'radio') el.checked = el.value === String(v);
    else if (el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v);
  });
  f.querySelectorAll('input[name=density]').forEach((el) => { el.checked = el.value === state.density; });
  f.querySelectorAll('[data-layer]').forEach((c) => { c.checked = !!state.layers[c.dataset.layer]; });
  $('out-urgent').textContent = S.urgent;
  $('out-watch').textContent = S.watch;
  const size = state.view.starts.at(-1)?.size;
  $('set-size-note').textContent = 'Adaptive: each candle holds a fixed number of shares, set per stock from its previous 20 sessions.' +
    (size ? ` ${state.symbol} now: 1 candle = ${inr(size)} shares.` : '');
}
function applySettings(redraw = true) {
  const S = state.settings;
  if (S.watch >= S.urgent) S.watch = S.urgent - 5;
  TH.urgent = S.urgent; TH.watch = S.watch;
  store('vl:settings:v2', S);
  styleUrgency();
  volChart.priceScale('right', 0).applyOptions({ mode: SCALE_MODE[S.scale] ?? LWC.PriceScaleMode.Normal });
  vCandles.applyOptions(mainOptions());
  styleLine();
  $('ctype').querySelectorAll('button').forEach((x) => { const on = x.dataset.v === S.chartType; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
  if (state.symbol) { setWatermark(); fillSessions(); }
  syncSettingsForm();
  if (!redraw || !state.symbol) return;
  if (state.replay) { draw(); return; }
  rebuild(visibleTimeRange());
}
$('settings').addEventListener('input', (e) => {
  const el = e.target;
  if (el.name === 'density') { setDensity(el.value); return; }
  if (!el.dataset.set) return;
  const k = el.dataset.set, S = state.settings;
  S[k] = el.type === 'checkbox' ? el.checked : typeof DEFAULT_SETTINGS[k] === 'number' ? Number(el.value) : el.value;
  applySettings(k !== 'scale');
});
document.querySelectorAll('.settings-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.settings-tabs [data-tab]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
  document.querySelectorAll('.settings-panels [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
}));
$('settings-reset').addEventListener('click', () => {
  state.settings = { ...DEFAULT_SETTINGS };
  setDensity('standard');
  Object.assign(state.layers, { compare: true, shade: true, fill: false, aai: false, flow: true, hollow: false });
  applyLayers();
  applySettings();
});
function openSettings() { syncSettingsForm(); $('settings').showModal(); }
$('settings-btn').addEventListener('click', openSettings);
applySettings(false);

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
function toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else $('stage').requestFullscreen?.(); }

/** Save both charts as one PNG with a caption. */
function snapshot() {
  if (!state.symbol) return;
  const main = volChart.takeScreenshot();
  const comp = state.layers.compare ? timeChart.takeScreenshot() : null;
  const scale = main.width / $('vol-wrap').clientWidth;
  const head = Math.round(44 * scale), foot = Math.round(26 * scale);
  const compH = comp ? Math.round(comp.height * (main.width / comp.width)) : 0;
  const out = document.createElement('canvas');
  out.width = main.width; out.height = head + main.height + compH + foot;
  const g = out.getContext('2d'), t = th();
  g.fillStyle = t.bg; g.fillRect(0, 0, out.width, out.height);
  g.drawImage(main, 0, head);
  if (comp) g.drawImage(comp, 0, head + main.height, main.width, compH);
  g.fillStyle = state.theme === 'dark' ? '#e3e6ec' : '#11141b';
  g.font = `600 ${15 * scale}px "IBM Plex Sans", sans-serif`;
  g.fillText(`VolumeLens · ${state.symbol} · ${TYPE_NAME[state.settings.chartType]} · ${DENSITY_LABEL[state.density]} box`, 16 * scale, 28 * scale);
  g.fillStyle = t.accent; g.font = `500 ${12 * scale}px "JetBrains Mono", monospace`; g.textAlign = 'right';
  g.fillText(`${$('day-label').textContent} · urgency ${$('day-score').textContent}`, out.width - 16 * scale, 28 * scale);
  g.textAlign = 'left'; g.fillStyle = t.text; g.font = `400 ${11 * scale}px "IBM Plex Sans", sans-serif`;
  g.fillText('Volume candles: one candle per fixed number of shares. Amber = urgent. Educational, not investment advice. Charting by TradingView Lightweight Charts.', 16 * scale, out.height - 9 * scale);
  const a = document.createElement('a');
  a.download = `VolumeLens_${state.symbol}_${shownSession || 'chart'}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
}

$('theme-btn').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; store('vl:theme', state.theme); applyTheme(); });
$('help-btn').addEventListener('click', () => $('help').showModal());

// ================================================================ keyboard
document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof Element && e.target.matches('input:not([type=range]):not([type=checkbox]), select');
  if (typing || $('help').open || $('settings').open || !state.symbol) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); tools.undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const toolKeys = { v: 'cursor', h: 'hline', t: 'trend', z: 'zone', m: 'measure' };
  if (toolKeys[k.toLowerCase()] && !state.replay) { tools.setTool(toolKeys[k.toLowerCase()]); return; }
  switch (k) {
    case 'g': case 'G': toggleMagnet(); break;
    case 's': case 'S': snapshot(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'r': case 'R': if (state.replay) exitReplay(); else enterReplay(); break;
    case 'l': case 'L': if (!state.replay) showLatest(); break;
    case '?': $('help').showModal(); break;
    case ',': openSettings(); break;
    case ' ': if (state.replay) { e.preventDefault(); togglePlay(); } break;
    case 'ArrowRight': case 'ArrowLeft': {
      e.preventDefault();
      const dir = k === 'ArrowRight' ? 1 : -1;
      if (state.replay) { pause(); stepTo(state.upto + dir, dir < 0); break; }
      const i = clamp((state.cursor ?? state.upto - 1) + dir, 0, state.upto - 1);
      state.cursor = i;
      volChart.setCrosshairPosition(bars()[i][B.C], bars()[i][B.T], vCandles);
      break;
    }
    case 'Escape':
      if (tools.escape()) break;
      if (!$('unfold-card').hidden) { hideUnfold(); break; }
      if (state.replay) exitReplay(); else showLatest();
      break;
    default:
  }
});

// ================================================================ layout: resizable split
const resizer = $('resizer'), timeWrap = $('time-wrap');
resizer.addEventListener('pointerdown', (e) => {
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  const box = $('stage').getBoundingClientRect();
  const move = (ev) => { timeWrap.style.flexBasis = `${clamp(((box.bottom - ev.clientY) / box.height) * 100, 16, 60)}%`; };
  const up = () => { resizer.classList.remove('dragging'); resizer.removeEventListener('pointermove', move); resizer.removeEventListener('pointerup', up); requestAnimationFrame(placeLegends); };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up);
});
new ResizeObserver(perFrame(placeLegends)).observe($('vol-wrap'));
document.addEventListener('pointerup', () => requestAnimationFrame(placeLegends));

// ================================================================ AI analyst context
// Compact numbers for the candles in view (only what was known up to the replay cursor). The AI
// sees these numbers and nothing else, so everything it says can be checked on the chart.
const r2 = (x, d = 2) => (x == null || Number.isNaN(x) ? null : Number(x.toFixed(d)));
const median = (xs) => { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
/** Runs of consecutive candles (same session) where key(k) is the same non-null value. */
function runs(from, to, key) {
  const b = bars(), out = [];
  for (let k = from; k <= to; k++) {
    const v = key(k), last = out.at(-1);
    if (v == null) continue;
    if (last && last.v === v && last.to === k - 1 && b[k - 1][B.SESSION] === b[k][B.SESSION]) last.to = k;
    else out.push({ v, from: k, to: k });
  }
  return out;
}
function analystContext() {
  const b = bars(), n = state.upto;
  if (!state.symbol || !n) return null;
  const vr = volChart.timeScale().getVisibleLogicalRange();
  const from = clamp(Math.ceil(vr?.from ?? 0), 0, n - 1), to = clamp(Math.floor(vr?.to ?? n - 1), from, n - 1);
  const rows = b.slice(from, to + 1), f = state.flow || [];
  const date = (k) => state.view.starts[b[k][B.SESSION]].date;
  const at = (k, end = true) => `${date(k)} ${hhmm(b[k][end ? B.T : B.START])}`;
  const span = (x) => ({ from: at(x.from, false), to: at(x.to), candles: x.to - x.from + 1 });
  const peak = (key) => { let best = from; for (let k = from; k <= to; k++) if ((b[k][key] ?? -1) > (b[best][key] ?? -1)) best = k; return best; };
  const sum = (x, i) => { let s = 0; for (let k = x.from; k <= x.to; k++) s += b[k][i]; return s; };
  const pu = peak(B.UIDX), pv = peak(B.VPIN);
  const dates = [...new Set(rows.map((r) => state.view.starts[r[B.SESSION]].date))];
  const bursts = runs(from, to, (k) => (b[k][B.SPEED] === URGENT ? 'u' : null)).filter((x) => x.to > x.from)
    .sort((p, q) => (q.to - q.from) - (p.to - p.from)).slice(0, 4)
    .map((x) => ({ ...span(x), shares: sum(x, B.VOL), price_from: b[x.from][B.O], price_to: b[x.to][B.C] }));
  const zones = runs(from, to, (k) => f[k]?.kind ?? null).sort((p, q) => (q.to - q.from) - (p.to - p.from)).slice(0, 6)
    .map((x) => {
      let lo = Infinity, hi = -Infinity, net = 0;
      for (let k = x.from; k <= x.to; k++) { lo = Math.min(lo, b[k][B.L]); hi = Math.max(hi, b[k][B.H]); net += f[k].net; }
      return { kind: x.v === 'acc' ? 'accumulation' : 'distribution', ...span(x), price_low: lo, price_high: hi, avg_net_flow: r2(net / (x.to - x.from + 1), 3) };
    });
  const urgent = rows.filter((r) => r[B.SPEED] === URGENT).length;
  return {
    symbol: state.symbol,
    candle_size_shares: state.view.starts[b[to][B.SESSION]].size,
    replay: !!state.replay,
    view: { from: at(from, false), to: at(to), candles: rows.length },
    sessions: dates.map((d) => ({ date: d, pct_of_session_shares_in_urgent_candles: r2(sessionMeta(d)?.urgency_score, 1) })),
    price: { open: b[from][B.O], close: b[to][B.C], high: Math.max(...rows.map((r) => r[B.H])), low: Math.min(...rows.map((r) => r[B.L])),
      change_pct: r2((b[to][B.C] / b[from][B.O] - 1) * 100) },
    urgency: { urgent_candles: urgent, watch_candles: rows.filter((r) => r[B.SPEED] === WATCH).length, urgent_share_pct: r2((urgent / rows.length) * 100, 1),
      peak_index: b[pu][B.UIDX], peak_at: at(pu), index_at_view_end: b[to][B.UIDX], longest_urgent_runs: bursts },
    fill_time_min: { median: r2(median(rows.map((r) => r[B.FILL]))), normal_median: r2(median(rows.map((r) => r[B.BASE]))) },
    vpin: { start: r2(b[from][B.VPIN], 3), end: r2(b[to][B.VPIN], 3), max: r2(b[pv][B.VPIN], 3), max_at: at(pv) },
    flow: optional.flowNet && f.length >= n ? { net_flow_at_view_end: r2(f[to]?.net, 3), cumulative_delta_shares_at_view_end: Math.round(f[to]?.cvd ?? 0),
      accumulation_candles: rows.filter((r, i) => f[from + i]?.kind === 'acc').length,
      distribution_candles: rows.filter((r, i) => f[from + i]?.kind === 'dist').length, zones } : 'flow pane is off',
    absorption_avg: r2(rows.reduce((s, r) => s + (r[B.AAIS] ?? 0), 0) / rows.length),
    model_alerts: state.view.alerts.filter((a) => a.i >= from && a.i <= to).slice(-5)
      .map((a) => ({ at: at(a.i), kind: a.kind, probability: a.prob, reasons: a.reasons })),
  };
}
initAnalyst(analystContext);

// read-only handles for the automated browser tests (only with ?debug in the URL)
if (new URLSearchParams(location.search).has('debug')) window.vl = { volChart, timeChart, state, bars, analystContext };

styleUrgency();
applyTheme();
applyLayers();
init();
