// Local server: the static site in web/ plus /api/analyst, the same function Vercel runs.
// Reads secrets from .env (git-ignored).
//
//     node dev.js            # http://127.0.0.1:8777
//     PORT=9000 node dev.js

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT) || 8777;

for (const line of (fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const analyst = require('./api/analyst.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(WEB, path.normalize(rel));
  if (!file.startsWith(WEB)) { res.statusCode = 403; return res.end(); }
  if (!path.extname(file) && fs.existsSync(`${file}.html`)) file += '.html';      // clean URLs, as on Vercel
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(buf);
  });
}

http.createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname !== '/api/analyst') return serveStatic(req, res);
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 100000) req.destroy(); });
  req.on('end', () => { req.body = raw; analyst(req, res).catch((e) => { console.error(e); res.statusCode = 500; res.end(); }); });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`VolumeLens on http://127.0.0.1:${PORT}  (AI analyst ${process.env.GEMINI_API_KEY ? 'on' : 'off: set GEMINI_API_KEY in .env'})`);
});
