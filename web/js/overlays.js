// Chart overlays drawn as Lightweight Charts series primitives: they are painted with the chart
// on every frame, so they cost nothing on hover and never force a data update.

import { B, dayLabel, hhmm, xAt } from './util.js?v=42';

class Primitive {
  constructor() { this._view = { renderer: () => ({ draw: (t) => this._draw(t) }), zOrder: () => this.z }; this.z = 'bottom'; }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this._view]; }
  update() { if (this.requestUpdate) this.requestUpdate(); }
}

/** Vertical line at each session open, labelled with the date and that session's urgency. */
export class SessionSeparators extends Primitive {
  constructor(colors, labels = true) { super(); this.colors = colors; this.labels = labels; this.starts = []; }
  set(starts) { this.starts = starts; this.update(); }       // [{index, date, score}]

  _draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = this.chart.timeScale(), c = this.colors();
      ctx.font = '500 10.5px "JetBrains Mono", monospace';
      let lastLabelX = -1e9;
      for (const s of this.starts) {
        if (s.index === 0) continue;
        const x = xAt(ts, s.index - 0.5);
        if (x == null || x < 0 || x > mediaSize.width) continue;
        ctx.strokeStyle = c.separator; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, mediaSize.height); ctx.stroke();
        ctx.setLineDash([]);
        if (!this.labels || x - lastLabelX < 120) continue;
        lastLabelX = x;
        const text = `${dayLabel(s.date)}`, pct = s.score != null ? ` ${Math.round(s.score)}%` : '';
        const w = ctx.measureText(text + pct).width + 12;
        ctx.fillStyle = c.chip; ctx.fillRect(x + 4, mediaSize.height - 22, w, 17);
        ctx.fillStyle = c.chipText; ctx.fillText(text, x + 10, mediaSize.height - 10);
        if (pct) { ctx.fillStyle = c.accent; ctx.fillText(pct, x + 10 + ctx.measureText(text).width, mediaSize.height - 10); }
      }
    });
  }
}

/** Compare chart: amber bands on candles that contain urgent volume, plus the hover band. */
export class CompareBands extends Primitive {
  constructor(colors) { super(); this.colors = colors; this.urgent = []; this.hover = null; }
  setUrgent(indices) { this.urgent = indices; this.update(); }      // candle indices
  setHover(range) { this.hover = range; this.update(); }            // {i0, i1} candle indices or null

  _draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = this.chart.timeScale(), c = this.colors();
      const band = (i0, i1, color) => {
        const x0 = xAt(ts, i0 - 0.5), x1 = xAt(ts, i1 + 0.5);
        if (x0 == null || x1 == null || x1 < 0 || x0 > mediaSize.width) return;
        ctx.fillStyle = color; ctx.fillRect(x0, 0, Math.max(1, x1 - x0), mediaSize.height);
      };
      for (const i of this.urgent) band(i, i, c.shade);
      if (this.hover) band(this.hover.i0, this.hover.i1, c.hover);
    });
  }
}

/**
 * The volume clock made visible. Time bands shade every other 15/30/60-minute stretch, so a quiet
 * half hour is a thin band and an urgent one a wide band full of candles; the pace ribbon is a heat
 * strip of the Urgency Index along the bottom; ×N marks a minute that alone filled N candles.
 */
export class ClockOverlay extends Primitive {
  constructor(colors) { super(); this.colors = colors; this.bars = []; this.n = 0; this.opt = {}; this.sizeOf = () => 0; this.heat = () => ''; }
  set(bars, n, opt, sizeOf, heat) { Object.assign(this, { bars, n, opt, sizeOf, heat }); this.update(); }

  _draw(target) {
    const { bands, bandMin, ribbon, badges } = this.opt;
    if (!this.n || !(bands || ribbon || badges)) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = this.chart.timeScale(), c = this.colors(), r = ts.getVisibleLogicalRange();
      if (!r) return;
      const b = this.bars, n = this.n, H = mediaSize.height;
      const i0 = Math.max(0, Math.floor(r.from)), i1 = Math.min(n - 1, Math.ceil(r.to));
      if (i1 < i0) return;
      const spacing = ts.options().barSpacing;
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      if (bands) {
        const L = bandMin * 60, slot = (k) => Math.floor(b[k][B.START] / L);
        let a = i0;
        while (a > 0 && slot(a - 1) === slot(i0)) a--;
        while (a <= i1) {
          const s = slot(a);
          let z = a;
          while (z + 1 < n && slot(z + 1) === s) z++;
          const x0 = xAt(ts, a - 0.5), x1 = xAt(ts, z + 0.5);
          if (x0 != null && x1 != null) {
            if (s % 2 === 0) { ctx.fillStyle = c.band; ctx.fillRect(x0, 0, x1 - x0, H); }
            const cnt = z - a + 1, w = x1 - x0;
            ctx.fillStyle = c.bandText;
            if (w > 74) ctx.fillText(`${hhmm(s * L)} · ${cnt}`, (x0 + x1) / 2, H - 10);
            else if (w > 18) ctx.fillText(String(cnt), (x0 + x1) / 2, H - 10);
          }
          a = z + 1;
        }
      }
      if (ribbon) {
        const w = Math.max(1, spacing);
        for (let k = i0; k <= i1; k++) {
          const x = xAt(ts, k);
          if (x == null) continue;
          ctx.fillStyle = this.heat(b[k][B.UIDX], true);
          ctx.fillRect(x - w / 2, H - 4, w, 4);
        }
      }
      if (badges && spacing >= 9) {
        ctx.fillStyle = c.text;
        for (let k = i0; k <= i1; k++) {
          const size = this.sizeOf(k), mult = size ? Math.round(b[k][B.VOL] / size) : 0;
          if (mult < 2) continue;
          const x = xAt(ts, k), y = this.series.priceToCoordinate(b[k][B.H]);
          if (x == null || y == null) continue;
          ctx.fillText(`×${mult}`, x, y - 6);
        }
      }
      ctx.textAlign = 'start';
    });
  }
}
