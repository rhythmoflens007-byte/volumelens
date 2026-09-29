// VolumeLens website: scroll reveals, the nav, and the hero animation.
// The hero uses real data (data/hero.json, RELIANCE 29 Sep 09:30–11:00): 5-minute candles first,
// then the same minutes as Volume Bricks, gliding from clock time to share time.

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- reveal on scroll, nav border
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }),
  { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
const nav = document.getElementById('nav');
const onScroll = () => nav?.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ---------- hero
const canvas = document.getElementById('hero-canvas');
if (canvas) hero(canvas);

async function hero(cv) {
  let d;
  try { d = await (await fetch('data/hero.json')).json(); } catch (e) { return; }
  const C = { up: '#177a5b', down: '#c23b3f', accent: '#b4410f', hot: '#8f2f06', grid: '#e6e0d3', text: '#6f6b61', bg: '#fbf9f4' };
  const ctx = cv.getContext('2d');
  const caption = document.getElementById('caption'), replay = document.getElementById('replay');
  const mTime = document.getElementById('m-time'), mVol = document.getElementById('m-vol');

  const { candles, bricks, t0, t1 } = d;
  const lo = Math.min(...candles.map((c) => c[3])), hi = Math.max(...candles.map((c) => c[2]));
  const urgent = bricks.filter((b) => b[5] === 2);
  const tf = 300;
  // 5-minute candles that contain urgent bricks: what the time chart shows of the burst
  const burstCandles = new Set();
  for (const b of urgent) for (const c of candles) if (b[0] < c[0] + tf && b[1] > c[0]) burstCandles.add(c[0]);
  document.getElementById('f-candles').textContent = burstCandles.size;
  document.getElementById('f-bricks').textContent = urgent.length;

  let W = 0, H = 0;
  const size = () => {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  addEventListener('resize', () => { size(); frame(last); });

  const pad = { l: 8, r: 58, t: 14, b: 26 };
  const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const Y = (p) => pad.t + ((hi - p) / (hi - lo)) * (H - pad.t - pad.b);
  const volX = (i) => pad.l + ((i + 0.5) / bricks.length) * (W - pad.l - pad.r);
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const mix = (a, b, f) => { const p = (h, i) => parseInt(h.slice(i, i + 2), 16); return `rgb(${[1, 3, 5].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * f)).join(',')})`; };
  const hhmm = (t) => `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;

  function axes() {
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.text; ctx.font = '500 10.5px "JetBrains Mono", monospace';
    const step = (hi - lo) / 4;
    for (let k = 0; k <= 4; k++) {
      const p = lo + step * k, y = Math.round(Y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r + 6, y); ctx.stroke();
      ctx.fillText(p.toFixed(0), W - pad.r + 12, y + 4);
    }
  }
  function timeLabels(alpha) {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha; ctx.fillStyle = C.text;
    for (let t = t0; t <= t1; t += 1800) ctx.fillText(hhmm(t), X(t) - 16, H - 8);
    ctx.globalAlpha = 1;
  }
  function drawCandles(alpha, glow) {
    if (alpha <= 0) return;
    const w = Math.max(3, (X(t0 + tf) - X(t0)) * 0.62);
    for (const [t, o, h, l, c] of candles) {
      const x = X(t + tf / 2), col = c >= o ? C.up : C.down;
      ctx.globalAlpha = alpha;
      if (glow > 0 && burstCandles.has(t)) {
        ctx.save(); ctx.globalAlpha = alpha * glow; ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        ctx.strokeRect(x - w / 2 - 5, Y(h) - 6, w + 10, Y(l) - Y(h) + 12); ctx.restore(); ctx.globalAlpha = alpha;
      }
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(h)); ctx.lineTo(Math.round(x) + 0.5, Y(l)); ctx.stroke();
      ctx.fillStyle = col; ctx.fillRect(x - w / 2, Math.min(Y(o), Y(c)), w, Math.max(2, Math.abs(Y(o) - Y(c))));
    }
    ctx.globalAlpha = 1;
  }
  function drawBricks(alpha, m, glow) {
    if (alpha <= 0) return;
    const slot = (W - pad.l - pad.r) / bricks.length;
    bricks.forEach(([s, e, o, c, u, sp], i) => {
      const tx = X((s + e) / 2), vx = volX(i), x = tx + (vx - tx) * m;
      const wt = Math.max(2, (X(e) - X(s)) * 0.8), wv = Math.max(3, slot * 0.72), w = wt + (wv - wt) * m;
      const up = c >= o, dir = up ? C.up : C.down;
      const f = u == null ? 0 : clamp((u - 30) / 30);
      const body = mix(C.bg, dir, 0.34 + 0.66 * f);
      const top = Y(Math.max(o, c)), h = Math.max(3, Math.abs(Y(o) - Y(c)));
      ctx.globalAlpha = alpha;
      if (sp === 2 && glow > 0) {
        ctx.save(); ctx.shadowColor = 'rgba(180,65,15,0.45)'; ctx.shadowBlur = 10 * glow; ctx.fillStyle = `rgba(180,65,15,${0.22 * glow})`;
        ctx.fillRect(x - w / 2, top - 1, w, h + 2); ctx.restore(); ctx.globalAlpha = alpha;
      }
      ctx.fillStyle = body;
      if (ctx.roundRect && w > 5) { ctx.beginPath(); ctx.roundRect(x - w / 2, top, w, h, 2); ctx.fill(); } else ctx.fillRect(x - w / 2, top, w, h);
      ctx.strokeStyle = sp === 2 ? C.accent : mix(C.bg, dir, 0.6); ctx.lineWidth = 1;
      if (w > 4) ctx.strokeRect(x - w / 2 + 0.5, top + 0.5, w - 1, h - 1);
    });
    ctx.globalAlpha = 1;
  }

  // timeline (ms)
  const T = { candlesIn: [0, 700], burst: [1100, 1700], bricksIn: [2600, 3300], morph: [3600, 5400], glow: [5400, 6200], end: 6400 };
  const CAP = [
    [0, `A normal 5-minute chart. <b>Looks calm.</b>`],
    [1100, `The 09:30 burst hides in <b>${burstCandles.size} ordinary candles</b>.`],
    [2600, `Now the same minutes, one brick every <b>${d.size.toLocaleString('en-IN')} shares</b>…`],
    [3600, `…laid out by shares traded, not by the clock.`],
    [5400, `<span class="hot"><b>${urgent.length} urgent bricks</b></span>. The burst was there all along.`],
  ];
  let start = 0, last = 0, raf = 0, capIdx = -1;
  const p = (t, [a, b]) => clamp((t - a) / (b - a));

  function frame(t) {
    last = t;
    ctx.clearRect(0, 0, W, H);
    axes();
    const cIn = p(t, T.candlesIn), bIn = p(t, T.bricksIn), m = ease(p(t, T.morph));
    drawCandles(cIn * (1 - 0.88 * bIn) * (1 - m), p(t, T.burst) * (1 - bIn));
    drawBricks(bIn, m, p(t, T.glow));
    timeLabels(1 - m);
    const k = CAP.findLastIndex(([at]) => t >= at);
    if (k !== capIdx) { capIdx = k; caption.innerHTML = CAP[k][1]; }
    mTime.classList.toggle('on', m < 0.5); mVol.classList.toggle('on', m >= 0.5);
  }
  function loop(now) {
    if (!start) start = now;
    const t = now - start;
    frame(Math.min(t, T.end));
    if (t < T.end) tick(loop); else replay.hidden = false;
  }
  function play() {
    cancelAnimationFrame(raf); start = 0; capIdx = -1; replay.hidden = true;
    if (reduced) { frame(T.end); replay.hidden = false; return; }
    tick(loop);
  }
  // animation frame, with a timer fallback for throttled or background tabs
  function tick(fn) {
    let done = false;
    raf = requestAnimationFrame((t) => { done = true; fn(t); });
    setTimeout(() => { if (!done) { cancelAnimationFrame(raf); fn(performance.now()); } }, 60);
  }
  replay.addEventListener('click', play);
  frame(0);
  const seen = new IntersectionObserver((es) => { if (es[0].isIntersecting) { seen.disconnect(); setTimeout(play, 350); } }, { threshold: 0.35 });
  seen.observe(cv);
}
