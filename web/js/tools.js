// Drawing tools for the volume chart: horizontal line, trend line, zone, measure.
//
// Trend lines, zones and the measure are drawn by a series primitive (a native Lightweight
// Charts plugin), so they are painted by the chart itself and stay locked to their candles and
// prices through every zoom, pan and resize. Points are stored as (logical bar index, price):
// the bars of a day never change, so an index is stable, and it also works in empty space.
// Horizontal lines are native price lines on both charts, since both share the price axis.

import { B, clamp, fmt, shares, store } from './util.js?v=24';

const TOOLS = ['cursor', 'hline', 'trend', 'zone', 'measure'];

class DrawingLayer {
  constructor(colors) {
    this.colors = colors;
    this.items = [];      // committed trend lines and zones
    this.preview = null;  // shape being drawn
    this.measure = null;  // the current measurement, if any
    this.flash = null;    // {i0, i1, alpha}: highlight used by Unfold
    this.label = null;    // (a, b) -> text lines for the measure box
    this._view = { renderer: () => ({ draw: (target) => this._draw(target) }), zOrder: () => 'top' };
  }

  attached({ chart, series, requestUpdate }) {
    this.chart = chart; this.series = series; this.requestUpdate = requestUpdate;
  }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this._view]; }
  update() { if (this.requestUpdate) this.requestUpdate(); }

  _xy(p) {
    const x = this.chart.timeScale().logicalToCoordinate(p.i);
    const y = this.series.priceToCoordinate(p.p);
    return x == null || y == null ? null : [x, y];
  }

  _draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const c = this.colors();
      if (this.flash) {
        const x0 = this.chart.timeScale().logicalToCoordinate(this.flash.i0 - 0.5);
        const x1 = this.chart.timeScale().logicalToCoordinate(this.flash.i1 + 0.5);
        if (x0 != null && x1 != null) {
          ctx.fillStyle = `rgba(255, 152, 0, ${0.16 * this.flash.alpha})`;
          ctx.fillRect(x0, 0, x1 - x0, mediaSize.height);
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
          ctx.fillStyle = c.zoneFill; ctx.strokeStyle = c.zoneLine; ctx.lineWidth = 1;
          ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
          ctx.strokeRect(Math.min(a[0], b[0]) + 0.5, Math.min(a[1], b[1]) + 0.5, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        }
      }
      const m = this.measure;
      if (m) {
        const a = this._xy(m.a), b = this._xy(m.b);
        if (a && b) {
          const up = m.b.p >= m.a.p;
          ctx.fillStyle = up ? 'rgba(8,153,129,0.14)' : 'rgba(242,54,69,0.14)';
          ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
          ctx.strokeStyle = up ? '#089981' : '#f23645'; ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
          ctx.setLineDash([]);
          const lines = this.label ? this.label(m.a, m.b) : [];
          ctx.font = '500 11px "JetBrains Mono", monospace';
          const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 16, h = lines.length * 15 + 10;
          let bx = b[0] + 10, by = b[1] - h / 2;
          if (bx + w > mediaSize.width - 4) bx = b[0] - w - 10;
          by = clamp(by, 4, mediaSize.height - h - 4);
          ctx.fillStyle = up ? '#089981' : '#f23645';
          roundRect(ctx, bx, by, w, h, 5); ctx.fill();
          ctx.fillStyle = '#fff';
          lines.forEach((s, k) => ctx.fillText(s, bx + 8, by + 18 + k * 15));
        }
      }
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/**
 * Wire the tools to the charts.
 * opts: { volChart, vCandles, tCandles, getDay(), colors(), onToolChange(tool) }
 */
export function createTools(opts) {
  const { volChart, vCandles, tCandles, getDay, colors, onToolChange } = opts;
  const layer = new DrawingLayer(colors);
  vCandles.attachPrimitive(layer);

  let tool = 'cursor', pending = null, key = null, hlines = [], history = [];

  layer.label = (a, b) => {
    const day = getDay();
    const bars = day.bars;
    const lo = clamp(Math.round(Math.min(a.i, b.i)), 0, bars.length - 1);
    const hi = clamp(Math.round(Math.max(a.i, b.i)), 0, bars.length - 1);
    const n = hi - lo + 1;
    const d = b.p - a.p;
    const minutes = Math.max(0, Math.round((bars[hi][B.T] - bars[lo][B.START]) / 60));
    return [`${d >= 0 ? '+' : ''}${fmt(d)} (${d >= 0 ? '+' : ''}${fmt((100 * d) / a.p)}%)`,
      `${n} candles · ${shares(n * day.barSize)} sh`, `${minutes} min`];
  };

  const pointFrom = (p) => {
    if (!p.point || (p.paneIndex != null && p.paneIndex !== 0)) return null;
    const i = p.logical ?? volChart.timeScale().coordinateToLogical(p.point.x);
    const price = vCandles.coordinateToPrice(p.point.y);
    return i == null || price == null ? null : { i: Math.round(i), p: price };
  };

  function setTool(t) {
    if (!TOOLS.includes(t)) return;
    tool = t; pending = null; layer.preview = null; layer.update();
    volChart.applyOptions({ handleScroll: { pressedMouseMove: t === 'cursor' } });
    onToolChange(t);
  }

  function addHline(price, remember = true) {
    const c = colors();
    const opt = { price, color: c.draw, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' };
    const h = { price, lines: [vCandles.createPriceLine(opt), tCandles.createPriceLine(opt)] };
    hlines.push(h);
    if (remember) history.push({ kind: 'hline', ref: h });
    save();
  }

  function removeHline(h) {
    h.lines[0] && vCandles.removePriceLine(h.lines[0]);
    h.lines[1] && tCandles.removePriceLine(h.lines[1]);
    hlines = hlines.filter((x) => x !== h);
  }

  // Points are read from raw pointer events rather than the chart's click event: the chart
  // swallows a quick second click (it waits to see if it becomes a double-click), which made
  // fast two-click drawing miss points. A press that moves more than 4px is a pan, not a point.
  const el = volChart.chartElement();
  let down = null;
  el.addEventListener('pointerdown', (e) => { down = tool === 'cursor' || e.button !== 0 ? null : { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
    down = null;
    const box = el.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const pane0 = volChart.panes()[0].getHeight();
    if (x > volChart.timeScale().width() || y > pane0) return;       // price axis or lower panes
    onPoint({ point: { x, y }, paneIndex: 0, logical: volChart.timeScale().coordinateToLogical(x) });
  });

  function onPoint(p) {
    if (tool === 'cursor') return;
    const pt = pointFrom(p);
    if (!pt) return;
    if (tool === 'hline') { addHline(pt.p); return; }
    if (!pending) { pending = { type: tool, a: pt, b: pt }; return; }
    const shape = { type: pending.type, a: pending.a, b: pt };
    pending = null; layer.preview = null;
    if (shape.type === 'measure') layer.measure = shape;
    else { layer.items.push(shape); history.push({ kind: 'shape', ref: shape }); }
    save(); layer.update();
  }

  volChart.subscribeCrosshairMove((p) => {
    if (!pending) return;
    const pt = pointFrom(p);
    if (!pt) return;
    pending.b = pt;
    if (pending.type === 'measure') layer.measure = pending;
    else layer.preview = pending;
    layer.update();
  });

  function save() {
    if (!key) return;
    store(`vl:shapes:${key.symbol}:${key.date}`, layer.items);
    store(`vl:hlines:${key.symbol}`, hlines.map((h) => h.price));
  }

  /** Switch to another stock/day: drop the old drawings, load the saved ones. */
  function load(symbol, date) {
    for (const h of [...hlines]) removeHline(h);
    layer.items = store(`vl:shapes:${symbol}:${date}`) || [];
    layer.measure = null; layer.preview = null; pending = null; history = [];
    key = { symbol, date };
    for (const price of store(`vl:hlines:${symbol}`) || []) addHline(price, false);
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
    const c = colors();
    for (const h of hlines) for (const l of h.lines) l.applyOptions({ color: c.draw });
    layer.update();
  }

  return {
    setTool, load, undo, clear, escape, recolor,
    get tool() { return tool; },
    flash(i0, i1, ms = 2400) {                    // highlight a range of bars, fading out
      const start = performance.now();
      const step = (now) => {
        const k = (now - start) / ms;
        layer.flash = k >= 1 ? null : { i0, i1, alpha: k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85 };
        layer.update();
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
  };
}
