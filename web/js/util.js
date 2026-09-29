// Shared constants and small helpers.

// Column layout of a volume bar row, as written by run.py.
export const B = { T: 0, START: 1, O: 2, H: 3, L: 4, C: 5, FILL: 6, FILLS: 7, BASE: 8, PACE: 9, SPEED: 10, ZONE: 11, VPIN: 12, AAI: 13, AAIS: 14, PROB: 15 };
export const URGENT = 2;
export const WATCH = 1;

export const $ = (id) => document.getElementById(id);
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
export const inr = (v) => Number(v).toLocaleString('en-IN');

// Times are stored as IST shifted to look like UTC, so ISO slicing gives Indian wall-clock time.
export const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
export const hhmmss = (t) => new Date(t * 1000).toISOString().slice(11, 19);
export const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Shares in Indian units: 39,60,000 -> "39.6 L", 1,25,00,000 -> "1.25 Cr". */
export function shares(n) {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)} L`;
  return inr(n);
}

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage blocked: the app works without it */ }
  return null;
}
