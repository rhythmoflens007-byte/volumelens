// AI analyst: turns the numbers behind the chart in view into a plain-English read.
// Runs on the server (a Vercel function, or dev.js locally) so the Gemini key never reaches a
// browser. The page sends only chart numbers; the reply describes them and never advises.

const MODELS = [
  { name: process.env.GEMINI_MODEL || 'gemini-3.5-flash', thinking: { thinkingLevel: 'minimal' } },
  { name: 'gemini-flash-lite-latest' },               // fallback when the main model is busy
];
const TIMEOUT_MS = 20000;
const MAX_CONTEXT = 20000;                            // characters of chart JSON
const MAX_QUESTION = 300;

const SYSTEM = `You are the VolumeLens analyst, built into a charting tool for NSE (India) stocks.
VolumeLens draws a new candle every time a fixed number of shares trade (volume candles), so busy
stretches print many candles. Its measures:
- Urgency Index 0-100: how much faster than normal the last 3 candles filled (60+ urgent, 30+ watch).
- Fill time: minutes a candle took to fill, against the normal time for that stock and time of day.
- VPIN 0-1: order-flow imbalance over the last 50 volume candles (higher = more one-sided flow).
- Net flow: (buy - sell) / volume over the last 10 candles; cumulative delta: running buy - sell
  shares, reset at each session open.
  Buy and sell volume are estimated from 1-minute price moves, not exchange tick data.
- Absorption: volume came in but price moved less than that volume normally moves it.
- Accumulation / distribution: net flow leans to buyers / sellers while absorption is high.
- Alerts: a model's "unusual flow" flags with its reasons.

Rules:
- Describe only what the JSON shows. Use its numbers and times; never invent data or news.
- This is an analytics tool. Never recommend buying, selling or holding, and never give price
  targets, stop losses or predictions of direction. Asked for those, say in one line that
  VolumeLens describes flow and does not advise, then describe the data instead.
- Times are IST. Write share counts in Indian units (lakh, crore) and prices in rupees.
- Reply in 3 to 5 short bullet points starting with "- ", then one line starting "Watch: " naming
  what to keep an eye on in the data (for example whether urgency returns), not a trade.
  At most 130 words. Plain text, with **bold** allowed for key numbers.`;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function ask(model, key, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024, ...(model.thinking ? { thinkingConfig: model.thinking } : {}) },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${r.status}`), { status: r.status });
  const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  if (!text) throw Object.assign(new Error('empty reply'), { status: 502 });
  return text;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return send(res, 503, { error: 'The AI analyst is not configured (GEMINI_API_KEY is missing).' });

  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { body = null; }
  const context = body && typeof body.context === 'object' ? body.context : null;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  const json = context ? JSON.stringify(context) : '';
  if (!context || json.length > MAX_CONTEXT) return send(res, 400, { error: 'Send the chart context as a JSON object.' });
  if (question.length > MAX_QUESTION) return send(res, 400, { error: `Keep questions under ${MAX_QUESTION} characters.` });

  const prompt = `Chart in view (JSON):\n${json}\n\n${question ? `Question: ${question}` : 'Explain what this chart shows.'}`;
  let last;
  for (const model of MODELS) {
    try {
      return send(res, 200, { text: await ask(model, key, prompt), model: model.name });
    } catch (e) {
      last = e;
      if (e.status && ![429, 500, 502, 503, 504].includes(e.status)) break;   // only retry when busy or down
    }
  }
  console.error('analyst:', last?.message);
  send(res, last?.status === 429 ? 429 : 502, { error: 'The AI analyst is busy right now. Try again in a moment.' });
};
