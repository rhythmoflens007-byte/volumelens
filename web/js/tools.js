// Drawing tools for the volume chart: horizontal line, trend line, zone, measure.
//
// Trend lines, zones and the measure are painted by a series primitive (a native Lightweight
// Charts plugin), so they move with every zoom, pan and resize. Points are stored as (time,
// price) and converted to a candle position when drawn, so drawings stay attached to the right
// candle even when earlier sessions are loaded in front of them. Horizontal lines are native
// price lines on both charts, since both share the price axis.

import { B, clamp, fmt, shares, store, lastAtOrBefore, xAt } from './util.js?v=51';

const TOOLS = ['cursor', 'hline', 'trend', 'zone', 'measure'];

class DrawingLayer {
  constructor(colors, toX) {
    this.colors = colors;
    this.toX = toX;       // time -> x coordinate
    this.items = [];      // committed trend lines and zones
    this.preview = null;  // shape being drawn
    this.measure = null;  // the current measurement
    this.flash = null;    // {t0, t1, alpha}: highlight used by Unfold and focus
    this.label = null;    // (a, b) -> text lines for the measure box
    this._view = { renderer: () => ({ draw: (target) => this._draw(target) }), zOrder: () => 'top' };
  }

  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this._view]; }
  update() { if (this.requestUpdate) this.requestUpdate(); }

  _xy(p) {
    const x = this.toX(p.t), y = this.series.priceToCoordinate(p.p);
    return x == null || y == null ? null : [x, y];
  }

  _draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const c = this.colors();
      if (this.flash) {
        const x0 = this.toX(this.flash.t0, -0.5), x1 = this.toX(this.flash.t1, 0.5);
        if (x0 != null && x1 != null) {
          ctx.fillStyle = `rgba(255, 152, 0, ${0.16 * this.flash.alpha})`;
          ctx.fillRect(x0, 0, Math.max(2, x1 - x0), mediaSize.height);
        }
      }
      for (const d of [...this.items, this.preview].filter(Boolean)) {
        const a = this._xy(d.a), b = this._xy(d.b);
        if (!a || !b) continue;
        if (d.type === 'trend') {
          ctx.strokeStyle = c.draw; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
          for (const pt of [a, b]) { ctx.fillStyle = c.draw; ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.5, 0, Math.PI * 2); ctx.fill(); }
        } else if (d.type === 'zone') {
          const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
          ctx.fillStyle = c.zoneFill; ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = c.zoneLine; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        }
      }
      const m = this.measure;
      if (!m) return;
      const a = this._xy(m.a), b = this._xy(m.b);
      if (!a || !b) return;
      const up = m.b.p >= m.a.p, col = up ? c.up : c.down;
      ctx.fillStyle = up ? 'rgba(31,163,122,0.14)' : 'rgba(229,72,77,0.14)';
      ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
      const lines = this.label ? this.label(m.a, m.b) : [];
      ctx.font = '500 11px "JetBrains Mono", monospace';
      const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 16, h = lines.length * 15 + 10;
      let bx = b[0] + 10;
      if (bx + w > mediaSize.width - 4) bx = b[0] - w - 10;
      const by = clamp(b[1] - h / 2, 4, mediaSize.height - h - 4);
      ctx.fillStyle = col; roundRect(ctx, bx, by, w, h, 5); ctx.fill();
      ctx.fillStyle = '#fff';
      lines.forEach((s, k) => ctx.fillText(s, bx + 8, by + 18 + k * 15));
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/**
 * opts: { volChart, vCandles, tCandles, getBars(), colors(), onToolChange(tool) }
 * getBars() returns the continuous candle rows currently on the chart.
 */
