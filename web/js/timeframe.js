// Build time-based candles of any length from 1-minute candles.

export const TIMEFRAMES = [1, 3, 5, 15, 30];

/**
 * @param {Array} minutes  rows [t, open, high, low, close, volume], t = minute start
 * @param {number} tf      candle length in minutes
 * @param {number} until   only use minutes that have finished by this time (replay); Infinity = all
 * @returns {Array} rows [t, open, high, low, close, volume, complete]
 */
export function aggregate(minutes, tf, until = Infinity) {
  const span = tf * 60;
  const out = [];
  let cur = null;
  for (const [t, o, h, l, c, v] of minutes) {
    if (t + 60 > until) break;                       // this minute had not finished yet
    const key = Math.floor(t / span) * span;
    if (!cur || cur[0] !== key) {
      cur = [key, o, h, l, c, v, false];
      out.push(cur);
    } else {
      cur[2] = Math.max(cur[2], h);
      cur[3] = Math.min(cur[3], l);
      cur[4] = c;
      cur[5] += v;
    }
  }
  for (const k of out) k[6] = k[0] + span <= until || until === Infinity;
  return out;
}
