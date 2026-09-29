// Shared constants and small helpers.

// Column layout of a volume candle row, as written by run.py (+ SESSION added in the browser).
export const B = { T: 0, START: 1, O: 2, H: 3, L: 4, C: 5, VOL: 6, FILL: 7, FILLS: 8, BASE: 9, PACE: 10, UIDX: 11, SPEED: 12, VPIN: 13, AAIS: 14, SESSION: 15 };
export const URGENT = 2;
export const WATCH = 1;
export const URGENT_INDEX = 60;
export const WATCH_INDEX = 30;

export const $ = (id) => document.getElementById(id);
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
export const inr = (v) => Number(v).toLocaleString('en-IN');

// Times are IST shifted to look like UTC, so ISO slicing gives Indian wall-clock time.
export const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
export const hhmmss = (t) => new Date(t * 1000).toISOString().slice(11, 19);
export const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Shares in Indian units: 39,60,000 -> "39.6 L", 1,25,00,000 -> "1.25 Cr". */
export function shares(n) {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)} L`;
  return inr(Math.round(n));
}

/** Index of the last element with key(el) <= x in a sorted array (-1 if none). */
export function lastAtOrBefore(arr, x, key) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Urgency thresholds in use (chart settings can move them; the backtest uses the defaults). */
export const TH = { urgent: URGENT_INDEX, watch: WATCH_INDEX };
export const level = (u) => (u == null ? ['–', ''] : u >= TH.urgent ? ['Urgent', 'urgent'] : u >= TH.watch ? ['Watch', 'watch'] : ['Normal', '']);

/** Blend two #rrggbb colours, f in [0, 1]. */
export function mix(a, b, f) {
  const p = (h, i) => parseInt(h.slice(i, i + 2), 16);
  const c = [1, 3, 5].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * Math.max(0, Math.min(1, f))));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage blocked: the app works without it */ }
  return null;
}

/** Run fn at most once per animation frame, with the latest arguments. Browsers pause frames
 *  for hidden or off-screen pages, so a short timer backs the frame up. */
export function perFrame(fn) {
  let queued = false, args = null;
  const run = () => { if (!queued) return; queued = false; fn(...args); };
  return (...a) => {
    args = a;
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
    setTimeout(run, 50);
  };
}

/** x coordinate of a (possibly fractional) candle position. The chart's own logicalToCoordinate
 *  only handles whole positions, so fractions are interpolated between neighbours. */
export function xAt(timeScale, logical) {
  const a = Math.floor(logical), xa = timeScale.logicalToCoordinate(a);
  if (a === logical || xa == null) return xa;
  const xb = timeScale.logicalToCoordinate(a + 1);
  return xb == null ? xa : xa + (xb - xa) * (logical - a);
}
