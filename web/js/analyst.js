// AI analyst panel: sends the numbers behind the chart in view to /api/analyst (Gemini, on the
// server) and shows the plain-English read. The reply is rendered as text, never as raw HTML.

import { $ } from './util.js?v=51';

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

/** Bullet lines ("- " or "* ") become a list; "Watch:" and other lines become paragraphs. */
function render(text) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    const watch = line.match(/^\**watch:?\**:?\s*(.*)$/i);
    out.push(watch ? `<p class="ai-watch"><b>Watch</b> ${inline(watch[1])}</p>` : `<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

export function initAnalyst(getContext) {
  const out = $('ai-out'), input = $('ai-question'), buttons = [$('ai-explain'), $('ai-ask-btn')];
  let pending = null;

  async function run(question = '') {
    const context = getContext();
    if (!context) return;
    pending?.abort();
    const ctrl = pending = new AbortController();
    buttons.forEach((b) => { b.disabled = true; });
    out.hidden = false;
    out.className = 'ai-out loading';
    out.innerHTML = `<p>Reading ${esc(context.symbol)}, ${esc(context.view.from)} to ${esc(context.view.to)}…</p>`;
    try {
      const r = await fetch('api/analyst', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, question }), signal: ctrl.signal });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.text) throw new Error(data.error || (r.status === 404 || r.status === 501
        ? 'The AI analyst needs its server: run "node dev.js" locally, or open the deployed site.'
        : `The AI analyst could not answer (${r.status}).`));
      out.className = 'ai-out';
      out.innerHTML = (question ? `<p class="ai-q">${esc(question)}</p>` : '') + render(data.text) +
        `<p class="ai-meta">${esc(data.model || 'Gemini')} · read of ${context.view.candles} candles · describes the data, not advice</p>`;
    } catch (e) {
      if (e.name === 'AbortError') return;
      out.className = 'ai-out error';
      out.innerHTML = `<p>${esc(e.message === 'Failed to fetch' ? 'The AI analyst is unreachable. Check the connection and try again.' : e.message)}</p>`;
    } finally {
      if (pending === ctrl) { pending = null; buttons.forEach((b) => { b.disabled = false; }); }
    }
  }

  $('ai-explain').addEventListener('click', () => run());
  $('ai-ask').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) run(q);
  });
}
