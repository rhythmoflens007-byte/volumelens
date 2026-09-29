// Loading market data. index.json lists every stock and session; each session is its own file,
// so a stock opens fast (latest sessions first) and earlier history streams in behind it.

import { B } from './util.js?v=39';

const cache = new Map();

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export const loadIndex = () => getJSON('data/index.json');

function loadSession(symbol, date) {
  const key = `${symbol}/${date}`;
  if (!cache.has(key)) cache.set(key, getJSON(`data/${key}.json`).catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

/**
 * A stock's history as one continuous series. `sessions` are the loaded session files, oldest
 * first; bars, minutes and alerts are stitched for the chosen density.
 */
export class Series {
  constructor(symbol, meta) {
    this.symbol = symbol;
    this.meta = meta;                  // index.json entries for this stock, oldest first
    this.sessions = [];                // loaded session payloads, oldest first
  }

  get dates() { return this.meta.map((m) => m.date); }
  get loadedFrom() { return this.sessions.length ? this.sessions[0].date : null; }
  get complete() { return this.sessions.length === this.meta.length; }

  /** Load the latest `n` sessions. */
  async loadLatest(n = 10) {
    this.sessions = await Promise.all(this.dates.slice(-n).map((d) => loadSession(this.symbol, d)));
  }

  /** Make sure every session from `date` to the latest is loaded. Returns how many were added. */
  async ensureFrom(date) {
    let added = 0;
    while (this.loadedFrom && this.loadedFrom > date) added += await this.loadEarlier(20);
    return added;
  }

  /** Load up to `n` sessions before the earliest loaded one. Returns how many were added. */
  async loadEarlier(n = 10) {
    const dates = this.dates;
    const first = dates.indexOf(this.loadedFrom);
    if (first <= 0) return 0;
    const add = await Promise.all(dates.slice(Math.max(0, first - n), first).map((d) => loadSession(this.symbol, d)));
    this.sessions = [...add, ...this.sessions];
    return add.length;
  }

  /** Add or replace today's session from the live server. Returns true if it was a new session. */
  upsertLive(payload) {
    const last = this.sessions.at(-1);
    if (last && last.date > payload.date) return false;
    const fresh = !last || last.date !== payload.date;
    if (fresh) this.sessions.push(payload); else this.sessions[this.sessions.length - 1] = payload;
    const st = payload.live?.stats || {};
    let m = this.meta.find((x) => x.date === payload.date);
    if (!m) { m = { date: payload.date, alerts: 0, live: true }; this.meta.push(m); }
    if (m.live) Object.assign(m, { candles: payload.bars.standard.length, size: payload.size,
      urgency_score: st.urgency_score ?? 0, burst: st.burst });
    return fresh;
  }

  /** Continuous arrays for a density. */
  build(density) {
    const bars = [], minutes = [], alerts = [], starts = [];
    this.sessions.forEach((s, k) => {
      const base = bars.length;
      starts.push({ index: base, date: s.date, size: s.size[density] });
      for (const r of s.bars[density]) { const row = r.slice(); row[B.SESSION] = k; bars.push(row); }
      for (const m of s.minutes) minutes.push(m);
      if (density === 'standard') for (const a of s.alerts) alerts.push({ ...a, i: base + a.i, date: s.date });
    });
    return { bars, minutes, alerts, starts };
  }
}