export function createTools(opts) {
  const { volChart, vCandles, tCandles, getBars, colors, onToolChange } = opts;
  const ts = volChart.timeScale();

  // time <-> candle position. Past the last candle, one minute of time = one candle slot.
  const timeToLogical = (t) => {
    const bars = getBars();
    if (!bars.length) return null;
    const last = bars.length - 1;
    if (t > bars[last][B.T]) return last + (t - bars[last][B.T]) / 60;
    return Math.max(0, lastAtOrBefore(bars, t, (r) => r[B.T]));
  };
  const logicalToTime = (i) => {
    const bars = getBars();
    const last = bars.length - 1;
    if (i > last) return bars[last][B.T] + Math.round(i - last) * 60;
    return bars[clamp(Math.round(i), 0, last)][B.T];
  };
  const toX = (t, shift = 0) => { const i = timeToLogical(t); return i == null ? null : xAt(ts, i + shift); };

  const layer = new DrawingLayer(colors, toX);
  vCandles.attachPrimitive(layer);

  let tool = 'cursor', pending = null, symbol = null, hlines = [], history = [];

  layer.label = (a, b) => {
    const bars = getBars();
    const lo = clamp(timeToLogical(Math.min(a.t, b.t)), 0, bars.length - 1);
    const hi = clamp(timeToLogical(Math.max(a.t, b.t)), 0, bars.length - 1);
    let vol = 0;
    for (let k = Math.round(lo); k <= Math.round(hi); k++) vol += bars[k][B.VOL];
    const n = Math.round(hi) - Math.round(lo) + 1;
    const d = b.p - a.p;
    const minutes = Math.max(0, Math.round((bars[Math.round(hi)][B.T] - bars[Math.round(lo)][B.START]) / 60));
    return [`${d >= 0 ? '+' : ''}${fmt(d)} (${d >= 0 ? '+' : ''}${fmt((100 * d) / a.p)}%)`,
      `${n} candles · ${shares(vol)} sh`, `${minutes} min`];
  };

  // Points come from raw pointer events: the chart delays a quick second click (waiting for a
  // possible double-click), which loses points when drawing fast. A press that moves more than
  // 4px is a pan, not a point.
  const el = volChart.chartElement();
  let down = null;
  el.addEventListener('pointerdown', (e) => { down = tool === 'cursor' || e.button !== 0 ? null : { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
    down = null;
    const box = el.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    if (x > ts.width() || y > volChart.panes()[0].getHeight()) return;      // price axis or lower panes
    place({ x, y });
  });

  const pointAt = ({ x, y }) => {
    const i = ts.coordinateToLogical(x), p = vCandles.coordinateToPrice(y);
    return i == null || p == null ? null : { t: logicalToTime(i), p };
  };

  function place(xy) {
    const pt = pointAt(xy);
    if (!pt || tool === 'cursor') return;
    if (tool === 'hline') { addHline(pt.p); return; }
    if (!pending) { pending = { type: tool, a: pt, b: pt }; return; }
    const shape = { type: pending.type, a: pending.a, b: pt };
    pending = null; layer.preview = null;
    if (shape.type === 'measure') layer.measure = shape;
    else { layer.items.push(shape); history.push({ kind: 'shape', ref: shape }); }
    save(); layer.update();
  }

  volChart.subscribeCrosshairMove((p) => {
    if (!pending || !p.point || (p.paneIndex != null && p.paneIndex !== 0)) return;
    const pt = pointAt(p.point);
    if (!pt) return;
    pending.b = pt;
    if (pending.type === 'measure') layer.measure = pending; else layer.preview = pending;
    layer.update();
  });

  function setTool(t) {
    if (!TOOLS.includes(t)) return;
    tool = t; pending = null; layer.preview = null; layer.update();
    volChart.applyOptions({ handleScroll: { pressedMouseMove: t === 'cursor' } });
    onToolChange(t);
  }

  function addHline(price, remember = true) {
    const opt = { price, color: colors().draw, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' };
    const h = { price, lines: [vCandles.createPriceLine(opt), tCandles.createPriceLine(opt)] };
    hlines.push(h);
    if (remember) { history.push({ kind: 'hline', ref: h }); save(); }
  }
  function removeHline(h) {
    vCandles.removePriceLine(h.lines[0]);
    tCandles.removePriceLine(h.lines[1]);
    hlines = hlines.filter((x) => x !== h);
  }

  function save() {
    if (!symbol) return;
    store(`vl:shapes:${symbol}`, layer.items);
    store(`vl:hlines:${symbol}`, hlines.map((h) => h.price));
  }

  /** Switch stock: drop the old drawings and load the saved ones. */
  function load(sym) {
    for (const h of [...hlines]) removeHline(h);
    symbol = sym;
    layer.items = (store(`vl:shapes:${sym}`) || []).filter((d) => d.a && d.a.t != null);
    layer.measure = null; layer.preview = null; pending = null; history = [];
    for (const price of store(`vl:hlines:${sym}`) || []) addHline(price, false);
    layer.update();
  }

  function undo() {
    const last = history.pop();
    if (!last) { if (layer.measure) { layer.measure = null; layer.update(); } return; }
    if (last.kind === 'hline') removeHline(last.ref);
    else layer.items = layer.items.filter((x) => x !== last.ref);
    save(); layer.update();
  }

  function clear() {
    for (const h of [...hlines]) removeHline(h);
    layer.items = []; layer.measure = null; layer.preview = null; pending = null; history = [];
    save(); layer.update();
  }

  /** Esc: cancel a half-drawn shape, else drop the measurement, else return to the cursor. */
  function escape() {
    if (pending) { pending = null; layer.preview = null; if (tool === 'measure') layer.measure = null; layer.update(); return true; }
    if (layer.measure) { layer.measure = null; layer.update(); return true; }
    if (tool !== 'cursor') { setTool('cursor'); return true; }
    return false;
  }

  function recolor() {
    for (const h of hlines) for (const l of h.lines) l.applyOptions({ color: colors().draw });
    layer.update();
  }

  return {
    setTool, load, undo, clear, escape, recolor, timeToLogical,
    get tool() { return tool; },
    refresh() { layer.update(); },
    flash(t0, t1, ms = 2400) {                     // highlight a stretch of time, fading out
      const start = performance.now();
      const step = (now) => {
        const k = (now - start) / ms;
        layer.flash = k >= 1 ? null : { t0, t1, alpha: k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85 };
        layer.update();
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
  };
}
