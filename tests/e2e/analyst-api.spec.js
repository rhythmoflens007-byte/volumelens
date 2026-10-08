// The AI analyst server function (api/analyst.js), with Gemini stubbed: no network, no key needed.

const { test, expect } = require('@playwright/test');
const handler = require('../../api/analyst.js');

const realFetch = globalThis.fetch;
let calls;
/** Stub Gemini: each call takes the next [status, body] from `replies`. */
function stubGemini(...replies) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const [status, body] = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(body), { status });
  };
}
const ok = (text) => [200, { candidates: [{ content: { parts: [{ text }] } }] }];

async function call(body, { method = 'POST', key = 'test-key' } = {}) {
  if (key) process.env.GEMINI_API_KEY = key; else delete process.env.GEMINI_API_KEY;
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.json = JSON.parse(s); } };
  await handler({ method, body }, res);
  return res;
}
const context = { symbol: 'RELIANCE', view: { from: '2026-09-29 09:15', to: '2026-09-29 15:15', candles: 99 } };

test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.GEMINI_API_KEY; });

test('answers from the chart numbers, with the key in a header and a no-advice instruction', async () => {
  stubGemini(ok('- RELIANCE fell 0.9%'));
  const res = await call({ context, question: 'What happened?' });
  expect(res.statusCode).toBe(200);
  expect(res.json).toEqual({ text: '- RELIANCE fell 0.9%', model: 'gemini-3.5-flash' });
  expect(calls).toHaveLength(1);
  expect(calls[0].init.headers['x-goog-api-key']).toBe('test-key');
  expect(calls[0].url).not.toContain('test-key');                               // never in the URL
  expect(calls[0].body.systemInstruction.parts[0].text).toContain('Never recommend buying, selling or holding');
  const prompt = calls[0].body.contents[0].parts[0].text;
  expect(prompt).toContain(JSON.stringify(context));
  expect(prompt).toContain('Question: What happened?');
});

test('falls back to the lighter model when the main one is busy', async () => {
  stubGemini([503, { error: { message: 'high demand' } }], ok('- fallback reply'));
  const res = await call({ context });
  expect(res.statusCode).toBe(200);
  expect(res.json.model).toBe('gemini-flash-lite-latest');
  expect(calls.map((c) => c.url.match(/models\/([^:]+)/)[1])).toEqual(['gemini-3.5-flash', 'gemini-flash-lite-latest']);
});

test('does not retry a rejected request, and never leaks the upstream error', async () => {
  stubGemini([400, { error: { message: 'API key not valid: test-key' } }]);
  const res = await call({ context });
  expect(res.statusCode).toBe(502);
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(res.json)).not.toContain('test-key');
});

test('validates the method, the key and the input', async () => {
  stubGemini(ok('unused'));
  expect((await call({ context }, { method: 'GET' })).statusCode).toBe(405);
  expect((await call({ context }, { key: null })).statusCode).toBe(503);
  expect((await call({ question: 'no context' })).statusCode).toBe(400);
  expect((await call('not json')).statusCode).toBe(400);
  expect((await call({ context, question: 'x'.repeat(301) })).statusCode).toBe(400);
  expect((await call({ context: { blob: 'x'.repeat(20001) } })).statusCode).toBe(400);
  expect(calls).toHaveLength(0);
});
